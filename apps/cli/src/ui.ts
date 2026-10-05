import { createInterface, type Interface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { AgentEvent, PermissionRequest } from "@xcodit/agent";
import { C, G, PHASE_LABEL, caps, roleColor, roleModel } from "./tui/theme.js";
import { paint } from "./tui/ansi.js";
import { linesToString } from "./tui/ansi.js";
import { bannerLines } from "./tui/transcript.js";
import { gatherFacts } from "./tui/banner.js";

/** Line-mode styling: same palette and glyphs as the full-screen UI. */
export const dim = (s: string) => paint(s, C.muted);
export const bold = (s: string) => paint(s, undefined, { bold: true });
export const red = (s: string) => paint(s, C.danger);
export const green = (s: string) => paint(s, C.ok);
export const yellow = (s: string) => paint(s, C.warn);
export const blue = (s: string) => paint(s, C.planner);
export const magenta = (s: string) => paint(s, C.planner);
export const cyan = (s: string) => paint(s, C.accent);

let rl: Interface | null = null;
export function readline(): Interface {
  if (!rl) {
    rl = createInterface({ input: stdin, output: stdout });
    rl.on("SIGINT", () => { /* handled by the caller via AbortController */ });
  }
  return rl;
}
export function closeReadline() {
  rl?.close();
  rl = null;
}

export async function printBanner(cwd: string, tools: number): Promise<void> {
  const facts = await gatherFacts(cwd, tools, true);
  stdout.write(linesToString(bannerLines(facts, Math.min(100, (stdout.columns || 80) - 1))) + "\n");
}

/** Prints agent events as they stream; tool noise is one line each, subagents indented. */
export function createRenderer() {
  let atLineStart = true;
  let sawText = false;
  const write = (s: string) => { stdout.write(s); atLineStart = s.endsWith("\n"); };
  const nl = () => { if (!atLineStart) write("\n"); };
  const pad = (depth: number) => "  ".repeat(depth);

  return {
    render(e: AgentEvent) {
      switch (e.type) {
        case "phase":
          nl();
          write(paint(`${G.stepActive} ${PHASE_LABEL[e.phase] ?? e.phase}${e.detail ? ` (${e.detail})` : ""}`, roleColor(e.role), { bold: true }) + dim(`  ${roleModel(e.role)}\n`));
          break;
        case "text_delta":
          if (e.depth > 0) break;
          if (!sawText) { write(paint(`${G.agent} `, C.accent)); sawText = true; }
          write(e.text.replace(/\n/g, "\n  "));
          break;
        case "reasoning_delta":
          break;
        case "tool_start":
          nl();
          write(dim(`${pad(e.depth)}${G.tool} ${e.summary}`));
          break;
        case "tool_end": {
          const first = e.result.content.split("\n")[0] ?? "";
          write(e.result.isError ? red(`  ${G.err} ${first.slice(0, 160)}\n`) : dim(`  ${G.ok} ${e.ms}ms\n`));
          break;
        }
        case "tool_denied":
          write(yellow(`  ${G.err} denied\n`));
          break;
        case "subagent_start":
          nl();
          write(dim(`  ${G.sub} ${roleModel(e.role)} working${G.ellipsis}\n`));
          break;
        case "subagent_end":
          write(dim(`  ${G.sub} done ${G.sep} ${e.turns} calls ${G.sep} $${e.cost.toFixed(4)}\n`));
          break;
        case "model_done":
          if (e.depth === 0 && sawText) nl();
          if (e.depth === 0) sawText = false;
          break;
        case "compaction":
          nl();
          write(dim(`  ${G.info} compacted context ${e.before.toLocaleString()} ${G.arrow} ${e.after.toLocaleString()} tokens\n`));
          break;
        case "verify_start":
          write(dim(`  ${G.tool} checks: ${e.commands.join(`  ${G.sep}  `)}\n`));
          break;
        case "verify_end":
          write(e.passed
            ? green(`  ${G.ok} all checks passed\n`)
            : red(`  ${G.err} checks failed (attempt ${e.attempt})\n`) + dim(e.report.split("\n").slice(0, 12).map((l) => `    ${l}`).join("\n")) + "\n");
          break;
        case "review_start":
          write(dim(`  ${G.info} reviewing a ${e.diffChars.toLocaleString()}-character diff\n`));
          break;
        case "review_end": {
          const ok = e.verdict === "approve";
          write(`${ok ? green(`  ${G.ok} approved`) : yellow(`  ${G.warn} changes requested`)}${dim(`  ${roleModel("reviewer")} ${G.sep} $${e.cost.toFixed(4)}`)}\n    ${e.summary}\n`);
          for (const i of e.issues) {
            const sev = i.severity === "critical" || i.severity === "high" ? red(i.severity) : dim(i.severity);
            write(`    [${sev}] ${i.file ? `${i.file}${i.line ? `:${i.line}` : ""} — ` : ""}${i.description}\n`);
          }
          break;
        }
        case "plan_ready":
          nl();
          write(`\n${paint(" plan ", C.planner, { bold: true })}\n${e.plan.split("\n").map((l) => `  ${l}`).join("\n")}\n\n`);
          break;
        case "error":
          nl();
          write(red(`  ${G.err} ${e.message}\n`));
          break;
        case "turn_end":
          nl();
          break;
      }
    },
  };
}

export async function askPermission(req: PermissionRequest, remember: Set<string>): Promise<boolean> {
  if (remember.has(req.tool) && req.risk !== "dangerous") return true;
  stdout.write("\n");
  const tag = req.risk === "dangerous" ? red(bold("DANGEROUS")) : yellow("permission");
  stdout.write(`${tag} ${req.summary}\n`);
  if (req.detail) stdout.write(dim(req.detail.split("\n").slice(0, 30).map((l) => `    ${l}`).join("\n")) + "\n");
  const opts = req.risk === "dangerous" ? "[y/N]" : "[y/N/a=always for this tool]";
  const answer = (await readline().question(`Allow? ${opts} `)).trim().toLowerCase();
  if (answer === "a" && req.allowRemember !== false && req.risk !== "dangerous") { remember.add(req.tool); return true; }
  return answer === "y" || answer === "yes";
}

/** Interactive plan gate: proceed, add notes, or stop. */
export async function approvePlan(plan: string): Promise<string | null> {
  const answer = (await readline().question("Proceed with this plan? [Y/n/notes] ")).trim();
  if (!answer || /^y(es)?$/i.test(answer)) return plan;
  if (/^n(o)?$/i.test(answer)) return null;
  return `${plan}\n\n# Notes from the user\n${answer}`;
}

export const unicode = () => caps.unicode;
