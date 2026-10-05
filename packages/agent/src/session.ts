import { appendFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Message } from "@xcodit/shared";

export interface SessionMeta {
  id: string;
  cwd: string;
  createdAt: string;
  title?: string;
}

export interface SessionSummary extends SessionMeta {
  updatedAt: string;
  messages: number;
}

const dir = join(homedir(), ".xcodit", "sessions");

/** The result recorded for a tool call that never ran because the turn was cancelled. */
export const CANCELLED_TOOL_RESULT = "Cancelled by the user before it ran.";

/**
 * An assistant turn that calls tools must be followed by one result per call,
 * or the next request is rejected. A session cut off mid-turn — by a crash, or
 * an interrupt in a version that did not record cancellations — gets the
 * missing results filled in so it can be resumed.
 */
export function answerDanglingToolCalls(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    out.push(m);
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;
    const answered = new Set<string>();
    for (let next = messages[i + 1]; next?.role === "tool"; next = messages[i + 1]) {
      answered.add(next.tool_call_id);
      out.push(next);
      i++;
    }
    for (const call of m.tool_calls) {
      if (!answered.has(call.id)) out.push({ role: "tool", tool_call_id: call.id, content: CANCELLED_TOOL_RESULT });
    }
  }
  return out;
}

/** Append-only JSONL: first line is meta, then one message per line. */
export class SessionStore {
  private constructor(public meta: SessionMeta, public messages: Message[]) {}

  static async create(cwd: string): Promise<SessionStore> {
    await mkdir(dir, { recursive: true });
    const meta: SessionMeta = { id: randomUUID().slice(0, 8), cwd, createdAt: new Date().toISOString() };
    await appendFile(join(dir, `${meta.id}.jsonl`), JSON.stringify({ meta }) + "\n");
    return new SessionStore(meta, []);
  }

  static async load(id: string): Promise<SessionStore | null> {
    const text = await readFile(join(dir, `${id}.jsonl`), "utf8").catch(() => null);
    if (!text) return null;
    const [first, ...rest] = text.split("\n").filter(Boolean);
    const meta = JSON.parse(first!).meta as SessionMeta;
    const messages: Message[] = [];
    for (const line of rest) {
      const rec = JSON.parse(line);
      if (rec.message) messages.push(rec.message);
      else if (rec.title) meta.title = rec.title;
    }
    return new SessionStore(meta, answerDanglingToolCalls(messages));
  }

  static async list(): Promise<SessionSummary[]> {
    const names = await readdir(dir).catch(() => [] as string[]);
    const out: SessionSummary[] = [];
    for (const n of names.filter((n) => n.endsWith(".jsonl"))) {
      const s = await SessionStore.load(n.replace(/\.jsonl$/, ""));
      if (!s) continue;
      const st = await stat(join(dir, n));
      out.push({ ...s.meta, updatedAt: st.mtime.toISOString(), messages: s.messages.length });
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async append(message: Message): Promise<void> {
    this.messages.push(message);
    await appendFile(join(dir, `${this.meta.id}.jsonl`), JSON.stringify({ message }) + "\n");
  }

  async setTitle(title: string): Promise<void> {
    this.meta.title = title;
    await appendFile(join(dir, `${this.meta.id}.jsonl`), JSON.stringify({ title }) + "\n");
  }

  /** Replace in-memory history (after compaction); the file keeps the full log. */
  replaceMessages(messages: Message[]): void {
    this.messages = messages;
  }
}
