export { Agent, type AgentOptions, type RunOptions } from "./agent.js";
export { GatewayClient, GatewayError, type GatewayCredentials, type AssistantTurn } from "./gateway.js";
export { SessionStore, type SessionMeta, type SessionSummary } from "./session.js";
export { SnapshotStack } from "./snapshot.js";
export { buildSystemPrompt, loadProjectInstructions } from "./prompt.js";
export {
  CORE_TOOLS, READ_ONLY_TOOLS, sessionTools, toolDefs, classifyCommand, detectShell,
  listTool, patchTool, diagnosticsTool, skillTool, webFetchTool,
  htmlToText, parseDiagnostics, discoverSkills,
  type AskUser, type SearchBackend,
} from "./tools/index.js";
export { loadProjectConfig, type ProjectConfig } from "./config.js";
export { discoverChecks, runChecks, type VerifyResult } from "./verify.js";
export { reviewDiff, diffForFiles, type Review, type ReviewIssue } from "./review.js";
export { estimateTokens } from "./compact.js";
export type * from "./types.js";
