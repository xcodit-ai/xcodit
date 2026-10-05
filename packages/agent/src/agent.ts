import { randomUUID } from "node:crypto";
import { evaluatePermission, type Message, type PermissionCheck, type PermissionVerdict, type Role } from "@xcodit/shared";
import type { GatewayClient } from "./gateway.js";
import { CANCELLED_TOOL_RESULT, type SessionStore } from "./session.js";
import { SnapshotStack } from "./snapshot.js";
import { buildSystemPrompt } from "./prompt.js";
import { compact, estimateTokens } from "./compact.js";
import { CORE_TOOLS, READ_ONLY_TOOLS, sessionTools, toolDefs } from "./tools/index.js";
import { makeDelegateTool } from "./tools/delegate.js";
import { loadProjectConfig, type ProjectConfig } from "./config.js";
import { discoverChecks, runChecks } from "./verify.js";
import { blockingIssues, diffForFiles, formatIssuesForModel, reviewDiff } from "./review.js";
import type { AgentEvent, PermissionMode, PermissionRequest, TodoItem, Tool, ToolContext, ToolResult, Usage } from "./types.js";

export interface AgentOptions {
  gateway: GatewayClient;
  cwd: string;
  mode: PermissionMode;
  session: SessionStore;
  askPermission: (req: PermissionRequest) => Promise<boolean>;
  onEvent: (e: AgentEvent) => void;
  /** Shown the plan; return the (possibly edited) plan to proceed, or null to stop. */
  approvePlan?: (plan: string) => Promise<string | null>;
  /** Answer a question from the agent. Without it, ask_user is not offered. */
  askUser?: (question: string, options?: string[]) => Promise<string>;
  /** Run project checks after changes (default true). */
  verify?: boolean;
  /** Cross-model review of the diff after checks pass (default true). */
  review?: boolean;
  /** Model round-trips allowed per loop before stopping. */
  maxTurns?: number;
  /** Compact when the estimated context exceeds this many tokens. */
  contextBudgetTokens?: number;
}

export interface RunOptions {
  /** Plan with the planner role before implementing. */
  plan?: boolean;
  signal?: AbortSignal;
}

export interface LoopResult {
  text: string;
  turns: number;
  cost: number;
}

interface LoopSpec {
  role: Role;
  system: string;
  messages: Message[];
  append: (m: Message) => Promise<void>;
  tools: Tool[];
  maxTurns: number;
  depth: number;
  compactable?: boolean;
  signal?: AbortSignal;
}

const MAX_REPAIR_ROUNDS = 2;
const MAX_FIX_ROUNDS = 1;

const PLANNER_ADDENDUM = `# Planning mode
You are the planner. Explore the codebase with the read-only tools (or delegate exploration), then write an implementation plan for another engineer-agent to execute. Do not make changes.

Output the plan as markdown:
1. **Goal** — one sentence restating what must be true when done.
2. **Steps** — numbered; each names the files to touch and what changes, in execution order. Be concrete (function names, signatures, where code goes).
3. **Verification** — the exact commands or checks that prove it works.
4. **Risks / open questions** — only real ones.
Keep it as short as the task allows.`;

const SUBAGENT_ADDENDUM = `# Subagent
You are a subagent working on one delegated task. The caller only sees your final message, not your tool calls, so end with a complete, self-contained answer: exact paths, symbols, line numbers, and findings. Do not ask questions; make reasonable assumptions and state them.`;

export class Agent {
  readonly snapshots: SnapshotStack;
  readonly tools: Tool[];
  readonly totals = { turns: 0, cost: 0, prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0 };
  private busy = false;
  private config: ProjectConfig | null = null;

  /** The task list the model keeps for itself; the UI mirrors it. */
  todos: TodoItem[] = [];

  constructor(private opts: AgentOptions) {
    this.snapshots = new SnapshotStack(opts.cwd);
    const delegate = makeDelegateTool((spec) => this.delegate(spec));
    const session = sessionTools({
      onTodos: (todos) => {
        this.todos = todos;
        opts.onEvent({ type: "todos", items: todos });
      },
      ask: async (question, options) => {
        if (!opts.askUser) return "";
        return opts.askUser(question, options);
      },
      search: {
        search: async (query, maxResults, signal) => {
          const turn = await opts.gateway.chat(
            "navigator",
            [
              { role: "system", content: "Answer from the search results. Be specific and brief, quote exact names and versions, and list the source URLs you used at the end." },
              { role: "user", content: query },
            ],
            { session_id: opts.session.meta.id, max_tokens: 1500, signal, web: { max_results: maxResults } },
          );
          this.account(turn.usage);
          const sources = turn.citations?.length
            ? "\n\nSources:\n" + turn.citations.map((c) => `- ${c.title ?? c.url} ${c.url}`).join("\n")
            : "";
          return turn.content + sources;
        },
      },
    });
    // ask_user is only offered when there is someone to ask.
    this.tools = [...CORE_TOOLS, delegate, ...session.filter((t) => t.name !== "ask_user" || opts.askUser)];
  }

