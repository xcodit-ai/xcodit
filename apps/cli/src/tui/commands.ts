export interface Command {
  name: string;
  args?: string;
  help: string;
}

/** The slash surface, shared by autocomplete and /help. */
export const COMMANDS: Command[] = [
  { name: "/plan", args: "TASK", help: "plan the change first, then implement after you approve" },
  { name: "/mode", args: "ask|auto-edit|full-auto", help: "what may run without asking" },
  { name: "/verify", args: "on|off", help: "run the project's checks after changes" },
  { name: "/review", args: "on|off", help: "independent review of the diff" },
  { name: "/undo", help: "revert the files changed by the last message" },
  { name: "/cost", help: "tokens, cache and cost so far" },
  { name: "/model", help: "the specialists on your plan" },
  { name: "/theme", args: "dark|light", help: "switch theme and remember it" },
  { name: "/mouse", args: "on|off", help: "on: click blocks open. off: drag selects text" },
  { name: "/new", help: "start a fresh session here" },
  { name: "/clear", help: "clear the transcript" },
  { name: "/help", help: "this list" },
  { name: "/exit", help: "quit" },
];

export const commandNames = COMMANDS.map((c) => c.name);
