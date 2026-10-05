import type { AgentEvent, PermissionRequest } from "@xcodit/agent";

/**
 * A scripted session for `xcodit --demo`. No network, no files, no tools:
 * it replays a plausible run through the same event pipeline the real agent
 * uses, so what you see is exactly what a real session looks like.
 */

export interface AgentLike {
  tools: { length: number };
  totals: { turns: number; cost: number; cached_tokens: number; prompt_tokens: number; completion_tokens: number };
  session: { messages: unknown[]; meta: { id: string } };
  run(text: string, opts: { plan?: boolean; signal?: AbortSignal }): Promise<void>;
  undo(): Promise<string[]>;
  setMode(mode: string): void;
  setOption(key: "verify" | "review", value: boolean): void;
}

const PLAN = `## Goal
\`Stack\` exposes \`peek()\` and \`isEmpty()\`, covered by a test suite that \`npm test\` runs.

## Steps
1. \`src/stack.ts\` — add \`peek(): T | undefined\` and \`isEmpty(): boolean\` after \`pop()\`
2. \`src/stack.test.ts\` — new \`node:test\` suite for push/pop/peek/isEmpty
3. \`package.json\` — add a \`test\` script that runs it with plain node

## Verification
- \`npm run typecheck\` exits 0
- \`npm test\` passes

## Risks / open questions
- \`length\` would read as array-like; \`size\` stays the canonical name.`;

const SUMMARY = `Added both methods and a suite that covers them.

| file | change |
| --- | --- |
| \`src/stack.ts\` | \`peek()\` and \`isEmpty()\`, matching the one-line getter style |
| \`src/stack.test.ts\` | 6 tests: empty stack, LIFO order, non-destructive peek |
| \`package.json\` | \`test\` script |

\`\`\`ts
peek(): T | undefined { return this.items[this.items.length - 1]; }
isEmpty(): boolean { return this.items.length === 0; }
\`\`\`

Both checks pass. The reviewer had no blocking issues.`;

/** Enough lines that the card reports a real size. */
const STACK_SRC = Array.from({ length: 212 }, (_, i) => `  line ${i + 1}`).join("\n");

const TEST_OUTPUT = [
  "> proj@ test",
  "> node --experimental-strip-types src/stack.test.ts",
  "",
  "▶ Stack",
  "  ✔ is empty when new (1.2ms)",
  "  ✔ reports size after pushes (0.4ms)",
  "  ✔ pops in LIFO order (0.3ms)",
  "  ✔ peek returns the top without removing it (0.3ms)",
  "  ✔ peek on an empty stack is undefined (0.2ms)",
  "  ✔ works with a string stack (0.2ms)",
  "▶ Stack (3.1ms)",
  "",
  "ℹ tests 6",
  "ℹ pass 6",
  "ℹ fail 0",
].join("\n");

type Step =
  | { at: number; event: AgentEvent }
  | { at: number; permission: PermissionRequest }
  | { at: number; plan: string }
  | { at: number; cost: number; cached: number };

/** Streams text as a few deltas so the block cursor is visible. */
function stream(at: number, text: string, chunk = 26): Step[] {
  const out: Step[] = [];
  let t = at;
  for (let i = 0; i < text.length; i += chunk) {
    out.push({ at: t, event: { type: "text_delta", text: text.slice(i, i + chunk), depth: 0 } });
    t += 28;
  }
  out.push({ at: t, event: { type: "model_done", role: "implementer", depth: 0, model: "relay-build" } });
  return out;
}

const tool = (at: number, id: string, name: string, summary: string, ms: number, content = "ok", isError = false): Step[] => [
  { at, event: { type: "tool_start", id, name, summary, depth: 0 } },
  { at: at + ms, event: { type: "tool_end", id, name, ms, depth: 0, result: { content, isError } } },
];

