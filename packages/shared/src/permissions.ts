import { z } from "zod";

/**
 * Permission policy.
 *
 * The decision belongs to the server: a client that decides for itself can be
 * edited, and a policy that ships with the client cannot be corrected without a
 * release. The client asks, renders what comes back, and enforces the answer.
 */

export const RISKS = ["read", "mutate", "dangerous"] as const;
export type Risk = (typeof RISKS)[number];

/** allow: run it. ask: put it to the user. deny: refuse, with no prompt. */
export const DECISIONS = ["allow", "ask", "deny"] as const;
export type Decision = (typeof DECISIONS)[number];

export const PERMISSION_MODES = ["ask", "auto-edit", "full-auto"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

// ---- the wire ---------------------------------------------------------------

export const PermissionCheckSchema = z.object({
  tool: z.string().min(1),
  mode: z.enum(PERMISSION_MODES),
  /** The command line, for tools that run one. */
  command: z.string().max(8000).optional(),
  /** The file a tool would touch, relative to the project. */
  path: z.string().max(1024).optional(),
  session_id: z.string().max(128).optional(),
});
export type PermissionCheck = z.infer<typeof PermissionCheckSchema>;

export const PermissionVerdictSchema = z.object({
  decision: z.enum(DECISIONS),
  risk: z.enum(RISKS),
  /** Shown to the user when asking, and returned to the model when denying. */
  reason: z.string().optional(),
  /** Whether "always allow this tool" may be offered for this call. */
  allowRemember: z.boolean(),
  /** Which policy version decided, so a support question has an answer. */
  policy: z.number().int().optional(),
});
export type PermissionVerdict = z.infer<typeof PermissionVerdictSchema>;

// ---- the policy itself ------------------------------------------------------

export interface PermissionPolicy {
  /** Commands matching any of these are dangerous however they are invoked. */
  dangerous: string[];
  /** A command is read-only when every segment matches this. */
  readOnly: string;
  /**
   * Patterns that disqualify a segment from read-only even though it starts
   * with a read-only command: `find … -delete`, `sed -i`, `sort -o`. Optional,
   * so a policy stored before this existed still gets the defaults.
   */
  readOnlyVeto?: string[];
  /** Refused outright, whatever the mode and whatever the user says. */
  forbidden: string[];
  /** decision for mode -> risk. */
  matrix: Record<PermissionMode, Record<Risk, Decision>>;
  /** Tools that never need asking, whatever they claim. */
  alwaysAllowTools: string[];
  /** Tools that always ask, even in full-auto. */
  alwaysAskTools: string[];
}

/**
 * Bumped whenever DEFAULT_PERMISSION_POLICY changes. A database still holding
 * an older revision is upgraded on start, so a rule corrected here reaches the
 * deployments running it instead of only new installations.
 */
export const DEFAULT_POLICY_REVISION = 2;

export const DEFAULT_PERMISSION_POLICY: PermissionPolicy = {
  dangerous: [
    String.raw`\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b`,
    String.raw`\brm\s+-rf?\s+[\/~]`,
    String.raw`\bgit\s+push\b.*(--force|-f\b)`,
    String.raw`\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s+\.)`,
    String.raw`\bgit\s+branch\s+-D\b`,
    String.raw`\b(mkfs|dd\s+if=|shutdown|reboot|format\s+[a-z]:)`,
    String.raw`\b(curl|wget)\b.*\|\s*(ba)?sh\b`,
    String.raw`\bsudo\b`,
    String.raw`\bDROP\s+(TABLE|DATABASE)\b`,
    String.raw`\bRemove-Item\b.*-Recurse`,
    String.raw`\bnpm\s+publish\b`,
    String.raw`\b(kubectl|docker)\s+.*\b(delete|rm|prune)\b`,
  ],
  readOnly:
    String.raw`^(cd|ls|dir|cat|head|tail|wc|pwd|echo|printf|find|grep|egrep|fgrep|rg|ag|which|type|file|stat|du|df|tree|env|printenv|uname|hostname|whoami|date|basename|dirname|realpath|readlink|cut|tr|nl|column|sort|uniq|jq|yq|diff|cmp|md5sum|sha1sum|sha256sum|sed -n|node -v|node --version|npm -v|pnpm -v|python --version|git (status|diff|log|show|branch|remote|rev-parse|ls-files|ls-tree|cat-file|blame|describe|shortlog|tag -l|config --get|stash list)|pnpm (ls|list|why|outdated)|npm (ls|list|view))\b`,
  // Flags that make an otherwise read-only command write.
  readOnlyVeto: [
    String.raw`\bfind\b[^|;&]*\s-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b`,
    String.raw`\bsed\b[^|;&]*\s-i\b`,
    String.raw`\b(sort|tree|jq|yq)\b[^|;&]*\s-o\b`,
    String.raw`\buniq\b(\s+-\S+)*\s+\S+\s+\S+`,
  ],
  forbidden: [],
  matrix: {
    ask: { read: "allow", mutate: "ask", dangerous: "ask" },
    "auto-edit": { read: "allow", mutate: "ask", dangerous: "ask" },
    "full-auto": { read: "allow", mutate: "allow", dangerous: "ask" },
  },
  alwaysAllowTools: ["read_file", "grep", "glob", "list", "diagnostics", "skill", "todo_write", "ask_user", "delegate"],
  alwaysAskTools: [],
};

// ---- evaluation -------------------------------------------------------------

const compile = (sources: string[]): RegExp[] =>
  sources.flatMap((s) => {
    try {
      return [new RegExp(s, "i")];
    } catch {
      return []; // a bad pattern must not take the whole policy down
    }
  });

/** One command within a line, and whether it redirects into a file. */
export interface CommandSegment {
  text: string;
  writesToFile: boolean;
}

/** Reads a `$(` … `)` or backtick body, minding nesting. */
function readSubstitution(src: string, from: number, close: string): { inner: string; end: number } {
  let depth = 1;
  let i = from;
  for (; i < src.length; i++) {
    if (src[i] === "\\") { i++; continue; }
    if (close === ")" && src[i] === "(") depth++;
    if (src[i] === close && --depth === 0) break;
  }
  return { inner: src.slice(from, i), end: Math.min(i, src.length - 1) };
}

/**
 * Split a command line into the commands it actually runs.
 *
 * Operators separate commands only when they are unquoted. A `grep -E "a|b"`
 * is one command, not three — splitting on the `|` inside the pattern used to
 * leave fragments like `b"` that match nothing read-only, so ordinary searches
 * were refused in the read-only modes.
 *
 * Command substitutions are pulled out and scanned in their own right, so a
 * mutating command cannot ride along inside a read-only `echo`.
 */
export function splitCommand(command: string): CommandSegment[] {
  const out: CommandSegment[] = [];
  let text = "";
  let writesToFile = false;
  const push = () => {
    if (text.trim()) out.push({ text: text.trim(), writesToFile });
    text = "";
    writesToFile = false;
  };
  /** Swallows a redirect target so it is not mistaken for a command. */
  const skipTarget = (src: string, from: number) => {
    let i = from;
    while (i < src.length && /\s/.test(src[i]!)) i++;
    const start = i;
    if (src[i] === "&") i++; // `2>&1`, `>&2`
    while (i < src.length && !/[\s|&;<>]/.test(src[i]!)) i++;
    return { target: src.slice(start, i), end: i - 1 };
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;

    if (ch === "\\") { text += ch + (command[i + 1] ?? ""); i++; continue; }

    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      const stop = end === -1 ? command.length - 1 : end;
      text += command.slice(i, stop + 1);
      i = stop;
      continue;
    }

    if (ch === '"') {
      // Double quotes still expand `$( )`, so that has to be looked inside.
      let j = i + 1;
      text += '"';
      for (; j < command.length && command[j] !== '"'; j++) {
        if (command[j] === "\\") { text += command[j]! + (command[j + 1] ?? ""); j++; continue; }
        if (command[j] === "$" && command[j + 1] === "(") {
          const { inner, end } = readSubstitution(command, j + 2, ")");
          out.push(...splitCommand(inner));
          j = end;
          continue;
        }
        text += command[j];
      }
      text += '"';
      i = j;
      continue;
    }

    if (ch === "$" && command[i + 1] === "(") {
      const { inner, end } = readSubstitution(command, i + 2, ")");
      out.push(...splitCommand(inner));
      i = end;
      continue;
    }

    if (ch === "`") {
      const end = command.indexOf("`", i + 1);
      const stop = end === -1 ? command.length - 1 : end;
      out.push(...splitCommand(command.slice(i + 1, stop)));
      i = stop;
      continue;
    }

    if (ch === "|" || ch === "&" || ch === ";" || ch === "\n") {
      if (ch === "&" && command[i + 1] === ">") continue; // `&>file` redirects, it does not separate
      if ((ch === "|" || ch === "&") && command[i + 1] === ch) i++;
      push();
      continue;
    }

    if (ch === ">") {
      if (command[i + 1] === ">") i++;
      const { target, end } = skipTarget(command, i + 1);
      // `>&1`, `>&2` and the null device leave nothing behind.
      if (!/^(&\d|\/dev\/(null|stdout|stderr))$/.test(target)) writesToFile = true;
      i = end;
      continue;
    }

    if (ch === "<") { const { end } = skipTarget(command, i + 1); i = end; continue; }

    text += ch;
  }
  push();
  return out;
}

