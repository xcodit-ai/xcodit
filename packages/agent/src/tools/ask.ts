import { z } from "zod";
import type { Tool } from "../types.js";

const Args = z.object({
  question: z.string().min(3),
  options: z.array(z.string().min(1)).max(5).optional().describe("Offer these as choices instead of free text"),
});

export type AskUser = (question: string, options?: string[]) => Promise<string>;

/**
 * Asking beats guessing. The system prompt already tells the agent to ask when
 * an ambiguity would change the outcome; this is how it does that mid-run
 * instead of finishing the wrong thing and apologising afterwards.
 */
export function makeAskTool(ask: AskUser): Tool<z.infer<typeof Args>> {
  return {
    name: "ask_user",
    description:
      "Ask one short question and wait for the answer. Use it when a choice would change the result and the repository does not settle it — which of two call sites is meant, whether to add a dependency, which behaviour is correct. Do not use it for things you can find out by reading the code, and do not ask for permission to run tools: that is handled for you.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "One specific question" },
        options: { type: "array", items: { type: "string" }, description: "Up to 5 choices, if the answer is a pick" },
      },
      required: ["question"],
    },
    parse: (raw) => Args.parse(raw),
    risk: () => "read",
    summary: (a) => `ask: ${a.question.length > 80 ? a.question.slice(0, 77) + "..." : a.question}`,
    async execute(a) {
      const answer = (await ask(a.question, a.options)).trim();
      if (!answer) return { content: "The user did not answer. Make a reasonable assumption, say which one you made, and carry on." };
      return { content: `The user answered: ${answer}` };
    },
  };
}
