import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@xcodit/shared";
import { Agent } from "../agent.js";
import type { AssistantTurn, GatewayClient } from "../gateway.js";
import { CANCELLED_TOOL_RESULT, answerDanglingToolCalls, type SessionStore } from "../session.js";

/**
 * A conversation in which a tool call has no result is rejected by the model
 * provider, so an interrupt must never leave one behind.
 */

const pass: string[] = [];
const ok = (n: string) => pass.push(n);

const call = (id: string, name: string, args: object) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });

const root = await mkdtemp(join(tmpdir(), "xcodit-agent-"));
await writeFile(join(root, "a.txt"), "hello\n");

try {
  // ---- an interrupt between two tool calls ------------------------------------
  const ac = new AbortController();
  const turn: AssistantTurn = {
    content: "",
    reasoning: "",
    tool_calls: [call("c1", "list", {}), call("c2", "read_file", { path: "a.txt" })],
  };
  const gateway = {
    chat: async () => turn,
    checkPermission: async () => ({ decision: "allow", risk: "read", allowRemember: false }),
  } as unknown as GatewayClient;
  const messages: Message[] = [];
  const session = {
    meta: { id: "test", cwd: root, createdAt: new Date().toISOString(), title: "t" },
    messages,
    append: async (m: Message) => { messages.push(m); },
    setTitle: async () => {},
    replaceMessages: () => {},
  } as unknown as SessionStore;

  const agent = new Agent({
    gateway,
    cwd: root,
    mode: "ask",
    session,
    askPermission: async () => true,
    // The user presses Ctrl+C while the first tool runs.
    onEvent: (e) => { if (e.type === "tool_end" && e.id === "c1") ac.abort(); },
    verify: false,
    review: false,
  });
  await agent.run("look around", { signal: ac.signal });

  const results = messages.filter((m): m is Extract<Message, { role: "tool" }> => m.role === "tool");
  assert.deepEqual(results.map((r) => r.tool_call_id), ["c1", "c2"], "both calls are answered, in order");
  assert.notEqual(results[0]!.content, CANCELLED_TOOL_RESULT, "the call that ran keeps its output");
  assert.equal(results[1]!.content, CANCELLED_TOOL_RESULT, "the call that never ran says so");
  ok("an interrupt answers every outstanding tool call");

  // ---- a session saved by an older version, cut off mid-turn -------------------
  const broken: Message[] = [
    { role: "user", content: "go" },
    { role: "assistant", content: null, tool_calls: [call("x1", "list", {}), call("x2", "list", {}), call("x3", "list", {})] },
    { role: "tool", tool_call_id: "x1", content: "ran" },
    { role: "user", content: "next question" },
  ];
  const repaired = answerDanglingToolCalls(broken);
  assert.deepEqual(
    repaired.map((m) => (m.role === "tool" ? `tool:${m.tool_call_id}` : m.role)),
    ["user", "assistant", "tool:x1", "tool:x2", "tool:x3", "user"],
    "missing results go straight after the ones that exist",
  );
  assert.deepEqual(answerDanglingToolCalls(repaired), repaired, "a complete conversation is left alone");
  ok("a resumed session gets its missing tool results filled in");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(pass.map((p) => "ok   " + p).join("\n"));
