import { stdout } from "node:process";
import { Agent, GatewayError, SessionStore, type PermissionMode } from "@xcodit/agent";
import { gatewayFor } from "./api.js";
import type { Credentials } from "./config.js";
import { approvePlan, askPermission, closeReadline, createRenderer, cyan, dim, printBanner, readline, red } from "./ui.js";
import { G } from "./tui/theme.js";

const HELP = `
  /plan TASK                        plan with the planner model first, then implement after you approve
  /mode [ask|auto-edit|full-auto]   show or change what runs without asking
  /verify [on|off]                  run the project's checks after changes (default on)
  /review [on|off]                  cross-model review of the diff after checks (default on)
  /undo                             revert the files changed by the last message
  /cost                             tokens and cost so far in this session
  /new                              start a fresh session in this directory
  /help                             this list
  /exit                             quit (Ctrl+C twice also works)
`;

export interface ReplOptions {
  creds: Credentials;
  cwd: string;
  mode: PermissionMode;
  verify: boolean;
  review: boolean;
  plan: boolean;
  resume?: string;
}

async function makeAgent(opts: ReplOptions, session: SessionStore, remember: Set<string>, interactivePlan: boolean) {
  const renderer = createRenderer();
  return new Agent({
    gateway: gatewayFor(opts.creds),
    cwd: opts.cwd,
    mode: opts.mode,
    session,
    verify: opts.verify,
    review: opts.review,
    askPermission: (req) => askPermission(req, remember),
    approvePlan: interactivePlan ? approvePlan : undefined,
    onEvent: (e) => renderer.render(e),
  });
}

type RunOutcome = "ok" | "cancelled" | "error" | "unauthorized";

/** Runs one message with Ctrl+C cancelling the run instead of the process. */
async function runOnce(agent: Agent, text: string, plan: boolean): Promise<RunOutcome> {
  const ac = new AbortController();
  let interrupts = 0;
  const onSigint = () => {
    interrupts++;
    if (interrupts === 1) { ac.abort(); stdout.write(dim("\n  (cancelling — press Ctrl+C again to quit)\n")); }
    else process.exit(130);
  };
  process.on("SIGINT", onSigint);
  readline().on("SIGINT", onSigint);
  try {
    await agent.run(text, { plan, signal: ac.signal });
    return "ok";
  } catch (err) {
    if (ac.signal.aborted) { stdout.write(dim("  cancelled\n")); return "cancelled"; }
    const cause = (err as any)?.cause?.code ? ` (${(err as any).cause.code})` : "";
    stdout.write(red(`  ${err instanceof Error ? err.message : String(err)}${cause}\n`));
    return err instanceof GatewayError && err.status === 401 ? "unauthorized" : "error";
  } finally {
    process.off("SIGINT", onSigint);
    readline().off("SIGINT", onSigint);
  }
}

function toggle(current: boolean, arg: string | undefined): boolean {
  if (arg === "on") return true;
  if (arg === "off") return false;
  return current;
}

export async function interactive(opts: ReplOptions): Promise<void> {
  let session = opts.resume ? await SessionStore.load(opts.resume) : null;
  if (opts.resume && !session) { console.error(`No session ${opts.resume}. See: xcodit sessions`); process.exit(1); }
  if (session && session.meta.cwd !== opts.cwd) {
    stdout.write(dim(`  note: session was recorded in ${session.meta.cwd}\n`));
  }
  session ??= await SessionStore.create(opts.cwd);
  const remember = new Set<string>();
  let agent = await makeAgent(opts, session, remember, true);

  await printBanner(opts.cwd, agent.tools.length);
  stdout.write(dim(`  session ${session.meta.id} ${G.sep} ${opts.mode} ${G.sep} verify ${opts.verify ? "on" : "off"} ${G.sep} review ${opts.review ? "on" : "off"} ${G.sep} /help for commands\n\n`));
  if (session.messages.length) stdout.write(dim(`  resumed ${session.messages.length} messages\n\n`));

  for (;;) {
    let line: string;
    try {
      line = (await readline().question(cyan(`${G.promptIdle} `))).trim();
    } catch {
      break; // stdin closed
    }
    if (!line) continue;

    let plan = opts.plan;
    if (line.startsWith("/")) {
      const [cmd, ...rest] = line.slice(1).split(/\s+/);
      switch (cmd) {
        case "exit": case "quit": case "q":
          closeReadline();
          return;
        case "help":
          stdout.write(HELP + "\n");
          continue;
        case "plan":
          if (!rest.length) { stdout.write("  usage: /plan TASK\n"); continue; }
          line = rest.join(" ");
          plan = true;
          break;
        case "mode": {
          const m = rest[0] as PermissionMode | undefined;
          if (m && ["ask", "auto-edit", "full-auto"].includes(m)) { opts.mode = m; agent.setMode(m); }
          stdout.write(`  mode: ${opts.mode}\n`);
          continue;
        }
        case "verify":
          opts.verify = toggle(opts.verify, rest[0]); agent.setOption("verify", opts.verify);
          stdout.write(`  verify: ${opts.verify ? "on" : "off"}\n`);
          continue;
        case "review":
          opts.review = toggle(opts.review, rest[0]); agent.setOption("review", opts.review);
          stdout.write(`  review: ${opts.review ? "on" : "off"}\n`);
          continue;
        case "undo": {
          const restored = await agent.undo();
          stdout.write(restored.length ? restored.map((r) => `  ${r}`).join("\n") + "\n" : "  nothing to undo\n");
          if (restored.length) stdout.write(dim("  (shell side effects are not reverted)\n"));
          continue;
        }
        case "cost": {
          const t = agent.totals;
          stdout.write(`  ${t.turns} model turns ${G.sep} ${t.prompt_tokens.toLocaleString()} in (${t.cached_tokens.toLocaleString()} cached) / ${t.completion_tokens.toLocaleString()} out ${G.sep} $${t.cost.toFixed(4)}\n`);
          continue;
        }
        case "new":
          session = await SessionStore.create(opts.cwd);
          agent = await makeAgent(opts, session, remember, true);
          stdout.write(dim(`  new session ${session.meta.id}\n`));
          continue;
        default:
          stdout.write(`  unknown command /${cmd}\n${HELP}\n`);
          continue;
      }
    }

    if ((await runOnce(agent, line, plan)) === "unauthorized") break;
    const t = agent.totals;
    stdout.write(dim(`  ${t.turns} turns ${G.sep} $${t.cost.toFixed(4)} total\n\n`));
  }
  closeReadline();
}

/** Non-interactive: one task, exit code reflects success. Plans auto-proceed. */
export async function runTask(opts: ReplOptions, task: string): Promise<number> {
  const session = await SessionStore.create(opts.cwd);
  const remember = new Set<string>();
  const agent = await makeAgent(opts, session, remember, false);
  const outcome = await runOnce(agent, task, opts.plan);
  closeReadline();
  const t = agent.totals;
  stdout.write(dim(`\n  session ${session.meta.id} ${G.sep} ${t.turns} turns ${G.sep} ${t.cached_tokens.toLocaleString()} cached tokens ${G.sep} $${t.cost.toFixed(4)}\n`));
  return outcome === "ok" ? 0 : 1;
}
