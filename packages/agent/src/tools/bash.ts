import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { z } from "zod";
import { classifyCommand } from "@xcodit/shared";
import type { Tool } from "../types.js";
import { truncate } from "../paths.js";

const Args = z.object({
  command: z.string(),
  timeout_ms: z.number().int().positive().max(600_000).optional(),
});

/** Prefer a POSIX shell everywhere; on Windows that means Git Bash if present. */
export function detectShell(): { bin: string; args: string[]; name: string } {
  if (process.env.XCODIT_SHELL) return { bin: process.env.XCODIT_SHELL, args: ["-c"], name: process.env.XCODIT_SHELL };
  if (process.platform === "win32") {
    for (const p of ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"]) {
      if (existsSync(p)) return { bin: p, args: ["-c"], name: "bash (Git Bash)" };
    }
    return { bin: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command"], name: "powershell" };
  }
  return { bin: "/bin/bash", args: ["-c"], name: "bash" };
}

export const bashTool: Tool<z.infer<typeof Args>> = {
  name: "bash",
  description:
    "Run a shell command in the project directory and return stdout+stderr. Use for git, package managers, tests, builds. Avoid interactive commands. Output is truncated when long.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      timeout_ms: { type: "integer", description: "Kill after this many ms (default 120000)" },
    },
    required: ["command"],
  },
  parse: (raw) => Args.parse(raw),
  risk: (a) => classifyCommand(a.command),
  summary: (a) => `$ ${a.command.length > 120 ? a.command.slice(0, 117) + "..." : a.command}`,
  execute(a, ctx) {
    const shell = detectShell();
    const timeout = a.timeout_ms ?? 120_000;
    return new Promise((resolve) => {
      const child = spawn(shell.bin, [...shell.args, a.command], {
        cwd: ctx.cwd,
        env: { ...process.env, CI: "1", GIT_TERMINAL_PROMPT: "0", PAGER: "cat", GIT_PAGER: "cat" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let out = "";
      const cap = (d: Buffer) => { if (out.length < 2_000_000) out += d.toString(); };
      child.stdout.on("data", cap);
      child.stderr.on("data", cap);
      const timer = setTimeout(() => { child.kill(); out += `\n[killed after ${timeout}ms]`; }, timeout);
      const onAbort = () => child.kill();
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", (err) => { clearTimeout(timer); resolve({ content: `Failed to start shell: ${err.message}`, isError: true }); });
      child.on("close", (code) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        const body = truncate(out.trim());
        resolve({ content: code === 0 ? body || "(no output)" : `${body}\n[exit code ${code}]`, isError: code !== 0 });
      });
    });
  },
};
