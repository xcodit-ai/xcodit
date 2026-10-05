import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MODEL_FAMILY, ROLES, SPECIALISTS } from "@xcodit/shared";

const exec = promisify(execFile);

export const VERSION: string = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  // tsx: src/tui -> src -> root; tsc: dist/tui -> dist -> root; bundled: dist -> root
  for (const rel of ["../..", "..", "."]) {
    try {
      const pkg = JSON.parse(readFileSync(join(here, rel, "package.json"), "utf8")) as {
        name?: string;
        version?: string;
      };
      if (pkg.version && (pkg.name === "xcodit-ai" || pkg.name === "@xcodit/cli")) return pkg.version;
    } catch { /* keep walking */ }
  }
  return "0.0.0";
})();

/** One is picked per launch. Keep them short, dry and true. */
const TAGLINES = [
  "five specialists, one diff",
  "it plans before it types",
  "the reviewer never wrote the code",
  "your tests are the gate",
  "reads before it edits",
  "small diffs, loud receipts",
  "no sandbox, no upload, no drama",
  "cheap where it can be, careful where it counts",
  "ships the change, shows the bill",
  "measure twice, patch once",
];

export function tagline(seed = Date.now()): string {
  return TAGLINES[Math.floor(seed / 1000) % TAGLINES.length]!;
}

export interface BannerFacts {
  cwd: string;
  branch: string | null;
  dirty: boolean;
  tools: number;
  connected: boolean;
  tagline: string;
  theme: string;
  contextBudget: number;
  /** Project checks discovered for the verify step. */
  checks: number;
}

export async function gatherFacts(
  cwd: string,
  tools: number,
  connected: boolean,
  extra: { theme?: string; contextBudget?: number; checks?: number } = {},
): Promise<BannerFacts> {
  let branch: string | null = null;
  let dirty = false;
  try {
    const [b, s] = await Promise.all([
      exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd }),
      exec("git", ["status", "--porcelain"], { cwd }),
    ]);
    branch = b.stdout.trim() || null;
    dirty = s.stdout.trim().length > 0;
  } catch {
    /* not a repo */
  }
  return {
    cwd, branch, dirty, tools, connected, tagline: tagline(),
    theme: extra.theme ?? "signal-dark",
    contextBudget: extra.contextBudget ?? 160_000,
    checks: extra.checks ?? 0,
  };
}

/** Compact home path: /Users/me/src/app -> ~/src/app */
export function prettyCwd(cwd: string, home: string, max = 44): string {
  let s = cwd.replace(/\\/g, "/");
  const h = home.replace(/\\/g, "/");
  if (s.toLowerCase().startsWith(h.toLowerCase())) s = "~" + s.slice(h.length);
  return s.length <= max ? s : "…" + s.slice(-(max - 1));
}

export const WORDMARK = "xcodit";
/** The wordmark minus its accent-colored first letter. */
export const WORDMARK_TEXT = "codit";
/** The lineup, for the boot screen. */
export const SPECIALIST_LINE = ROLES.map((r) => SPECIALISTS[r].model.replace(/^relay-/, "")).join(" ");
export const FAMILY = MODEL_FAMILY.toLowerCase();
