#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as tls from "node:tls";
import { ROLES, SPECIALISTS, type Role } from "@xcodit/shared";
import { SessionStore, type PermissionMode } from "@xcodit/agent";
import { ApiError, gatewayFor, getMe, getPolicy, pollDeviceToken, requestDeviceCode } from "./api.js";
import { DEFAULT_SERVER, clearCredentials, loadUiConfig, requireCredentials, saveCredentials } from "./config.js";
import { G, detectCaps, roleGlyph, setTheme, type ThemeName } from "./tui/theme.js";
import { interactive, runTask } from "./repl.js";
import { startTui } from "./tui/index.js";
import { VERSION } from "./tui/banner.js";

// Trust the operating system's certificates as well as Node's bundled set, as a
// browser does. A dev machine serves api.xcodit.dev through Caddy's local CA,
// and corporate proxies re-sign traffic the same way. Older Node 22 releases
// lack the API and keep the bundled set.
if (typeof tls.setDefaultCACertificates === "function" && typeof tls.getCACertificates === "function") {
  try {
    tls.setDefaultCACertificates([...new Set([...tls.getCACertificates("default"), ...tls.getCACertificates("system")])]);
  } catch {
    // An unreadable system store leaves the bundled set in place.
  }
}

const USAGE = `xcodit ${VERSION} — coding agent

  xcodit                          Interactive session in the current directory
  xcodit run TASK                 Run one task non-interactively and exit
  xcodit resume ID                Continue an earlier session
  xcodit sessions                 List saved sessions

  xcodit login [--server URL]     Connect this machine to your xcodit account
  xcodit logout                   Forget stored credentials
  xcodit whoami                   Show account, plan and usage this month
  xcodit policy                   Show the specialist models on your plan
  xcodit ask [--role ROLE] TEXT   One question, no tools

Options for interactive/run/resume:
  --mode ask|auto-edit|full-auto  What may run without confirmation (default ask)
  --cwd DIR                       Project directory (default current)
  --plan                          Plan with the planner model before implementing
  --no-verify                     Skip the project's checks after changes
  --no-review                     Skip the cross-model review
  --plain                         Line-mode REPL instead of the full-screen UI
  --theme dark|light              Color theme (default: saved preference, else dark)
  --demo                          Play a scripted session that showcases the UI
`;

function openBrowser(url: string) {
  const cmd =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] :
    process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd[0] as string, cmd[1] as string[], { stdio: "ignore", detached: true }).unref();
  } catch { /* user can open manually */ }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

function boolFlag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

/** Theme resolution: flag > saved config > dark. Applied before anything renders. */
function applyTheme(args: string[]): ThemeName {
  const flagged = flag(args, "--theme");
  const saved = loadUiConfig().theme;
  const name: ThemeName = flagged === "light" || flagged === "dark" ? flagged : saved === "light" ? "light" : "dark";
  setTheme(name, detectCaps());
  return name;
}

function agentOptions(args: string[]) {
  const theme = applyTheme(args);
  const demo = boolFlag(args, "--demo");
  const mode = (flag(args, "--mode") ?? "ask") as PermissionMode;
  if (!["ask", "auto-edit", "full-auto"].includes(mode)) { console.error(`Unknown mode "${mode}"`); process.exit(1); }
  const cwd = flag(args, "--cwd") ?? process.cwd();
  const plan = boolFlag(args, "--plan");
  const verify = !boolFlag(args, "--no-verify");
  const review = !boolFlag(args, "--no-review");
  const plain = boolFlag(args, "--plain") || !process.stdout.isTTY || !process.stdin.isTTY;
  // The demo never calls the gateway, so it needs no credentials.
  const creds = demo ? { server: "", token: "" } : requireCredentials();
  return { creds, cwd, mode, plan, verify, review, plain: plain && !demo, theme, demo };
}

/** Full-screen UI on a terminal; the line REPL when piped or with --plain. */
async function session(o: ReturnType<typeof agentOptions>, resume?: string) {
  const { plain, ...rest } = o;
  // The demo needs a terminal for its animation; piped, it prints the session once.
  if (rest.demo && !process.stdin.isTTY) {
    const { renderDemoPlain } = await import("./tui/demo.js");
    console.log(await renderDemoPlain(Math.min(100, (process.stdout.columns || 80) - 1)));
    return;
  }
  return plain ? interactive({ ...rest, resume }) : startTui({ ...rest, resume });
}

