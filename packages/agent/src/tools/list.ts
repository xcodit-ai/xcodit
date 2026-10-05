import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { z } from "zod";
import type { Tool } from "../types.js";
import { resolveInside, truncate } from "../paths.js";

const SKIP = new Set([".git", "node_modules", "dist", "build", ".next", "target", "__pycache__", ".venv", "venv", "coverage", ".turbo", ".cache"]);

const Args = z.object({
  path: z.string().optional().describe("Directory to list (default: project root)"),
  depth: z.number().int().min(1).max(5).optional().describe("How many levels to descend (default 2)"),
  all: z.boolean().optional().describe("Include dotfiles and ignored directories"),
});

interface Entry {
  name: string;
  dir: boolean;
  size: number;
  children?: Entry[];
  truncated?: number;
}

const MAX_PER_DIR = 60;

async function walk(dir: string, depth: number, all: boolean): Promise<Entry[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const visible = names.filter((n) => all || (!n.startsWith(".") && !SKIP.has(n))).sort();
  const shown = visible.slice(0, MAX_PER_DIR);
  const out: Entry[] = [];
  for (const name of shown) {
    const s = await stat(join(dir, name)).catch(() => null);
    if (!s) continue;
    const entry: Entry = { name, dir: s.isDirectory(), size: s.size };
    if (entry.dir && depth > 1) entry.children = await walk(join(dir, name), depth - 1, all);
    out.push(entry);
  }
  if (visible.length > shown.length) out.push({ name: `… ${visible.length - shown.length} more`, dir: false, size: -1 });
  return out;
}

const human = (n: number): string =>
  n < 1024 ? `${n}B` : n < 1024 * 1024 ? `${Math.round(n / 1024)}K` : `${(n / 1024 / 1024).toFixed(1)}M`;

function render(entries: Entry[], indent = ""): string[] {
  const lines: string[] = [];
  for (const e of entries) {
    if (e.size < 0) { lines.push(indent + e.name); continue; }
    lines.push(`${indent}${e.name}${e.dir ? "/" : ""}${e.dir ? "" : `  ${human(e.size)}`}`);
    if (e.children?.length) lines.push(...render(e.children, indent + "  "));
  }
  return lines;
}

/** A directory tree. Cheaper than a glob when the question is "what is here?". */
export const listTool: Tool<z.infer<typeof Args>> = {
  name: "list",
  description:
    "List a directory as a tree. Use this to orient yourself in an unfamiliar area of the project; use glob when you already know the pattern you want. Skips node_modules, .git, dist and other build output unless all=true.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory to list (default: project root)" },
      depth: { type: "integer", description: "Levels to descend, 1-5 (default 2)" },
      all: { type: "boolean", description: "Include dotfiles and ignored directories" },
    },
  },
  parse: (raw) => Args.parse(raw),
  risk: () => "read",
  summary: (a) => `list ${a.path ?? "."}${a.depth ? ` depth ${a.depth}` : ""}`,
  async execute(a, ctx) {
    const base = a.path ? resolveInside(ctx.cwd, a.path) : ctx.cwd;
    const s = await stat(base).catch(() => null);
    if (!s) return { content: `No such directory: ${a.path ?? "."}`, isError: true };
    if (!s.isDirectory()) return { content: `${a.path} is a file, not a directory`, isError: true };
    const tree = await walk(base, a.depth ?? 2, a.all ?? false);
    if (!tree.length) return { content: "(empty)" };
    const header = relative(ctx.cwd, base).split(sep).join("/") || ".";
    return { content: truncate([`${header}/`, ...render(tree, "  ")].join("\n")) };
  },
};
