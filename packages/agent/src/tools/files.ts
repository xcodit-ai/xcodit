import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { Tool } from "../types.js";
import { displayPath, resolveInside, truncate } from "../paths.js";

const ReadArgs = z.object({
  path: z.string().describe("File path, relative to the project root"),
  offset: z.number().int().positive().optional().describe("1-based line to start from"),
  limit: z.number().int().positive().optional().describe("Max lines to return (default 2000)"),
});

export const readTool: Tool<z.infer<typeof ReadArgs>> = {
  name: "read_file",
  description:
    "Read a text file. Returns numbered lines. Use offset/limit for large files. Always read a file before editing it.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the project root" },
      offset: { type: "integer", description: "1-based line to start from" },
      limit: { type: "integer", description: "Max lines to return (default 2000)" },
    },
    required: ["path"],
  },
  parse: (raw) => ReadArgs.parse(raw),
  risk: () => "read",
  summary: (a) => `read ${a.path}${a.offset ? ` from line ${a.offset}` : ""}`,
  async execute(a, ctx) {
    const abs = resolveInside(ctx.cwd, a.path);
    const s = await stat(abs).catch(() => null);
    if (!s) return { content: `File not found: ${a.path}`, isError: true };
    if (s.isDirectory()) return { content: `${a.path} is a directory; use glob or bash ls`, isError: true };
    if (s.size > 5_000_000) return { content: `File too large (${s.size} bytes)`, isError: true };
    const text = await readFile(abs, "utf8");
    const lines = text.split(/\r?\n/);
    const start = (a.offset ?? 1) - 1;
    const limit = a.limit ?? 2000;
    const slice = lines.slice(start, start + limit);
    const width = String(start + slice.length).length;
    const body = slice.map((l, i) => `${String(start + i + 1).padStart(width)}\t${l}`).join("\n");
    const more = start + slice.length < lines.length ? `\n[... ${lines.length - start - slice.length} more lines; use offset=${start + slice.length + 1}]` : "";
    return { content: truncate(body + more) };
  },
};

const WriteArgs = z.object({
  path: z.string(),
  content: z.string(),
});

export const writeTool: Tool<z.infer<typeof WriteArgs>> = {
  name: "write_file",
  description: "Create or overwrite a file with the given content. Creates parent directories. Prefer edit_file for changes to existing files.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the project root" },
      content: { type: "string", description: "Full file content" },
    },
    required: ["path", "content"],
  },
  parse: (raw) => WriteArgs.parse(raw),
  risk: () => "mutate",
  summary: (a) => `write ${a.path} (${a.content.length} chars)`,
  async execute(a, ctx) {
    const abs = resolveInside(ctx.cwd, a.path);
    await ctx.snapshotFile(abs);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, a.content, "utf8");
    return { content: `Wrote ${displayPath(ctx.cwd, abs)} (${a.content.split("\n").length} lines)` };
  },
};

const EditArgs = z.object({
  path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
});

export const editTool: Tool<z.infer<typeof EditArgs>> = {
  name: "edit_file",
  description:
    "Replace an exact string in a file. old_string must match exactly once (include enough surrounding lines to be unique) unless replace_all is true. Read the file first.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_string: { type: "string", description: "Exact text to find" },
      new_string: { type: "string", description: "Replacement text" },
      replace_all: { type: "boolean", description: "Replace every occurrence" },
    },
    required: ["path", "old_string", "new_string"],
  },
  parse: (raw) => EditArgs.parse(raw),
  risk: () => "mutate",
  summary: (a) => `edit ${a.path} (${a.old_string.split("\n").length} → ${a.new_string.split("\n").length} lines)`,
  async execute(a, ctx) {
    const abs = resolveInside(ctx.cwd, a.path);
    const text = await readFile(abs, "utf8").catch(() => null);
    if (text === null) return { content: `File not found: ${a.path}`, isError: true };
    if (a.old_string === a.new_string) return { content: "old_string and new_string are identical", isError: true };

    // Tolerate CRLF files when the model sends LF.
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const oldS = a.old_string.replace(/\r?\n/g, eol);
    const newS = a.new_string.replace(/\r?\n/g, eol);

    const count = text.split(oldS).length - 1;
    if (count === 0) return { content: `old_string not found in ${a.path}. Read the file and copy the exact text.`, isError: true };
    if (count > 1 && !a.replace_all) {
      return { content: `old_string matches ${count} times in ${a.path}; add more context or set replace_all`, isError: true };
    }
    await ctx.snapshotFile(abs);
    const updated = a.replace_all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS);
    await writeFile(abs, updated, "utf8");
    return { content: `Edited ${displayPath(ctx.cwd, abs)}: ${count} replacement${count > 1 ? "s" : ""}` };
  },
};