  get session() {
    return this.opts.session;
  }

  setMode(mode: PermissionMode) {
    this.opts.mode = mode;
  }

  setOption<K extends "verify" | "review">(key: K, value: boolean) {
    this.opts[key] = value;
  }

  /** Run one user message through plan? → implement → verify → review → done. */
  async run(userText: string, run: RunOptions = {}): Promise<void> {
    if (this.busy) throw new Error("Agent is already running");
    this.busy = true;
    const { session, onEvent } = this.opts;
    const signal = run.signal;

    this.snapshots.beginTurn();
    try {
      this.config ??= await loadProjectConfig(this.opts.cwd);
      const system = await buildSystemPrompt(this.opts.cwd);
      let task = userText;

      if (run.plan) {
        onEvent({ type: "phase", phase: "plan", role: "planner" });
        const plan = await this.plan(system, userText, signal);
        onEvent({ type: "plan_ready", plan });
        const approved = this.opts.approvePlan ? await this.opts.approvePlan(plan) : plan;
        if (approved === null) return;
        task = `${userText}\n\n# Approved plan\n${approved}\n\nExecute this plan. Deviate only if the code proves the plan wrong, and say so.`;
      }

      if (!session.meta.title) await session.setTitle(userText.slice(0, 60).replace(/\s+/g, " "));
      await session.append({ role: "user", content: task });

      onEvent({ type: "phase", phase: "implement", role: "implementer" });
      const main: LoopSpec = {
        role: "implementer",
        system,
        messages: session.messages,
        append: (m) => session.append(m),
        tools: this.tools,
        maxTurns: this.opts.maxTurns ?? 50,
        depth: 0,
        compactable: true,
        signal,
      };
      let last = await this.loop(main);
      if (signal?.aborted) return;

      // Nothing changed on disk: nothing to verify or review.
      if (!this.snapshots.changedFiles().length) return;

      let verifyReport = "(verification disabled)";
      if (this.opts.verify !== false) {
        for (let attempt = 1; attempt <= MAX_REPAIR_ROUNDS + 1; attempt++) {
          const result = await this.verify(attempt, signal);
          if (!result) { verifyReport = "(no checks found)"; break; }
          verifyReport = result.report;
          if (result.passed || attempt > MAX_REPAIR_ROUNDS || signal?.aborted) break;
          onEvent({ type: "phase", phase: "repair", role: "implementer", detail: `attempt ${attempt}` });
          await session.append({
            role: "user",
            content: `Verification failed. Fix the cause (not the check) and keep the change minimal.\n\n${result.report}`,
          });
          last = await this.loop(main);
        }
      }

      if (this.opts.review !== false && this.config.review !== false && !signal?.aborted) {
        for (let round = 0; round <= MAX_FIX_ROUNDS; round++) {
          const diff = await diffForFiles(this.opts.cwd, this.snapshots.changedFiles());
          if (!diff) break;
          onEvent({ type: "phase", phase: "review", role: "reviewer" });
          onEvent({ type: "review_start", diffChars: diff.length });
          const { review, model, cost } = await reviewDiff(this.opts.gateway, {
            task: userText, implementerSummary: last.text, verifyReport, diff, sessionId: session.meta.id, signal,
          });
          this.totals.cost += cost;
          onEvent({ type: "review_end", verdict: review.verdict, summary: review.summary, issues: review.issues, model, cost });
          const blocking = blockingIssues(review);
          if (review.verdict === "approve" || !blocking.length || round === MAX_FIX_ROUNDS || signal?.aborted) break;

          onEvent({ type: "phase", phase: "fix", role: "implementer" });
          await session.append({
            role: "user",
            content: `A reviewer found blocking issues in your change. Address each one (or explain precisely why it is not a bug), then stop.\n\n${formatIssuesForModel(blocking)}`,
          });
          last = await this.loop(main);
          if (this.opts.verify !== false && !signal?.aborted) await this.verify(MAX_REPAIR_ROUNDS + 1, signal);
        }
      }
    } finally {
      this.snapshots.endTurn();
      this.busy = false;
      onEvent({ type: "turn_end", turns: this.totals.turns });
    }
  }

  async undo(): Promise<string[]> {
    return this.snapshots.undo();
  }

  // ---- phases -------------------------------------------------------------

