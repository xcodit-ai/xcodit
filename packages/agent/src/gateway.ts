import {
  CLIENT_VERSION_HEADER,
  PermissionVerdictSchema,
  type ChatRequest,
  type Message,
  type PermissionCheck,
  type PermissionVerdict,
  type Role,
  type ToolDef,
} from "@xcodit/shared";
import type { Usage } from "./types.js";

export interface GatewayCredentials {
  server: string;
  token: string;
  /** Sent with every request so the server can refuse a release it no longer supports. */
  clientVersion?: string;
}

export class GatewayError extends Error {
  constructor(public status: number, public body: unknown) {
    super(GatewayError.describe(status, body));
  }
  static describe(status: number, body: unknown): string {
    const err = (body as any)?.error;
    if (err?.code === "quota_exceeded") return `Quota exceeded: ${err.message}`;
    if (err?.code === "client_outdated" || err?.code === "rate_limited") return err.message;
    if (status === 401) return "Session invalid. Run: xcodit login";
    if (err?.code === "upstream_error") return `Model error (${err.status}): ${err.message ?? "try again"}`;
    return `HTTP ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`;
  }
}

export interface Citation {
  url: string;
  title?: string;
}

export interface AssistantTurn {
  content: string;
  citations?: Citation[];
  reasoning: string;
  tool_calls: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  model?: string;
  usage?: Usage;
  finish_reason?: string;
}

export interface StreamCallbacks {
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
}

/** Talks to the xcodit server; the server picks the model and rules on permissions. */
export class GatewayClient {
  constructor(private creds: GatewayCredentials) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Bearer ${this.creds.token}`, "Content-Type": "application/json" };
    if (this.creds.clientVersion) h[CLIENT_VERSION_HEADER] = this.creds.clientVersion;
    return h;
  }

  /**
   * Ask whether a tool call may proceed. The policy lives on the server so a
   * rule can be corrected, or an action forbidden on a plan, without shipping a
   * release. It is not a security boundary: this client runs on the user's
   * machine and enforces the verdict itself. Verdicts are memoised per session
   * because the same command tends to come round again.
   */
  private verdicts = new Map<string, PermissionVerdict>();

  async checkPermission(check: PermissionCheck, signal?: AbortSignal): Promise<PermissionVerdict> {
    const key = `${check.mode}\u0000${check.tool}\u0000${check.command ?? check.path ?? ""}`;
    const cached = this.verdicts.get(key);
    if (cached) return cached;

    const res = await fetch(`${this.creds.server}/v1/permission`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(check),
      signal,
    });
    if (!res.ok) {
      const text = await res.text();
      let parsed: unknown = text;
      try { parsed = JSON.parse(text); } catch { /* keep text */ }
      throw new GatewayError(res.status, parsed);
    }
    const verdict = PermissionVerdictSchema.parse(await res.json());
    this.verdicts.set(key, verdict);
    return verdict;
  }

  async chat(
    role: Role,
    messages: Message[],
    opts: { tools?: ToolDef[]; session_id?: string; max_tokens?: number; signal?: AbortSignal; web?: { max_results?: number } } = {},
    cb: StreamCallbacks = {},
  ): Promise<AssistantTurn> {
    const body: ChatRequest = {
      role,
      messages,
      tools: opts.tools,
      stream: true,
      session_id: opts.session_id,
      max_tokens: opts.max_tokens,
      web: opts.web,
    };
    const res = await fetch(`${this.creds.server}/v1/chat`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text();
      let parsed: unknown = text;
      try { parsed = JSON.parse(text); } catch { /* keep text */ }
      throw new GatewayError(res.status, parsed);
    }

    const turn: AssistantTurn = { content: "", reasoning: "", tool_calls: [] };
    // Tool-call deltas arrive keyed by index; arguments stream as fragments.
    const partial = new Map<number, AssistantTurn["tool_calls"][number]>();

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        let chunk: any;
        try { chunk = JSON.parse(payload); } catch { continue; }
        if (chunk.error) throw new GatewayError(502, { error: { code: "upstream_error", status: chunk.error.code, detail: chunk.error } });
        if (chunk.model) turn.model = chunk.model;
        if (chunk.usage) {
          turn.usage = {
            prompt_tokens: chunk.usage.prompt_tokens ?? 0,
            completion_tokens: chunk.usage.completion_tokens ?? 0,
            cached_tokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
            cost: chunk.usage.cost ?? 0,
          };
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        for (const a of choice.message?.annotations ?? choice.delta?.annotations ?? []) {
          if (a?.type !== "url_citation" || !a.url_citation?.url) continue;
          turn.citations ??= [];
          if (!turn.citations.some((c) => c.url === a.url_citation.url)) {
            turn.citations.push({ url: a.url_citation.url, title: a.url_citation.title });
          }
        }
        if (choice.finish_reason) turn.finish_reason = choice.finish_reason;
        const delta = choice.delta ?? {};
        if (typeof delta.content === "string" && delta.content) {
          turn.content += delta.content;
          cb.onText?.(delta.content);
        }
        if (typeof delta.reasoning === "string" && delta.reasoning) {
          turn.reasoning += delta.reasoning;
          cb.onReasoning?.(delta.reasoning);
        }
        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          let cur = partial.get(idx);
          if (!cur) {
            cur = { id: tc.id ?? `call_${idx}`, type: "function", function: { name: "", arguments: "" } };
            partial.set(idx, cur);
          }
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.function.name += tc.function.name;
          if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
        }
      }
    }
    turn.tool_calls = [...partial.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    return turn;
  }
}