async function login(args: string[]) {
  const server = (flag(args, "--server") ?? DEFAULT_SERVER).replace(/\/$/, "");
  const code = await requestDeviceCode(server);
  console.log(`\nOpen ${code.verification_uri_complete}`);
  console.log(`and confirm the code:  ${code.user_code}\n`);
  openBrowser(code.verification_uri_complete);

  const deadline = Date.now() + code.expires_in * 1000;
  process.stdout.write("Waiting for approval");
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, code.interval * 1000));
    const res = await pollDeviceToken(server, code.device_code);
    if (res.status === "approved") {
      saveCredentials({ server, token: res.token });
      const me = await getMe({ server, token: res.token });
      console.log(`\nLogged in as ${me.email} (${me.tier} plan).`);
      return;
    }
    if (res.status === "denied") { console.log("\nDenied in browser."); process.exit(1); }
    if (res.status === "expired") break;
    process.stdout.write(".");
  }
  console.log("\nCode expired. Run `xcodit login` again.");
  process.exit(1);
}

async function whoami() {
  const me = await getMe(requireCredentials());
  const allowance = me.allowance_usd === null ? "unlimited" : `$${me.allowance_usd.toFixed(2)}`;
  console.log(`${me.email}${me.name ? ` (${me.name})` : ""}`);
  console.log(`plan:   ${me.tier}`);
  console.log(`usage:  $${me.usage_this_month_usd.toFixed(4)} of ${allowance} this month`);
}

async function policy() {
  const p = await getPolicy(requireCredentials());
  console.log(`specialists ${G.sep} routing v${p.version} ${G.sep} ${p.tier} plan\n`);
  for (const role of ROLES) {
    const s = SPECIALISTS[role];
    const model = p.roles[role]?.models[0] ?? s.model;
    console.log(`  ${roleGlyph(role)} ${s.label.padEnd(9)} ${model.padEnd(13)} ${s.tagline}`);
  }
}

async function ask(args: string[]) {
  const roleArg = flag(args, "--role") ?? "implementer";
  if (!(ROLES as readonly string[]).includes(roleArg)) {
    console.error(`Unknown role "${roleArg}". Roles: ${ROLES.join(", ")}`);
    process.exit(1);
  }
  const text = args.join(" ").trim();
  if (!text) { console.error("Nothing to ask."); process.exit(1); }

  const gateway = gatewayFor(requireCredentials());
  const started = Date.now();
  const turn = await gateway.chat(
    roleArg as Role,
    [{ role: "user", content: text }],
    { session_id: randomUUID() },
    { onText: (t) => process.stdout.write(t) },
  );
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const u = turn.usage;
  console.log(`\n\n— ${turn.model ?? "?"} ${G.sep} ${u?.prompt_tokens ?? "?"}→${u?.completion_tokens ?? "?"} tokens ${G.sep} $${(u?.cost ?? 0).toFixed(5)} ${G.sep} ${secs}s`);
}

async function sessions() {
  const list = await SessionStore.list();
  if (!list.length) { console.log("No sessions yet."); return; }
  for (const s of list.slice(0, 30)) {
    console.log(`${s.id}  ${s.updatedAt.slice(0, 16).replace("T", " ")}  ${String(s.messages).padStart(4)} msgs  ${s.title ?? ""}\n          ${s.cwd}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--") argv.shift(); // pnpm forwards a literal "--"
  setTheme(loadUiConfig().theme === "light" ? "light" : "dark", detectCaps());
  const [cmd, ...args] = argv;
  try {
    switch (cmd) {
      case undefined: return await session(agentOptions(args));
      case "run": { const o = agentOptions(args); process.exit(await runTask(o, args.join(" ").trim())); }
      case "resume": { const id = args.shift(); if (!id) { console.error("resume needs a session id"); process.exit(1); } return await session(agentOptions(args), id); }
      case "sessions": return await sessions();
      case "login": return await login(args);
      case "logout": clearCredentials(); console.log("Logged out."); return;
      case "whoami": return await whoami();
      case "policy": return await policy();
      case "ask": return await ask(args);
      case "help": case "--help": case "-h": console.log(USAGE); return;
      case "--version": case "-v": console.log(`xcodit ${VERSION}`); return;
      default:
        if (cmd.startsWith("--")) return await session(agentOptions(argv));
        console.log(USAGE); process.exit(1);
    }
  } catch (err) {
    console.error(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

await main();
