import { z } from "zod";
import type { Tool } from "../types.js";
import { bashTool } from "./bash.js";
import { discoverChecks } from "../verify.js";
import { truncate } from "../paths.js";

const Args = z.object({
  path: z.string().optional().describe("Only report problems in this file or directory"),
});

export interface Diagnostic {
  file: string;
  line?: number;
  col?: number;
  severity: "error" | "warning";
  code?: string;
  message: string;
}

/** Compiler and linter output, in the handful of shapes they actually use. */
export function parseDiagnostics(text: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  const add = (d: Diagnostic) => {
    const key = `${d.file}:${d.line}:${d.col}:${d.message}`;
    if (!seen.has(key)) { seen.add(key); out.push(d); }
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    // tsc: src/a.ts(12,5): error TS2339: Message
    let m = line.match(/^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+([A-Z]+\d+):\s*(.*)$/i);
    if (m) {
      add({ file: m[1]!, line: Number(m[2]), col: Number(m[3]), severity: m[4]!.toLowerCase() as "error", code: m[5], message: m[6]! });
      continue;
    }
    // gcc / eslint-compact / rust: path:12:5: error: Message
    m = line.match(/^(.+?):(\d+):(\d+):\s*(error|warning)(?:\[([^\]]+)\])?:\s*(.*)$/i);
    if (m) {
      add({ file: m[1]!, line: Number(m[2]), col: Number(m[3]), severity: m[4]!.toLowerCase() as "error", code: m[5], message: m[6]! });
      continue;
    }
    // python: File "path", line 12
    m = line.match(/^File "(.+?)", line (\d+)/);
    if (m) {
      add({ file: m[1]!, line: Number(m[2]), severity: "error", message: "see traceback" });
      continue;
    }
    // go vet: path:12:5: message
    m = line.match(/^(.+?\.go):(\d+):(\d+):\s*(.*)$/);
    if (m) add({ file: m[1]!, line: Number(m[2]), col: Number(m[3]), severity: "error", message: m[4]! });
  }
  return out;
}

const fmt = (d: Diagnostic): string =>
  `${d.file}${d.line ? `:${d.line}` : ""}${d.col ? `:${d.col}` : ""}  ${d.severity}${d.code ? ` ${d.code}` : ""}  ${d.message}`;

/**
 * What a language server is actually asked for, without running one: real
 * diagnostics from the project's own compiler and linter. The commands come
 * from the same discovery the verify step uses, so they match the project.
 */
export const diagnosticsTool: Tool<z.infer<typeof Args>> = {
  name: "diagnostics",
  description:
    "Run the project's typechecker and linter and return the problems they report, as file:line: message. Use it after editing to see what broke, or before editing to see what is already broken. Reports the whole project; pass a path to filter.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Only report problems under this file or directory" } },
  },
  parse: (raw) => Args.parse(raw),
  risk: () => "read",
  summary: (a) => `diagnostics${a.path ? ` ${a.path}` : ""}`,
  async execute(a, ctx) {
    const all = await discoverChecks(ctx.cwd);
    // Tests prove behaviour; diagnostics are about the compiler and the linter.
    const checks = all.filter((c) => !/\btest\b/.test(c));
    if (!checks.length) return { content: "This project has no typecheck or lint command to run." };

    const found: Diagnostic[] = [];
    const ran: string[] = [];
    for (const command of checks) {
      const r = await bashTool.execute({ command, timeout_ms: 180_000 }, ctx);
      ran.push(command);
      if (r.isError || r.content.trim()) found.push(...parseDiagnostics(r.content));
    }

    const filtered = a.path
      ? found.filter((d) => d.file.replace(/\\/g, "/").includes(a.path!.replace(/\\/g, "/")))
      : found;

    if (!filtered.length) {
      return { content: `No problems reported by: ${ran.join(", ")}` };
    }
    const errors = filtered.filter((d) => d.severity === "error").length;
    const header = `${filtered.length} problem${filtered.length > 1 ? "s" : ""} (${errors} error${errors === 1 ? "" : "s"}) from ${ran.join(", ")}`;
    return { content: truncate([header, "", ...filtered.slice(0, 100).map(fmt)].join("\n")), isError: errors > 0 };
  },
};
