import { z } from "zod";
import type { Tool, TodoItem } from "../types.js";

/**
 * Models have been trained on several todo tools with different field names:
 * `text` or `content`, `active` or `in_progress`, `done` or `completed`. It is
 * cheaper to accept all of them than to spend a turn correcting the model.
 */
const Item = z
  .object({
    text: z.string().min(1).optional(),
    content: z.string().min(1).optional(),
    task: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    status: z.string().optional(),
    state: z.string().optional(),
  })
  .passthrough()
  .transform((raw, ctx) => {
    const text = (raw.text ?? raw.content ?? raw.task ?? raw.title ?? "").trim();
    if (!text) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "each item needs text" });
      return z.NEVER;
    }
    return { text, status: normalize(raw.status ?? raw.state) };
  });

function normalize(status: string | undefined): TodoItem["status"] {
  const s = (status ?? "").toLowerCase().replace(/[\s-]/g, "_");
  if (s === "completed" || s === "complete" || s === "done" || s === "finished") return "done";
  if (s === "in_progress" || s === "active" || s === "doing" || s === "current" || s === "started") return "active";
  return "pending";
}

const Args = z.object({
  todos: z.array(Item).max(20).describe("The whole list, in order; it replaces the previous one"),
});

const GLYPH: Record<TodoItem["status"], string> = { done: "[x]", active: "[>]", pending: "[ ]" };

/**
 * The model's own task list. It replaces the list wholesale each time, which
 * is easier to keep consistent than incremental edits, and the UI renders it
 * as a live checklist so the reader can see the shape of the work.
 */
export function makeTodoTool(onChange: (todos: TodoItem[]) => void): Tool<z.infer<typeof Args>> {
  return {
    name: "todo_write",
    description:
      "Record the plan for a multi-step task as a checklist, and update it as you go. Send the whole list every time; it replaces the previous one. Each item is { text, status } where status is pending, active or done. Mark exactly one item active while you work on it and done as soon as it is finished. Use it for work with three or more steps, and skip it for single edits.",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The complete list, in order",
          items: {
            type: "object",
            properties: {
              text: { type: "string", description: "What the step is" },
              status: { type: "string", enum: ["pending", "active", "done"] },
            },
            required: ["text", "status"],
          },
        },
      },
      required: ["todos"],
    },
    parse: (raw) => Args.parse(raw),
    risk: () => "read",
    summary: (a) => {
      const done = a.todos.filter((t) => t.status === "done").length;
      return `todo ${done}/${a.todos.length}`;
    },
    async execute(a) {
      const todos: TodoItem[] = a.todos.map((t) => ({ text: t.text, status: t.status }));
      const active = todos.filter((t) => t.status === "active");
      onChange(todos);
      const listing = todos.map((t) => `${GLYPH[t.status]} ${t.text}`).join("\n");
      const note = active.length > 1 ? "\n\nKeep one item active at a time." : "";
      return { content: `${listing}${note}` };
    },
  };
}
