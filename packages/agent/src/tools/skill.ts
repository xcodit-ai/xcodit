import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Tool } from "../types.js";
import { truncate } from "../paths.js";

const Args = z.object({ name: z.string().optional().describe("Omit to list what is available") });

const DIRS = [".xcodit/skills", ".claude/skills", ".agent/skills"];

export interface Skill {
  name: string;
  description: string;
  path: string;
}

/** `name: value` lines between --- fences, the convention SKILL.md files use. */
function frontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: m[2]! };
}

/** Every SKILL.md the project offers, from the directories we know about. */
export async function discoverSkills(cwd: string): Promise<Skill[]> {
  const found: Skill[] = [];
  for (const dir of DIRS) {
    const base = join(cwd, dir);
    const entries = await readdir(base).catch(() => [] as string[]);
    for (const entry of entries) {
      // Either skills/<name>/SKILL.md or skills/<name>.md
      const candidates = [join(base, entry, "SKILL.md"), join(base, entry)];
      for (const path of candidates) {
        const s = await stat(path).catch(() => null);
        if (!s?.isFile() || !path.endsWith(".md")) continue;
        const raw = await readFile(path, "utf8").catch(() => null);
        if (raw === null) continue;
        const { meta } = frontmatter(raw);
        const name = (meta.name ?? entry.replace(/\.md$/, "")).trim();
        if (found.some((f) => f.name === name)) break;
        found.push({ name, description: meta.description ?? "", path });
        break;
      }
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Skills are instructions the project keeps for jobs it does often. Loading one
 * on demand keeps its text out of the prompt until it is actually wanted.
 */
export const skillTool: Tool<z.infer<typeof Args>> = {
  name: "skill",
  description:
    "Load a skill: a set of instructions this project keeps for a recurring job. Call it with no arguments to see what exists, then by name to read one. Follow the instructions it returns as if they were part of your own.",
  parameters: {
    type: "object",
    properties: { name: { type: "string", description: "Skill to load; omit to list them" } },
  },
  parse: (raw) => Args.parse(raw),
  risk: () => "read",
  summary: (a) => (a.name ? `skill ${a.name}` : "list skills"),
  async execute(a, ctx) {
    const skills = await discoverSkills(ctx.cwd);
    if (!skills.length) {
      return { content: `This project has no skills. They live in ${DIRS.join(" or ")}, one SKILL.md each.` };
    }
    if (!a.name) {
      return { content: skills.map((s) => `${s.name}${s.description ? ` — ${s.description}` : ""}`).join("\n") };
    }
    const wanted = a.name.toLowerCase();
    const skill = skills.find((s) => s.name.toLowerCase() === wanted) ?? skills.find((s) => s.name.toLowerCase().includes(wanted));
    if (!skill) {
      return { content: `No skill called "${a.name}". Available: ${skills.map((s) => s.name).join(", ")}`, isError: true };
    }
    const raw = await readFile(skill.path, "utf8").catch(() => null);
    if (raw === null) return { content: `Could not read ${skill.path}`, isError: true };
    return { content: truncate(`# skill: ${skill.name}\n\n${frontmatter(raw).body.trim()}`, 40_000) };
  },
};
