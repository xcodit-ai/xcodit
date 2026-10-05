import { classifyCommand, type ToolDef } from "@xcodit/shared";
import type { Tool, TodoItem } from "../types.js";
import { editTool, readTool, writeTool } from "./files.js";
import { globTool, grepTool } from "./search.js";
import { bashTool } from "./bash.js";
import { listTool } from "./list.js";
import { patchTool } from "./patch.js";
import { diagnosticsTool } from "./diagnostics.js";
import { skillTool } from "./skill.js";
import { makeTodoTool } from "./todo.js";
import { makeAskTool, type AskUser } from "./ask.js";
import { webFetchTool, makeWebSearchTool, type SearchBackend } from "./web.js";

/**
 * The tools every specialist can reach without help. Kept deliberately small:
 * a model given fifty tools uses them worse than one given ten.
 */
export const CORE_TOOLS: Tool[] = [
  readTool, editTool, writeTool, patchTool,
  bashTool, grepTool, globTool, listTool,
  diagnosticsTool, skillTool, webFetchTool,
];

/**
 * bash that refuses anything but read-only commands (planner, explore
 * subagents). It judges with the same classifier as the permission policy, so
 * the two can never disagree about what "read-only" means.
 */
export const bashReadOnlyTool: Tool = {
  ...bashTool,
  description: "Run a read-only shell command (ls, cat, git status/log/diff, ...). Commands that change state are rejected in this mode.",
  risk: () => "read",
  async execute(args, ctx) {
    if (classifyCommand(args.command) !== "read") {
      return { content: `Rejected: "${args.command}" would change state; only read-only commands are allowed here.`, isError: true };
    }
    return bashTool.execute(args, ctx);
  },
};

export const READ_ONLY_TOOLS: Tool[] = [readTool, grepTool, globTool, listTool, bashReadOnlyTool, diagnosticsTool, skillTool, webFetchTool];

export interface SessionTools {
  onTodos: (todos: TodoItem[]) => void;
  ask: AskUser;
  search: SearchBackend;
}

/** Tools that need to talk back to the session: the todo list, questions, search. */
export function sessionTools(s: SessionTools): Tool[] {
  return [makeTodoTool(s.onTodos), makeAskTool(s.ask), makeWebSearchTool(s.search)];
}

export function toolDefs(tools: Tool[]): ToolDef[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export { classifyCommand } from "@xcodit/shared";
export { detectShell } from "./bash.js";
export { listTool, patchTool, diagnosticsTool, skillTool, webFetchTool };
export { htmlToText } from "./web.js";
export { parseDiagnostics } from "./diagnostics.js";
export { discoverSkills } from "./skill.js";
export type { AskUser, SearchBackend };
