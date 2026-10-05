import type { Message, Role, ToolDef } from "@xcodit/shared";

export type { Message, Role, ToolDef };

/** How much the agent may do without asking. */
export type PermissionMode = "ask" | "auto-edit" | "full-auto";

export type CommandRisk = "read" | "mutate" | "dangerous";

export interface ToolContext {
  cwd: string;
  mode: PermissionMode;
  /** Called before a mutating/dangerous action. Resolves false to refuse. */
  askPermission: (req: PermissionRequest) => Promise<boolean>;
  /** Called before a file is modified so the turn can be undone. */
  snapshotFile: (absPath: string) => Promise<void>;
  signal?: AbortSignal;
}

export interface PermissionRequest {
  tool: string;
  risk: CommandRisk;
  /** One-line, human-readable description of the action. */
  summary: string;
  /** Optional detail (diff preview, full command). */
  detail?: string;
  /** Presentation only: lets a UI render a real diff instead of parsing `detail`. */
  before?: string;
  after?: string;
  /** File the action targets, so a UI can pick a syntax mode. */
  path?: string;
  /** The server's explanation, shown with the prompt. */
  reason?: string;
  /** Whether "always allow this tool" may be offered. */
  allowRemember?: boolean;
}

export interface TodoItem {
  text: string;
  status: "pending" | "active" | "done";
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface Tool<A = any> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Parse and validate raw JSON arguments from the model. */
  parse: (raw: unknown) => A;
  /**
   * Advisory only. The server rules on permissions; this is kept so a tool can
   * describe itself, and so the read-only shell wrapper can mark its intent.
   */
  risk: (args: A, ctx: ToolContext) => CommandRisk;
  summary: (args: A) => string;
  execute: (args: A, ctx: ToolContext) => Promise<ToolResult>;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  cost: number;
}

export type Phase = "plan" | "implement" | "verify" | "repair" | "review" | "fix";

export type AgentEvent =
  | { type: "phase"; phase: Phase; role: Role; detail?: string }
  | { type: "text_delta"; text: string; depth: number }
  | { type: "reasoning_delta"; text: string; depth: number }
  | { type: "tool_start"; id: string; name: string; summary: string; depth: number }
  | { type: "tool_end"; id: string; name: string; result: ToolResult; ms: number; depth: number }
  | { type: "tool_denied"; id: string; name: string; depth: number }
  | { type: "model_done"; model?: string; usage?: Usage; role: Role; depth: number }
  | { type: "subagent_start"; id: string; role: Role; task: string; depth: number }
  | { type: "subagent_end"; id: string; role: Role; turns: number; cost: number; depth: number }
  | { type: "compaction"; before: number; after: number }
  | { type: "verify_start"; commands: string[] }
  | { type: "verify_end"; passed: boolean; report: string; attempt: number }
  | { type: "review_start"; diffChars: number }
  | { type: "review_end"; verdict: "approve" | "request_changes"; summary: string; issues: { severity: string; file?: string; line?: number; description: string }[]; model?: string; cost: number }
  | { type: "plan_ready"; plan: string }
  | { type: "todos"; items: TodoItem[] }
  | { type: "turn_end"; turns: number }
  | { type: "error"; message: string };