export function demoScript(): Step[] {
  const s: Step[] = [];
  s.push({ at: 300, event: { type: "phase", phase: "plan", role: "planner" } });
  s.push(...tool(600, "d1", "glob", "glob **/*.ts", 180, "src/stack.ts"));
  s.push(...tool(900, "d2", "read_file", "read src/stack.ts", 90, STACK_SRC));
  s.push(...tool(1150, "d3", "bash", "$ cat package.json tsconfig.json", 260));
  s.push({ at: 1700, cost: 0.0011, cached: 1280 });
  s.push({ at: 1720, event: { type: "plan_ready", plan: PLAN } });
  s.push({ at: 1750, plan: PLAN });

  s.push({ at: 1760, event: { type: "phase", phase: "implement", role: "implementer" } });
  s.push(...tool(1900, "d4", "read_file", "read src/stack.ts", 60, STACK_SRC));
  s.push({
    at: 2150,
    permission: {
      tool: "edit_file",
      risk: "mutate",
      summary: "edit src/stack.ts (2 → 4 lines)",
      path: "src/stack.ts",
      before: "  pop(): T | undefined { return this.items.pop(); }\n  get size(): number { return this.items.length; }",
      after:
        "  pop(): T | undefined { return this.items.pop(); }\n" +
        "  peek(): T | undefined { return this.items[this.items.length - 1]; }\n" +
        "  isEmpty(): boolean { return this.items.length === 0; }\n" +
        "  get size(): number { return this.items.length; }",
    },
  });
  s.push(...tool(2160, "d5", "edit_file", "edit src/stack.ts (2 → 4 lines)", 40));
  s.push(...tool(2350, "d6", "write_file", "write src/stack.test.ts (1,318 chars)", 30));
  s.push(...tool(2500, "d7", "edit_file", "edit package.json (1 → 1 lines)", 25));
  s.push({ at: 2700, event: { type: "subagent_start", id: "s1", role: "navigator", task: "find call sites", depth: 1 } });
  s.push({ at: 3300, event: { type: "subagent_end", id: "s1", role: "navigator", turns: 2, cost: 0.0002, depth: 1 } });
  s.push(...tool(3400, "d8", "bash", "$ npm test", 1380, TEST_OUTPUT));
  s.push({ at: 4900, cost: 0.0049, cached: 8192 });
  s.push(...stream(5000, SUMMARY, 40));

  s.push({ at: 6100, event: { type: "phase", phase: "verify", role: "implementer" } });
  s.push({ at: 6150, event: { type: "verify_start", commands: ["npm run typecheck", "npm test"] } });
  s.push({ at: 7400, event: { type: "verify_end", passed: true, report: "$ npm run typecheck — ok (1823ms)\n$ npm test — ok (1413ms)", attempt: 1 } });

  s.push({ at: 7600, event: { type: "phase", phase: "review", role: "reviewer" } });
  s.push({ at: 7650, event: { type: "review_start", diffChars: 2983 } });
  s.push({
    at: 9200,
    event: {
      type: "review_end",
      verdict: "approve",
      summary: "peek() is non-destructive and the suite covers the new surface. No blocking issues.",
      issues: [{ severity: "low", file: "src/stack.test.ts", line: 41, description: "a generic-type case would round out the coverage" }],
      model: "relay-judge",
      cost: 0.0039,
    },
  });
  s.push({ at: 9300, cost: 0.0088, cached: 11340 });
  s.push({ at: 9400, event: { type: "turn_end", turns: 12 } });
  return s;
}

export const DEMO_PROMPT = "add peek() and isEmpty() to Stack, with tests";

/**
 * Stands in for the real Agent: same surface, scripted events. Permission and
 * plan dialogs are shown and then answered on a timer so the demo plays alone.
 */
export function createDemoAgent(
  onEvent: (e: AgentEvent) => void,
  askPermission: (r: PermissionRequest) => Promise<boolean>,
  approvePlan: (p: string) => Promise<string | null>,
): AgentLike {
  const totals = { turns: 0, cost: 0, cached_tokens: 0, prompt_tokens: 0, completion_tokens: 0 };
  return {
    tools: { length: 7 },
    totals,
    session: { messages: [], meta: { id: "demo" } },
    setMode() {},
    setOption() {},
    async undo() { return ["restored src/stack.ts", "removed src/stack.test.ts"]; },
    async run(_text, opts) {
      const t0 = Date.now();
      // Dialogs pause the script; the clock rebases so later beats keep their spacing.
      let drift = 0;
      const wait = (at: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, at + drift - (Date.now() - t0))));
      const pause = async <T,>(p: Promise<T>) => {
        const before = Date.now();
        const out = await p;
        drift += Date.now() - before;
        return out;
      };
      for (const step of demoScript()) {
        if (opts.signal?.aborted) return;
        await wait(step.at);
        if ("event" in step) {
          if (step.event.type === "model_done" || step.event.type === "tool_end") totals.turns++;
          onEvent(step.event);
        } else if ("cost" in step) {
          totals.cost = step.cost;
          totals.cached_tokens = step.cached;
          totals.prompt_tokens = Math.round(step.cached * 1.4);
          totals.completion_tokens = Math.round(step.cached * 0.35);
          onEvent({ type: "model_done", role: "implementer", depth: 0, model: "relay-build" });
        } else if ("permission" in step) {
          await pause(askPermission(step.permission));
        } else if ("plan" in step) {
          await pause(approvePlan(step.plan));
        }
      }
    },
  };
}

/**
 * Non-interactive demo: folds the same script into a transcript and prints it
 * once. Used when stdout is piped, where animation and dialogs make no sense.
 */
export async function renderDemoPlain(width: number): Promise<string> {
  const { applyEvent, itemToLines, renderItems } = await import("./transcript.js");
  type Item = Parameters<typeof itemToLines>[0];
  const { linesToString } = await import("./ansi.js");
  const { gatherFacts } = await import("./banner.js");

  const facts = await gatherFacts(process.cwd(), 7, true);
  let items: Item[] = [{ kind: "banner", facts }, { kind: "user", text: DEMO_PROMPT }];
  for (const step of demoScript()) {
    if ("event" in step) items = applyEvent(items, step.event);
    else if ("plan" in step) continue; // the plan_ready event already added it
    else if ("permission" in step) {
      items = [...items, { kind: "note", text: `permission: ${step.permission.summary} — allowed`, color: undefined }];
    }
  }
  return linesToString(renderItems(items, width));
}
