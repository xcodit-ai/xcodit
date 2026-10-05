import type { Message } from "@xcodit/shared";
import type { GatewayClient } from "./gateway.js";

/** Rough but cheap; only used to decide when to compact. */
export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) chars += JSON.stringify(m).length;
  return Math.ceil(chars / 4);
}

const KEEP_RECENT = 6;

/**
 * Summarize everything but the most recent messages with the compactor role.
 * The summary goes in as a user message so every model treats it as context.
 */
export async function compact(
  gateway: GatewayClient,
  messages: Message[],
  sessionId: string,
  signal?: AbortSignal,
): Promise<Message[]> {
  if (messages.length <= KEEP_RECENT + 2) return messages;
  // Never split an assistant tool_call from its tool results.
  let cut = messages.length - KEEP_RECENT;
  while (cut > 1 && messages[cut]!.role === "tool") cut--;
  const older = messages.slice(0, cut);
  const recent = messages.slice(cut);

  const transcript = older
    .map((m) => {
      if (m.role === "tool") return `[tool result ${m.tool_call_id}]\n${m.content.slice(0, 2000)}`;
      if (m.role === "assistant") {
        const calls = (m.tool_calls ?? []).map((c) => `${c.function.name}(${c.function.arguments.slice(0, 300)})`).join("; ");
        return `[assistant]\n${m.content ?? ""}${calls ? `\ncalls: ${calls}` : ""}`;
      }
      return `[${m.role}]\n${m.content}`;
    })
    .join("\n\n");

  const turn = await gateway.chat(
    "compactor",
    [
      {
        role: "system",
        content:
          "You compress a coding-agent transcript into working notes for the same agent to continue from. Keep: the user's goal and constraints, decisions made, files examined and what was learned, files changed and how, commands run with their outcomes, open problems and next steps. Drop pleasantries and raw file dumps. Use terse markdown with exact paths, symbols and error messages.",
      },
      { role: "user", content: transcript },
    ],
    { session_id: sessionId, max_tokens: 4000, signal },
  );

  const summary: Message = {
    role: "user",
    content: `[Context summary of earlier work — the conversation continues below]\n\n${turn.content}`,
  };
  return [summary, ...recent];
}