  private async plan(system: string, task: string, signal?: AbortSignal): Promise<string> {
    const messages: Message[] = [{ role: "user", content: task }];
    const delegate = this.tools.find((t) => t.name === "delegate")!;
    const result = await this.loop({
      role: "planner",
      system: `${system}\n\n${PLANNER_ADDENDUM}`,
      messages,
      append: async (m) => { messages.push(m); },
      tools: [...READ_ONLY_TOOLS, delegate, ...this.tools.filter((t) => t.name === "web_search" || t.name === "ask_user")],
      maxTurns: 25,
      depth: 0,
      signal,
    });
    return result.text.trim();
  }

  private async verify(attempt: number, signal?: AbortSignal) {
    const commands = this.config?.verify ?? (await discoverChecks(this.opts.cwd));
    if (!commands.length) return null;
    this.opts.onEvent({ type: "phase", phase: "verify", role: "implementer" });
    this.opts.onEvent({ type: "verify_start", commands });
    const result = await runChecks(this.opts.cwd, commands, (this.config?.verify_timeout ?? 300) * 1000, signal);
    this.opts.onEvent({ type: "verify_end", passed: result.passed, report: result.report, attempt });
    return result;
  }

  /** Runs a sub-loop for the delegate tool; only the final text returns to the caller. */
  private async delegate(spec: { role: "explore" | "implement"; task: string; context?: string; signal?: AbortSignal }): Promise<LoopResult> {
    const system = await buildSystemPrompt(this.opts.cwd);
    const messages: Message[] = [{ role: "user", content: spec.context ? `${spec.task}\n\n# Context from the caller\n${spec.context}` : spec.task }];
    const explore = spec.role === "explore";
    const id = randomUUID().slice(0, 8);
    const role: Role = explore ? "navigator" : "implementer";
    this.opts.onEvent({ type: "subagent_start", id, role, task: spec.task, depth: 1 });
    const result = await this.loop({
      role: explore ? "navigator" : "implementer",
      system: `${system}\n\n${SUBAGENT_ADDENDUM}`,
      messages,
      append: async (m) => { messages.push(m); },
      tools: explore
        ? [...READ_ONLY_TOOLS, ...this.tools.filter((t) => t.name === "web_search")]
        : CORE_TOOLS, // no nested delegation
      maxTurns: explore ? 20 : 30,
      depth: 1,
      signal: spec.signal,
    });
    this.opts.onEvent({ type: "subagent_end", id, role, turns: result.turns, cost: result.cost, depth: 1 });
    return result;
  }

  // ---- the loop -----------------------------------------------------------

  private async loop(spec: LoopSpec): Promise<LoopResult> {
    const { gateway, onEvent, session } = this.opts;
    const budget = this.opts.contextBudgetTokens ?? 160_000;
    const defs = toolDefs(spec.tools);
    const systemMsg: Message = { role: "system", content: spec.system };
    let turns = 0;
    let cost = 0;
    let text = "";

    for (;;) {
      if (spec.signal?.aborted) break;
      if (turns++ >= spec.maxTurns) {
        onEvent({ type: "error", message: `Stopped after ${spec.maxTurns} model turns; send another message to continue.` });
        break;
      }

      if (spec.compactable && estimateTokens(spec.messages) > budget) {
        const before = estimateTokens(spec.messages);
        session.replaceMessages(await compact(gateway, spec.messages, session.meta.id, spec.signal));
        spec.messages = session.messages;
        onEvent({ type: "compaction", before, after: estimateTokens(spec.messages) });
      }

      const turn = await gateway.chat(
        spec.role,
        [systemMsg, ...spec.messages],
        { tools: defs, session_id: session.meta.id, signal: spec.signal },
        {
          onText: (t) => onEvent({ type: "text_delta", text: t, depth: spec.depth }),
          onReasoning: (t) => onEvent({ type: "reasoning_delta", text: t, depth: spec.depth }),
        },
      );
      cost += this.account(turn.usage);
      onEvent({ type: "model_done", model: turn.model, usage: turn.usage, role: spec.role, depth: spec.depth });
      if (turn.content) text = turn.content;

      const assistant: Message = { role: "assistant", content: turn.content || null };
      if (turn.tool_calls.length) assistant.tool_calls = turn.tool_calls;
      await spec.append(assistant);
      if (!turn.tool_calls.length) break;

      for (const [i, call] of turn.tool_calls.entries()) {
        if (spec.signal?.aborted) {
          // Every call needs a result, or the next request in this session is rejected.
          for (const skipped of turn.tool_calls.slice(i)) {
            await spec.append({ role: "tool", tool_call_id: skipped.id, content: CANCELLED_TOOL_RESULT });
          }
          break;
        }
        const result = await this.invoke(spec, call.id, call.function.name, call.function.arguments);
        await spec.append({ role: "tool", tool_call_id: call.id, content: result.content });
      }
    }
    return { text, turns, cost };
  }

