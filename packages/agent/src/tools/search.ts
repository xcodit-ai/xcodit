import { readdir, readFile, stat } from "node:fs/promises";
import { glob as fsGlob } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import type { Tool } from "../types.js";
import { resolveInside, truncate } from "../paths.js";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", "target", "__pycache__", ".venv", "venv", "coverage"]);
const MAX_MATCHES = 500;

const GlobArgs = z.object({
  pattern: z.string().describe("Glob like src/**/*.ts"),
  path: z.string().optional().describe("Directory to search in (default project root)"),
});

export const globTool: Tool<z.infer<typeof GlobArgs>> = {
  name: "glob",
  description: "Find files by glob pattern (e.g. \"**/*.test.ts\"). Skips node_modules, .git, dist. Returns paths relative to the project root.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob like src/**/*.ts" },
      path: { type: "string", description: "Directory to search in (default project root)" },
    },
    required: ["pattern"],
  },
  parse: (raw) => GlobArgs.parse(raw),
  risk: () => "read",
  summary: (a) => `glob ${a.pattern}${a.path ? ` in ${a.path}` : ""}`,
  async execute(a, ctx) {
    const base = a.path ? resolveInside(ctx.cwd, a.path) : ctx.cwd;
    const out: string[] = [];
    for await (const entry of fsGlob(a.pattern, {
      cwd: base,
      exclude: (name: string) => SKIP_DIRS.has(name),
    })) {
      out.push(relative(ctx.cwd, join(base, entry)).split(sep).join("/"));
      if (out.length >= 2000) { out.push("[... more results truncated]"); break; }
    }
    return { content: out.length ? out.sort().join("\n") : "No files matched." };
  },
};

const GrepArgs = z.object({
  pattern: z.string().describe("Regular expression"),
  path: z.string().optional().describe("File or directory to search (default project root)"),
  glob: z.string().optional().describe("Only files matching this glob, e.g. *.ts"),
  ignore_case: z.boolean().optional(),
  context: z.number().int().min(0).max(10).optional().describe("Lines of context around each match"),
});

export const grepTool: Tool<z.infer<typeof GrepArgs>> = {
  name: "grep",
  description: "Search file contents with a regex. Output is file:line:text. Use glob to restrict file types.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression" },
      path: { type: "string", description: "File or directory to search (default project root)" },
      glob: { type: "string", description: "Only files matching this glob, e.g. *.ts" },
      ignore_case: { type: "boolean" },
      context: { type: "integer", description: "Lines of context around each match (0-10)" },
    },
    required: ["pattern"],
  },
  parse: (raw) => GrepArgs.parse(raw),
  risk: () => "read",
  summary: (a) => `grep /${a.pattern}/${a.glob ? ` in ${a.glob}` : ""}${a.path ? ` under ${a.path}` : ""}`,
  async execute(a, ctx) {
    const base = a.path ? resolveInside(ctx.cwd, a.path) : ctx.cwd;
    const viaRg = await ripgrep(a, base, ctx.cwd);
    if (viaRg !== null) return { content: truncate(viaRg || "No matches.") };
    return { content: truncate((await jsGrep(a, base, ctx.cwd)) || "No matches.") };
  },
};

/** Uses ripgrep when installed (much faster); resolves null if unavailable. */
function ripgrep(a: z.infer<typeof GrepArgs>, base: string, cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const args = ["-n", "--no-heading", "--color=never", "--max-count", "200"];
    if (a.ignore_case) args.push("-i");
    if (a.context) args.push("-C", String(a.context));
    if (a.glob) args.push("--glob", a.glob);
    args.push("-e", a.pattern, base);
    let out = "";
    let child;
    try {
      child = spawn("rg", args, { cwd });
    } catch {
      return resolve(null);
    }
    child.on("error", () => resolve(null));
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => {
      if (code !== 0 && code !== 1) return resolve(null);
      resolve(out.split("\n").map((l) => l.replace(base + sep, "").replace(/\\/g, "/")).join("\n").trim());
    });
  });
}

function globToRegex(g: string): RegExp {
  const re = g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "(.*/)?").replace(/\*/g, "[^/]*").replace(/\?/g, ".");
  return new RegExp(`(^|/)${re}$`);
}

async function jsGrep(a: z.infer<typeof GrepArgs>, base: string, cwd: string): Promise<string> {
  const re = new RegExp(a.pattern, a.ignore_case ? "i" : "");
  const fileFilter = a.glob ? globToRegex(a.glob) : null;
  const lines: string[] = [];
  let matches = 0;

  async function visit(p: string) {
    if (matches >= MAX_MATCHES) return;
    const s = await stat(p).catch(() => null);
    if (!s) return;
    if (s.isDirectory()) {
      for (const name of await readdir(p).catch(() => [])) {
        if (SKIP_DIRS.has(name)) continue;
        await visit(join(p, name));
      }
      return;
    }
    if (s.size > 2_000_000) return;
    const rel = relative(cwd, p).split(sep).join("/");
    if (fileFilter && !fileFilter.test(rel)) return;
    const buf = await readFile(p).catch(() => null);
    if (!buf || buf.subarray(0, 512).includes(0)) return; // binary
    const text = buf.toString("utf8").split(/\r?\n/);
    for (let i = 0; i < text.length; i++) {
      if (!re.test(text[i]!)) continue;
      matches++;
      const c = a.context ?? 0;
      for (let j = Math.max(0, i - c); j <= Math.min(text.length - 1, i + c); j++) {
        lines.push(`${rel}:${j + 1}:${text[j]}`);
      }
      if (c) lines.push("--");
      if (matches >= MAX_MATCHES) { lines.push(`[... stopped after ${MAX_MATCHES} matches]`); return; }
    }
  }
  await visit(base);
  return lines.join("\n");
}
