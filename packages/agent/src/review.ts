import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { relative, sep } from "node:path";
import { z } from "zod";
import type { GatewayClient } from "./gateway.js";
import { truncate } from "./paths.js";

const exec = promisify(execFile);

export const ReviewIssueSchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low"]),
  file: z.string().optional(),
  line: z.number().int().optional(),
  description: z.string(),
  suggestion: z.string().optional(),
});
export const ReviewSchema = z.object({
  verdict: z.enum(["approve", "request_changes"]),
  summary: z.string(),
  issues: z.array(ReviewIssueSchema).default([]),
});
export type Review = z.infer<typeof ReviewSchema>;
export type ReviewIssue = z.infer<typeof ReviewIssueSchema>;

/** Diff of the files the agent touched this turn (git repos only; new files included). */
export async function diffForFiles(cwd: string, absPaths: string[]): Promise<string | null> {
  if (!absPaths.length) return null;
  const rels = absPaths.map((p) => relative(cwd, p).split(sep).join("/"));
  try {
    await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  } catch {
    return null;
  }
  const { stdout: trackedOut } = await exec("git", ["ls-files", "--", ...rels], { cwd });
  const tracked = new Set(trackedOut.split(/\r?\n/).filter(Boolean));
  const parts: string[] = [];
  if (tracked.size) {
    const { stdout } = await exec("git", ["diff", "--no-color", "--", ...tracked], { cwd, maxBuffer: 20_000_000 });
    if (stdout.trim()) parts.push(stdout.trim());
  }
  // Untracked files: diff against nothing, without touching the user's index.
  for (const rel of rels.filter((r) => !tracked.has(r))) {
    const out = await exec("git", ["diff", "--no-color", "--no-index", "--", "/dev/null", rel], { cwd, maxBuffer: 20_000_000 })
      .then((r) => r.stdout)
      .catch((err: { stdout?: string }) => err.stdout ?? ""); // exit code 1 = differences found
    if (out.trim()) parts.push(out.trim());
  }
  return parts.length ? parts.join("\n") : null;
}

const SYSTEM = `You are a senior engineer reviewing a code change made by another AI agent. You did not write this code; be skeptical.

Judge only what is in the diff and the stated task. Look for: bugs and logic errors, unhandled cases, broken or missing error handling, security problems, changes that do not match the task, accidental deletions, and code that will not compile or run. Ignore style unless it hides a bug. Do not request tests or docs unless the task asked for them.

Respond with JSON only, no prose, matching:
{"verdict":"approve"|"request_changes","summary":"one or two sentences","issues":[{"severity":"critical"|"high"|"medium"|"low","file":"path","line":123,"description":"what is wrong","suggestion":"how to fix"}]}

Use "request_changes" only for critical or high issues that would ship a bug. Medium and low issues are advisory: list them but still approve.`;

export async function reviewDiff(
  gateway: GatewayClient,
  args: { task: string; implementerSummary: string; verifyReport: string; diff: string; sessionId: string; signal?: AbortSignal },
): Promise<{ review: Review; model?: string; cost: number }> {
  const user = `# Task given to the agent
${args.task}

# Agent's own summary of the change
${args.implementerSummary || "(none)"}

# Verification result
${truncate(args.verifyReport, 4000)}

# Diff
\`\`\`diff
${truncate(args.diff, 60_000)}
\`\`\``;

  const turn = await gateway.chat(
    "reviewer",
    [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
    { session_id: args.sessionId, max_tokens: 3000, signal: args.signal },
  );
  const cost = turn.usage?.cost ?? 0;
  const json = extractJson(turn.content);
  const parsed = ReviewSchema.safeParse(json);
  if (!parsed.success) {
    return { review: { verdict: "approve", summary: `Reviewer returned unparseable output: ${turn.content.slice(0, 200)}`, issues: [] }, model: turn.model, cost };
  }
  return { review: parsed.data, model: turn.model, cost };
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end < 0) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
}

export function blockingIssues(review: Review): ReviewIssue[] {
  return review.issues.filter((i) => i.severity === "critical" || i.severity === "high");
}

export function formatIssuesForModel(issues: ReviewIssue[]): string {
  return issues
    .map((i, n) => `${n + 1}. [${i.severity}] ${i.file ? `${i.file}${i.line ? `:${i.line}` : ""} — ` : ""}${i.description}${i.suggestion ? `\n   Suggestion: ${i.suggestion}` : ""}`)
    .join("\n");
}