  private account(usage?: Usage): number {
    this.totals.turns++;
    if (!usage) return 0;
    this.totals.cost += usage.cost;
    this.totals.prompt_tokens += usage.prompt_tokens;
    this.totals.completion_tokens += usage.completion_tokens;
    this.totals.cached_tokens += usage.cached_tokens;
    return usage.cost;
  }

  /**
   * The verdict for one tool call. Only what the policy needs to judge is sent:
   * the tool, the mode, the command line and the path — never file contents.
   * If the server cannot be reached we ask the user rather than assume yes.
   */
  private async permissionFor(
    tool: string,
    args: { command?: string; path?: string },
    signal?: AbortSignal,
  ): Promise<PermissionVerdict> {
    const check: PermissionCheck = {
      tool,
      mode: this.opts.mode,
      command: args.command,
      path: args.path,
      session_id: this.opts.session.meta.id,
    };
    try {
      return await this.opts.gateway.checkPermission(check, signal);
    } catch {
      const local = evaluatePermission(check);
      return {
        ...local,
        decision: local.decision === "allow" && local.risk !== "read" ? "ask" : local.decision,
        reason: local.decision === "allow" && local.risk !== "read"
          ? "The permission service could not be reached, so this needs your say-so."
          : local.reason,
      };
    }
  }

  private async invoke(spec: LoopSpec, id: string, name: string, rawArgs: string): Promise<ToolResult> {
    const { onEvent, askPermission } = this.opts;
    const depth = spec.depth;
    const tool = spec.tools.find((t) => t.name === name);
    if (!tool) {
      const result = { content: `Unknown tool: ${name}. Available: ${spec.tools.map((t) => t.name).join(", ")}`, isError: true };
      onEvent({ type: "tool_start", id, name, summary: name, depth });
      onEvent({ type: "tool_end", id, name, result, ms: 0, depth });
      return result;
    }

    let args: unknown;
    try {
      args = tool.parse(JSON.parse(rawArgs || "{}"));
    } catch (err) {
      const result = { content: `Invalid arguments for ${name}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      onEvent({ type: "tool_start", id, name, summary: name, depth });
      onEvent({ type: "tool_end", id, name, result, ms: 0, depth });
      return result;
    }

    const ctx: ToolContext = {
      cwd: this.opts.cwd,
      mode: this.opts.mode,
      askPermission,
      snapshotFile: (p) => this.snapshots.capture(p),
      signal: spec.signal,
    };
    const summary = tool.summary(args);
    const a = args as { old_string?: string; new_string?: string; content?: string; command?: string; path?: string };
    onEvent({ type: "tool_start", id, name, summary, depth });

    // The server rules on this; the client renders the verdict and obeys it.
    const verdict = await this.permissionFor(name, a, spec.signal);
    // An interrupt during the check must not turn into a permission prompt.
    if (spec.signal?.aborted) {
      const result = { content: CANCELLED_TOOL_RESULT, isError: true };
      onEvent({ type: "tool_end", id, name, result, ms: 0, depth });
      return result;
    }
    if (verdict.decision === "deny") {
      onEvent({ type: "tool_denied", id, name, depth });
      return {
        content: `Refused by policy: ${verdict.reason ?? "this action is not permitted."} Do not try to work around it; tell the user instead.`,
        isError: true,
      };
    }
    if (verdict.decision === "ask") {
      const detail = name === "write_file" ? String(a.content ?? "").slice(0, 2000)
        : name === "edit_file" ? `- ${a.old_string}\n+ ${a.new_string}`.slice(0, 2000)
        : name === "bash" ? String(a.command ?? "")
        : undefined;
      const ok = await askPermission({
        tool: name, risk: verdict.risk, summary, detail, path: a.path,
        reason: verdict.reason,
        allowRemember: verdict.allowRemember,
        before: name === "edit_file" ? a.old_string : name === "write_file" ? "" : undefined,
        after: name === "edit_file" ? a.new_string : name === "write_file" ? a.content : undefined,
      });
      if (!ok) {
        onEvent({ type: "tool_denied", id, name, depth });
        return { content: "The user declined this action. Ask how to proceed or try a different approach.", isError: true };
      }
    }

    const started = Date.now();
    let result: ToolResult;
    try {
      result = await tool.execute(args, ctx);
    } catch (err) {
      result = { content: `${name} failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
    onEvent({ type: "tool_end", id, name, result, ms: Date.now() - started, depth });
    return result;
  }
}