/**
 * Sort a command line into a risk. Dangerous wins over everything; read-only
 * requires every command on the line to be read-only and nothing redirected
 * into a file.
 *
 * The dangerous patterns are matched against the whole line, quotes and all: a
 * false alarm only costs a confirmation, while `sh -c "rm -rf /"` slipping past
 * costs the user their work.
 */
export function classifyCommand(command: string, policy: PermissionPolicy = DEFAULT_PERMISSION_POLICY): Risk {
  const c = command.trim();
  if (compile(policy.dangerous).some((re) => re.test(c))) return "dangerous";
  const readOnly = compile([policy.readOnly])[0];
  if (!readOnly) return "mutate";
  const veto = compile(policy.readOnlyVeto ?? DEFAULT_PERMISSION_POLICY.readOnlyVeto ?? []);
  const parts = splitCommand(c);
  const harmless = (p: CommandSegment) =>
    !p.writesToFile && readOnly.test(p.text) && !veto.some((re) => re.test(p.text));
  if (parts.length && parts.every(harmless)) return "read";
  return "mutate";
}

/** Tools that change the machine, and therefore start at `mutate`. */
const MUTATING_TOOLS = new Set(["edit_file", "write_file", "patch", "bash", "web_fetch", "web_search"]);

export function riskOf(check: PermissionCheck, policy: PermissionPolicy = DEFAULT_PERMISSION_POLICY): Risk {
  if (check.command !== undefined) return classifyCommand(check.command, policy);
  if (policy.alwaysAllowTools.includes(check.tool)) return "read";
  return MUTATING_TOOLS.has(check.tool) ? "mutate" : "mutate";
}

