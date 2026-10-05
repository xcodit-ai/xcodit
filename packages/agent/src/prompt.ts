import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { detectShell } from "./tools/bash.js";

const exec = promisify(execFile);

/** Project instructions written by humans; short and specific beats long. */
export async function loadProjectInstructions(cwd: string): Promise<string | null> {
  for (const name of ["AGENTS.md", "CLAUDE.md", ".xcodit/instructions.md"]) {
    const text = await readFile(join(cwd, name), "utf8").catch(() => null);
    if (text?.trim()) return `# Project instructions (${name})\n\n${text.trim().slice(0, 20_000)}`;
  }
  return null;
}

async function gitSummary(cwd: string): Promise<string> {
  try {
    const { stdout: branch } = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
    const { stdout: status } = await exec("git", ["status", "--short"], { cwd });
    const lines = status.trim().split("\n").filter(Boolean);
    const shown = lines.slice(0, 20).join("\n");
    return `Git branch: ${branch.trim()}\nWorking tree: ${lines.length ? `${lines.length} changed file(s)\n${shown}${lines.length > 20 ? "\n..." : ""}` : "clean"}`;
  } catch {
    return "Git: not a repository";
  }
}

export async function buildSystemPrompt(cwd: string): Promise<string> {
  const shell = detectShell();
  const instructions = await loadProjectInstructions(cwd);
  const git = await gitSummary(cwd);
  const parts = [
    `You are xcodit, a coding agent working directly in the user's repository. You make real changes to real files.

# How to work
- Understand before changing: use grep/glob/read_file to find the relevant code. Read a file before editing it.
- Make minimal, targeted edits with edit_file. Use write_file only for new files or full rewrites.
- Match the surrounding code's style, naming and conventions. Do not add comments, docs or refactors that were not asked for.
- After changing code, verify it: run the project's typecheck, linter or tests with bash when they exist. Fix what you broke.
- Do not commit, push or install packages unless asked.
- When a task is ambiguous in a way that changes the outcome, ask a short question instead of guessing. Otherwise proceed.
- Keep replies brief. Report what you changed and what you verified, not a narrative.

# Environment
- Working directory: ${cwd}
- Platform: ${process.platform} (${process.arch}); shell for bash tool: ${shell.name}
- Date: ${new Date().toISOString().slice(0, 10)}
- Paths in tool calls are relative to the working directory. You cannot access files outside it.
- ${git}`,
  ];
  if (instructions) parts.push(instructions);
  return parts.join("\n\n");
}
