import { z } from "zod";
import type { Tool } from "../types.js";
import { truncate } from "../paths.js";

const Args = z.object({
  role: z.enum(["explore", "implement"]),
  task: z.string().min(1),
  context: z.string().optional(),
});
export type DelegateArgs = z.infer<typeof Args> & { signal?: AbortSignal };

export interface DelegateOutcome {
  text: string;
  turns: number;
  cost: number;
}

/**
 * Subagents keep exploration noise out of the caller's context: the caller
 * sees one tool result, not fifty file reads.
 */
export function makeDelegateTool(run: (args: DelegateArgs) => Promise<DelegateOutcome>): Tool<z.infer<typeof Args>> {
  return {
    name: "delegate",
    description:
      "Hand a self-contained task to a subagent and get back only its final answer. role=explore: a fast, cheap model with read-only tools — use it for questions like 'find every place X is handled and summarize how' so the exploration does not fill your context. role=implement: a full agent with edit tools for an independent subtask (e.g. 'add unit tests for module Y'). Give it everything it needs in task/context; it cannot see this conversation.",
    parameters: {
      type: "object",
      properties: {
        role: { type: "string", enum: ["explore", "implement"] },
        task: { type: "string", description: "Complete, specific instructions" },
        context: { type: "string", description: "Relevant facts you already know (paths, constraints, decisions)" },
      },
      required: ["role", "task"],
    },
    parse: (raw) => Args.parse(raw),
    // Sub-implementers ask for their own permissions per tool call.
    risk: () => "read",
    summary: (a) => `delegate ${a.role}: ${a.task.length > 90 ? a.task.slice(0, 87) + "..." : a.task}`,
    async execute(a, ctx) {
      const outcome = await run({ ...a, signal: ctx.signal });
      return { content: truncate(outcome.text || "(subagent returned no answer)", 30_000) };
    },
  };
}