export function evaluatePermission(
  check: PermissionCheck,
  policy: PermissionPolicy = DEFAULT_PERMISSION_POLICY,
): Omit<PermissionVerdict, "policy"> {
  const forbidden = compile(policy.forbidden);
  const subject = check.command ?? check.path ?? check.tool;
  if (forbidden.some((re) => re.test(subject))) {
    return { decision: "deny", risk: "dangerous", reason: "This action is not permitted on your plan.", allowRemember: false };
  }

  const risk = riskOf(check, policy);

  if (policy.alwaysAskTools.includes(check.tool)) {
    return { decision: "ask", risk, reason: `${check.tool} always asks`, allowRemember: false };
  }
  if (risk !== "dangerous" && policy.alwaysAllowTools.includes(check.tool)) {
    return { decision: "allow", risk, allowRemember: false };
  }

  // Editing is recoverable and shell side effects are not, so auto-edit lets
  // file tools through while still stopping at a command.
  if (check.mode === "auto-edit" && risk === "mutate" && check.tool !== "bash") {
    return { decision: "allow", risk, allowRemember: false };
  }

  const decision = policy.matrix[check.mode]?.[risk] ?? "ask";
  const reason =
    risk === "dangerous" ? "This command can destroy work that cannot be recovered."
    : decision === "ask" ? undefined
    : undefined;
  return { decision, risk, reason, allowRemember: decision === "ask" && risk !== "dangerous" };
}
