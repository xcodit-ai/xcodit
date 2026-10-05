import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { Tool } from "../types.js";
import { displayPath, resolveInside } from "../paths.js";

const Change = z.object({
  path: z.string(),
  old_string: z.string().describe("Exact text to find; empty means create the file"),
  new_string: z.string().describe("Replacement text; empty means delete the matched text"),
  replace_all: z.boolean().optional(),
});

const Args = z.object({
  changes: z.array(Change).min(1).max(40),
});

type Change = z.infer<typeof Change>;

/**
 * Several edits in one call, checked before any of them are written. A rename
 * that touches six files should cost one round trip, not six — and it should
 * not leave three files changed if the fourth does not match.
 */
export const patchTool: Tool<z.infer<typeof Args>> = {
  name: "patch",
  description:
    "Apply several edits across one or more files in a single call. Every change is validated first: if any old_string is missing or ambiguous, nothing is written and you are told which one failed. Use this for renames and other changes that touch several places; use edit_file for a single change. An empty old_string creates the file.",
  parameters: {
    type: "object",
    properties: {
      changes: {
        type: "array",
        description: "The edits to apply, in order",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            old_string: { type: "string", description: "Exact text to find; empty creates the file" },
            new_string: { type: "string" },
            replace_all: { type: "boolean" },
          },
          required: ["path", "old_string", "new_string"],
        },
      },
    },
    required: ["changes"],
  },
  parse: (raw) => Args.parse(raw),
  risk: () => "mutate",
  summary: (a) => {
    const files = new Set(a.changes.map((c) => c.path));
    return `patch ${a.changes.length} change${a.changes.length > 1 ? "s" : ""} in ${files.size} file${files.size > 1 ? "s" : ""}`;
  },
  async execute(a, ctx) {
    // Read once, apply every change in memory, and only then write.
    const staged = new Map<string, { abs: string; text: string; created: boolean }>();
    const problems: string[] = [];
    const applied: string[] = [];

    for (const [i, c] of a.changes.entries()) {
      const abs = resolveInside(ctx.cwd, c.path);
      const shown = displayPath(ctx.cwd, abs);
      let file = staged.get(abs);
      if (!file) {
        const existing = await readFile(abs, "utf8").catch(() => null);
        if (existing === null && c.old_string !== "") {
          problems.push(`change ${i + 1}: ${shown} does not exist (use an empty old_string to create it)`);
          continue;
        }
        file = { abs, text: existing ?? "", created: existing === null };
        staged.set(abs, file);
      }

      if (c.old_string === "") {
        if (!file.created && file.text.trim()) {
          problems.push(`change ${i + 1}: ${shown} already exists; edit it instead of creating it`);
          continue;
        }
        file.text = c.new_string;
        applied.push(`created ${shown}`);
        continue;
      }

      const eol = file.text.includes("\r\n") ? "\r\n" : "\n";
      const oldS = c.old_string.replace(/\r?\n/g, eol);
      const newS = c.new_string.replace(/\r?\n/g, eol);
      const count = file.text.split(oldS).length - 1;
      if (count === 0) {
        problems.push(`change ${i + 1}: text not found in ${shown}`);
        continue;
      }
      if (count > 1 && !c.replace_all) {
        problems.push(`change ${i + 1}: text matches ${count} times in ${shown}; add context or set replace_all`);
        continue;
      }
      file.text = c.replace_all ? file.text.split(oldS).join(newS) : file.text.replace(oldS, () => newS);
      applied.push(`${shown}: ${count} replacement${count > 1 ? "s" : ""}`);
    }

    if (problems.length) {
      return { content: `Nothing was written. ${problems.length} of ${a.changes.length} changes could not be applied:\n${problems.join("\n")}`, isError: true };
    }

    for (const file of staged.values()) {
      await ctx.snapshotFile(file.abs);
      if (file.created) await mkdir(dirname(file.abs), { recursive: true });
      await writeFile(file.abs, file.text, "utf8");
    }
    return { content: `Applied ${a.changes.length} change${a.changes.length > 1 ? "s" : ""} across ${staged.size} file${staged.size > 1 ? "s" : ""}:\n${applied.join("\n")}` };
  },
};
