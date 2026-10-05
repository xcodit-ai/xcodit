import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdin, useStdout } from "ink";
import { Agent, GatewayError, SessionStore, discoverChecks, estimateTokens, type AgentEvent, type PermissionMode, type PermissionRequest } from "@xcodit/agent";
import type { Credentials } from "../config.js";
import { gatewayFor } from "../api.js";
import { applyEvent, itemToLines, renderTranscript, toggleExpand, toggleExpandAll, toggleExpandAt, wrap, type Item, type Line } from "./transcript.js";
import { gatherFacts } from "./banner.js";
import { C, G, PHASE_LABEL, caps, col, roleColor, roleGlyph, roleModel } from "./theme.js";
import { segBg, segColor } from "./box.js";
import { renderDiff, diffStat, SIDE_BY_SIDE_MIN_COLS } from "./diff.js";
import { highlightLine, languageOf } from "./highlight.js";
import { HotKeys, Rail, TopBar, railWidth } from "./Chrome.js";
import { type Beat } from "./theme.js";
import { MODEL_FAMILY, ROLES, SPECIALISTS } from "@xcodit/shared";
import { CommandMenu, HistorySearch, InputBox, MENU_ROWS, type PromptState } from "./Input.js";
import { COMMANDS, type Command } from "./commands.js";
import { fuzzyFilter } from "./fuzzy.js";
import { saveUiConfig } from "../config.js";
import { setTheme, themeName } from "./theme.js";
import { DEMO_PROMPT, createDemoAgent, type AgentLike } from "./demo.js";
import { MOUSE_OFF, MOUSE_ON, isMouseReport, parseClicks, parseWheel } from "./mouse.js";

export interface TuiOptions {
  creds: Credentials;
  cwd: string;
  mode: PermissionMode;
  verify: boolean;
  review: boolean;
  plan: boolean;
  resume?: string;
  /** Replay a scripted session instead of talking to the gateway. */
  demo?: boolean;
}

type Dialog =
  | { kind: "permission"; req: PermissionRequest; resolve: (ok: boolean) => void }
  | { kind: "question"; question: string; options?: string[]; resolve: (answer: string) => void }
  | { kind: "plan"; plan: string; resolve: (r: string | null) => void }
  | { kind: "plan-notes"; plan: string; resolve: (r: string | null) => void };

const CONTEXT_BUDGET = 160_000; // matches the engine default

const HELP = [
  ...COMMANDS.map((c) => `${(c.name + (c.args ? " " + c.args : "")).padEnd(30)}${c.help}`),
  "",
  "Enter send · Alt+Enter newline · Tab complete · Ctrl+R history search",
  "↑↓ and the wheel scroll · Ctrl+↑↓ history · o next output, O all · Esc clear",
  "Drag selects text. /mouse on trades that for clicking a block open.",
].join("\n");

export function App({ opts }: { opts: TuiOptions }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [size, setSize] = useState({ cols: stdout.columns || 100, rows: stdout.rows || 30 });
  useEffect(() => {
    const onResize = () => setSize({ cols: stdout.columns || 100, rows: stdout.rows || 30 });
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);

  // ---- agent + session ------------------------------------------------------
  const [session, setSession] = useState<SessionStore | null>(null);
  const [mode, setMode] = useState<PermissionMode>(opts.mode);
  const [verify, setVerify] = useState(opts.verify);
  const [review, setReview] = useState(opts.review);
  const [items, setItems] = useState<Item[]>([]);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<{ phase: string; role: string } | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [tick, setTick] = useState(0);
  const [totals, setTotals] = useState({ turns: 0, cost: 0, cached: 0 });
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [ctxTokens, setCtxTokens] = useState(0);
  const [railOpen, setRailOpen] = useState(true);
  // Off by default so a plain drag selects text; /mouse on trades that for
  // clicking blocks open.
  const [mouse, setMouse] = useState(false);
  const [files, setFiles] = useState<{ name: string; state: "read" | "changed" }[]>([]);
  const [failed, setFailed] = useState(false);
  const [toolCalls, setToolCalls] = useState(0);
  const [ctrlC, setCtrlC] = useState(0);
  const [branch, setBranch] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const agentRef = useRef<AgentLike | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const remember = useRef(new Set<string>());
  const phaseRef = useRef<string | null>(null);
  // tool_end carries no summary, so remember it from tool_start.
  const toolNames = useRef(new Map<string, string>());

  const push = useCallback((it: Item) => setItems((prev) => [...prev, it]), []);
  const runTaskRef = useRef<((text: string, plan: boolean) => Promise<void>) | null>(null);

  const handleEvent = useCallback((e: AgentEvent) => {
    if (e.type === "phase") { phaseRef.current = e.phase; setPhase({ phase: e.phase, role: e.role }); }
    if (e.type === "tool_start") { setActiveTool(e.summary); toolNames.current.set(e.id, e.summary); }
    if (e.type === "tool_end" || e.type === "tool_denied") setActiveTool(null);
    if (e.type === "tool_end") {
      setToolCalls((n) => n + 1);
      // The rail lists what the run touched, taken from the tool summary.
      const summary = toolNames.current.get(e.id) ?? "";
      toolNames.current.delete(e.id);
      const m = e.name === "read_file" || e.name === "edit_file" || e.name === "write_file"
        ? summary.match(/\b([\w./-]+\.[a-z0-9]+)/i)
        : null;
      if (m) {
        const name = m[1]!.split("/").pop()!;
        const state = e.name === "read_file" ? "read" as const : "changed" as const;
        setFiles((prev) => {
          const without = prev.filter((f) => f.name !== name);
          // A file that was written outranks one that was only read.
          const keep = prev.find((f) => f.name === name);
          return [...without, { name, state: keep?.state === "changed" ? "changed" : state }].slice(-8);
        });
      }
    }
    if (e.type === "model_done") {
      const t = agentRef.current?.totals;
      if (t) setTotals({ turns: t.turns, cost: t.cost, cached: t.cached_tokens });
      // Once per model turn, not per render: estimateTokens walks the history.
      const msgs = agentRef.current?.session.messages;
      if (msgs?.length) setCtxTokens(estimateTokens(msgs as Parameters<typeof estimateTokens>[0]));
      else if (t) setCtxTokens(t.prompt_tokens); // demo sessions keep no history
    }
    // The plan streams while planning and is shown once, as a block, when ready.
    if ((e.type === "text_delta" || e.type === "model_done") && phaseRef.current === "plan") return;
    setItems((prev) => applyEvent(prev, e));
  }, []);

  /** In demo mode the dialogs answer themselves after a beat, so it plays alone. */
  const autoAnswer = opts.demo ? 1700 : 0;
  const askPermission = useCallback(
    (req: PermissionRequest) =>
      new Promise<boolean>((resolve) => {
        if (remember.current.has(req.tool) && req.risk !== "dangerous") return resolve(true);
        const done = (ok: boolean) => { setDialog(null); resolve(ok); };
        setDialog({ kind: "permission", req, resolve: done });
        if (autoAnswer) setTimeout(() => done(true), autoAnswer);
      }),
    [autoAnswer],
  );
  const approvePlan = useCallback(
    (plan: string) =>
      new Promise<string | null>((resolve) => {
        const done = (r: string | null) => { setDialog(null); resolve(r); };
        setDialog({ kind: "plan", plan, resolve: done });
        if (autoAnswer) setTimeout(() => done(plan), autoAnswer + 700);
      }),
    [autoAnswer],
  );

  /** The agent asked something; the composer becomes the answer box. */
  const askUser = useCallback(
    (question: string, options?: string[]) =>
      new Promise<string>((resolve) => {
        const done = (answer: string) => { setDialog(null); setInput(""); setCursor(0); resolve(answer); };
        setDialog({ kind: "question", question, options, resolve: done });
        if (autoAnswer) setTimeout(() => done(options?.[0] ?? "yes"), autoAnswer);
      }),
    [autoAnswer],
  );

  const makeAgent = useCallback((s: SessionStore) => {
    if (opts.demo) {
      const demo = createDemoAgent(handleEvent, askPermission, approvePlan);
      agentRef.current = demo;
      return demo;
    }
    const agent = new Agent({
      gateway: gatewayFor(opts.creds),
      cwd: opts.cwd,
      mode,
      session: s,
      verify,
      review,
      askPermission,
      approvePlan,
      askUser,
      onEvent: handleEvent,
    });
    agentRef.current = agent;
    return agent;
    // mode/verify/review are pushed via setters below; the agent reads them live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.creds, opts.cwd]);

  useEffect(() => {
    (async () => {
      let s = opts.resume ? await SessionStore.load(opts.resume) : null;
      if (opts.resume && !s) push({ kind: "error", text: `No session ${opts.resume}. See: xcodit sessions` });
      s ??= await SessionStore.create(opts.cwd);
      setSession(s);
      const agent = makeAgent(s);
      const checks = await discoverChecks(opts.cwd).catch(() => [] as string[]);
      const facts = await gatherFacts(opts.cwd, agent.tools.length, true, {
        theme: `signal-${themeName()}`,
        contextBudget: CONTEXT_BUDGET,
        checks: checks.length,
      });
      setBranch(facts.branch);
      setDirty(facts.dirty);
      const replay: Item[] = [{ kind: "banner", facts }];
      for (const m of s.messages) {
        if (m.role === "user" && typeof m.content === "string") replay.push({ kind: "user", text: m.content.slice(0, 400) });
        if (m.role === "assistant" && m.content) replay.push({ kind: "assistant", text: m.content, done: true });
      }
      if (s.messages.length) replay.push({ kind: "note", text: `resumed ${s.messages.length} messages`, color: C.muted });
      else replay.push({ kind: "note", text: opts.demo ? "demo: replaying a recorded session — Ctrl+C to quit" : "Type a task, or /help for commands. /plan TASK plans first.", color: C.muted });
      setItems(replay);
      if (opts.demo) setTimeout(() => void runTaskRef.current?.(DEMO_PROMPT, false), 900);
    })();
  }, [opts.resume, opts.cwd, makeAgent, push]);

  useEffect(() => { agentRef.current?.setMode(mode); }, [mode]);
  useEffect(() => { agentRef.current?.setOption("verify", verify); }, [verify]);
  useEffect(() => { agentRef.current?.setOption("review", review); }, [review]);

  // Spinner + elapsed while running.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setTick((x) => x + 1), 80);
    return () => clearInterval(t);
  }, [running]);

  // ---- input ----------------------------------------------------------------
  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [scroll, setScroll] = useState(0); // lines from the bottom; 0 = follow
  // Scrolling has to clamp as it happens. Clamping only at render lets an
  // over-scroll build an invisible surplus that later has to be burned off,
  // which reads as the transcript being stuck.
  const maxScrollRef = useRef(0);
  const viewRef = useRef<{ firstVisible: number; top: number; owners: number[] }>({ firstVisible: 0, top: 0, owners: [] });
  const scrollBy = useCallback((delta: number) => {
    setScroll((s) => Math.max(0, Math.min(maxScrollRef.current, s + delta)));
  }, []);
  const [menuSel, setMenuSel] = useState(0);
  const [search, setSearch] = useState<{ query: string; sel: number } | null>(null);

  // The wheel scrolls the transcript. Without this the terminal turns wheel
  // ticks into arrow keys, which would walk the history instead.
  const { stdin, isRawModeSupported } = useStdin();
  useEffect(() => {
    if (!stdin || !isRawModeSupported) return;
    const onData = (chunk: Buffer | string) => {
      const data = chunk.toString("utf8");
      const ticks = parseWheel(data);
      if (ticks.length) scrollBy(ticks.reduce((n, t) => n + (t === "up" ? 3 : -3), 0));
      for (const click of parseClicks(data)) {
        // Screen row -> transcript line -> the block that drew it.
        const { firstVisible, top, owners } = viewRef.current;
        const lineIdx = firstVisible + (click.row - 1 - top);
        const owner = owners[lineIdx];
        if (owner === undefined) continue;
        setItems((prev) => toggleExpandAt(prev, owner) ?? prev);
      }
    };
    stdin.on("data", onData);
    return () => { stdin.off("data", onData); };
  }, [stdin, isRawModeSupported, scrollBy]);

  /**
   * Walk the input history. Terminals can deliver a burst of arrow keys (a
   * mouse wheel in the alternate buffer looks exactly like one), so the index
   * is clamped from the array itself rather than from previous state.
   */
  const recallHistory = useCallback((direction: 1 | -1) => {
    setHistIdx((prev) => {
      const next = prev + direction;
      if (next < 0) {
        setInput("");
        setCursor(0);
        return -1;
      }
      const i = Math.min(next, history.length - 1);
      const entry = history[i];
      if (entry === undefined) return prev;
      setInput(entry);
      setCursor(entry.length);
      return i;
    });
  }, [history]);

  const runTask = useCallback(async (text: string, plan: boolean) => {
    const agent = agentRef.current;
    if (!agent || running) return;
    setRunning(true);
    setStartedAt(Date.now());
    setScroll(0);
    setFailed(false);
    push({ kind: "user", text: (plan ? "/plan " : "") + text });
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await agent.run(text, { plan, signal: ac.signal });
    } catch (err) {
      if (ac.signal.aborted) push({ kind: "note", text: "cancelled", color: C.warn });
      else {
        setFailed(true); // the run itself failed, which the heartbeat shows
        push({ kind: "error", text: err instanceof GatewayError ? err.message : err instanceof Error ? err.message : String(err) });
      }
    } finally {
      abortRef.current = null;
      setRunning(false);
      setPhase(null);
      setActiveTool(null);
      phaseRef.current = null;
      const t = agent.totals;
      setTotals({ turns: t.turns, cost: t.cost, cached: t.cached_tokens });
    }
  }, [running, push]);

  runTaskRef.current = runTask;

  const submit = useCallback(async (raw: string) => {
    const line = raw.trim();
    if (!line) return;
    setHistory((h) => [line, ...h.filter((x) => x !== line)].slice(0, 100));
    setHistIdx(-1);
    setInput(""); setCursor(0);

    if (line.startsWith("/")) {
      const [cmd, ...rest] = line.slice(1).split(/\s+/);
      switch (cmd) {
        case "exit": case "quit": case "q": exit(); return;
        case "help": push({ kind: "note", text: HELP, color: C.fg }); return;
        case "clear": setItems([]); return;
        case "plan":
          if (!rest.length) { push({ kind: "note", text: "usage: /plan TASK", color: C.warn }); return; }
          return runTask(rest.join(" "), true);
        case "mode": {
          const m = rest[0] as PermissionMode | undefined;
          if (m && ["ask", "auto-edit", "full-auto"].includes(m)) setMode(m);
          push({ kind: "note", text: `mode: ${m && ["ask", "auto-edit", "full-auto"].includes(m) ? m : mode}` });
          return;
        }
        case "verify": { const v = rest[0] === "on" ? true : rest[0] === "off" ? false : verify; setVerify(v); push({ kind: "note", text: `verify: ${v ? "on" : "off"}` }); return; }
        case "review": { const v = rest[0] === "on" ? true : rest[0] === "off" ? false : review; setReview(v); push({ kind: "note", text: `review: ${v ? "on" : "off"}` }); return; }
        case "undo": {
          const restored = (await agentRef.current?.undo()) ?? [];
          push({ kind: "note", text: restored.length ? restored.join("\n") + "\n(shell side effects are not reverted)" : "nothing to undo", color: restored.length ? C.ok : C.muted });
          return;
        }
        case "cost": {
          const t = agentRef.current?.totals;
          push({ kind: "note", text: t ? `${t.turns} calls ${G.sep} ${t.prompt_tokens.toLocaleString()} in (${t.cached_tokens.toLocaleString()} cached) / ${t.completion_tokens.toLocaleString()} out ${G.sep} $${t.cost.toFixed(4)}` : "no usage yet" });
          return;
        }
        case "mouse": {
          const on = rest[0] === "on" ? true : rest[0] === "off" ? false : !mouse;
          setMouse(on);
          if (caps.tty) process.stdout.write(on ? MOUSE_ON : MOUSE_OFF);
          push({
            kind: "note",
            color: C.fg,
            text: on
              ? "mouse capture on: the wheel scrolls. Hold shift to select text."
              : "mouse capture off: drag to select. The wheel is the terminal's again.",
          });
          return;
        }
        case "theme": {
          const t = rest[0] === "light" ? "light" : rest[0] === "dark" ? "dark" : themeName() === "dark" ? "light" : "dark";
          setTheme(t, caps);
          saveUiConfig({ theme: t });
          push({ kind: "note", text: `theme: ${t} (saved)`, color: C.fg });
          return;
        }
        case "model": {
          push({
            kind: "note",
            color: C.fg,
            text: ROLES.map((r) => `${roleGlyph(r)} ${SPECIALISTS[r].model.padEnd(12)} ${SPECIALISTS[r].label.padEnd(9)} ${SPECIALISTS[r].tagline}`).join("\n"),
          });
          return;
        }
        case "new": {
          const s = await SessionStore.create(opts.cwd);
          setSession(s); makeAgent(s); setItems([{ kind: "note", text: `new session ${s.meta.id}`, color: C.muted }]);
          setTotals({ turns: 0, cost: 0, cached: 0 });
          return;
        }
        default: push({ kind: "note", text: `unknown command /${cmd}\n${HELP}`, color: C.warn }); return;
      }
    }
    return runTask(line, opts.plan);
  }, [exit, push, runTask, mode, verify, review, opts.cwd, opts.plan, makeAgent]);

  useInput((ch, key) => {
    // ---- Ctrl-R fuzzy history search --------------------------------------
    if (search) {
      const matches = fuzzyFilter(history, search.query, (h) => h, 5);
      if (key.ctrl && ch === "r") { setSearch({ ...search, sel: Math.min(matches.length - 1, search.sel + 1) }); return; }
      if (key.escape || (key.ctrl && ch === "c")) { setSearch(null); return; }
      if (key.return) {
        const pick = matches[search.sel];
        setSearch(null);
        if (pick) { setInput(pick); setCursor(pick.length); }
        return;
      }
      if (key.upArrow) { setSearch({ ...search, sel: Math.max(0, search.sel - 1) }); return; }
      if (key.downArrow) { setSearch({ ...search, sel: Math.min(matches.length - 1, search.sel + 1) }); return; }
      if (key.backspace || key.delete) { setSearch({ query: search.query.slice(0, -1), sel: 0 }); return; }
      if (ch && !key.ctrl && !key.meta && !isMouseReport(ch)) setSearch({ query: search.query + ch, sel: 0 });
      return;
    }

    // Scrolling works everywhere, including while a dialog is open (long plans!).
    if (key.pageUp) { scrollBy(Math.max(1, transcriptRows - 2)); return; }
    if (key.pageDown) { scrollBy(-Math.max(1, transcriptRows - 2)); return; }

    // ---- dialogs take the remaining keys --------------------------------
    if (dialog?.kind === "permission") {
      const k = ch.toLowerCase();
      if (k === "y") { dialog.resolve(true); setDialog(null); }
      else if (k === "a" && dialog.req.allowRemember !== false && dialog.req.risk !== "dangerous") { remember.current.add(dialog.req.tool); dialog.resolve(true); setDialog(null); }
      else if (k === "n" || key.escape || (key.ctrl && ch === "c")) { dialog.resolve(false); setDialog(null); }
      return;
    }
    if (dialog?.kind === "plan") {
      const k = ch.toLowerCase();
      if (k === "y" || key.return) { dialog.resolve(dialog.plan); setDialog(null); }
      else if (k === "n" || key.escape || (key.ctrl && ch === "c")) { dialog.resolve(null); setDialog(null); }
      else if (k === "e") { setDialog({ kind: "plan-notes", plan: dialog.plan, resolve: dialog.resolve }); setInput(""); setCursor(0); }
      return;
    }
    if (dialog?.kind === "question") {
      if (key.escape || (key.ctrl && ch === "c")) { dialog.resolve(""); return; }
      if (dialog.options?.length && /^[1-9]$/.test(ch) && !input) {
        const pick = dialog.options[Number(ch) - 1];
        if (pick) { dialog.resolve(pick); return; }
      }
      if (key.return) { dialog.resolve(input.trim()); return; }
      // anything else falls through to ordinary text editing
    }
    if (dialog?.kind === "plan-notes") {
      if (key.return) { dialog.resolve(input.trim() ? `${dialog.plan}\n\n# Notes from the user\n${input.trim()}` : dialog.plan); setDialog(null); setInput(""); setCursor(0); return; }
      if (key.escape) { dialog.resolve(null); setDialog(null); setInput(""); setCursor(0); return; }
      // fall through to text editing
    }

    // ---- global keys ------------------------------------------------------
    if (key.ctrl && ch === "c") {
      if (running) { abortRef.current?.abort(); return; }
      if (input) { setInput(""); setCursor(0); return; }
      if (ctrlC > 0) { exit(); return; }
      setCtrlC(1);
      setTimeout(() => setCtrlC(0), 1500);
      return;
    }
    if (key.ctrl && ch === "r" && !running) { setSearch({ query: "", sel: 0 }); return; }
    if (key.escape) { setInput(""); setCursor(0); setScroll(0); setMenuSel(0); return; }
    // `o` opens the next collapsed output, `O` opens or closes every one.
    if ((ch === "o" || ch === "O") && !input && !dialog) {
      const next = ch === "O" ? toggleExpandAll(items) : toggleExpand(items);
      if (next) { setItems(next); return; }
    }

    // ---- text editing -------------------------------------------------------
    if (key.return) {
      // Alt+Enter (and Ctrl+J) insert a newline instead of submitting.
      if (key.meta || (key.ctrl && ch === "j")) {
        setInput((v) => v.slice(0, cursor) + "\n" + v.slice(cursor));
        setCursor((c) => c + 1);
        return;
      }
      if (menu.length && menuSel < menu.length && input !== menu[menuSel]!.name) {
        const pick = menu[menuSel]!;
        const next = pick.args ? pick.name + " " : pick.name;
        setInput(next); setCursor(next.length); setMenuSel(0);
        return;
      }
      if (!dialog) void submit(input);
      return;
    }
    if (key.upArrow) {
      if (menu.length) { setMenuSel((i) => Math.max(0, i - 1)); return; }
      if (key.ctrl) { recallHistory(1); return; }
      // With the mouse left to the terminal a wheel tick arrives here as an
      // arrow key, so an empty composer scrolls. History moves to ctrl+arrows.
      if (!input && !mouse) { scrollBy(1); return; }
      recallHistory(1);
      return;
    }
    if (key.downArrow) {
      if (menu.length) { setMenuSel((i) => Math.min(menu.length - 1, i + 1)); return; }
      if (key.ctrl) { recallHistory(-1); return; }
      if (!input && !mouse) { scrollBy(-1); return; }
      recallHistory(-1);
      return;
    }
    if (key.tab) {
      // Tab opens and closes the rail unless a completion is waiting.
      if (!menu.length) { setRailOpen((v) => !v); return; }
      const pick = menu[menuSel];
      if (pick) {
        const next = pick.args ? pick.name + " " : pick.name;
        setInput(next); setCursor(next.length); setMenuSel(0);
      }
      return;
    }
    if (key.leftArrow) { setCursor((c) => Math.max(0, c - 1)); return; }
    if (key.rightArrow) { setCursor((c) => Math.min(input.length, c + 1)); return; }
    if (key.backspace || key.delete) {
      if (cursor === 0) return;
      setInput((v) => v.slice(0, cursor - 1) + v.slice(cursor)); setCursor((c) => c - 1); return;
    }
    if (key.ctrl && ch === "u") { setInput(""); setCursor(0); return; }
    if (key.ctrl && ch === "a") { setCursor(0); return; }
    if (key.ctrl && ch === "e") { setCursor(input.length); return; }
    if (key.ctrl || key.meta) return;
    if (ch) {
      if (isMouseReport(ch)) return; // a wheel tick, not a keystroke
      const text = ch.replace(/\r/g, "\n"); // pasted newlines stay newlines
      setInput((v) => v.slice(0, cursor) + text + v.slice(cursor));
      setCursor((c) => c + text.length);
      setMenuSel(0);
    }
  });

  // ---- layout ---------------------------------------------------------------
  const cols = size.cols;
  const railW = railWidth(cols, railOpen, caps.tty);
  const showRail = railW > 0;
  const width = Math.max(40, cols - railW - 2);
  const blink = running && tick % 10 < 6;
  // The running phase label animates, so it re-renders with the tick.
  const rendered = useMemo(
    () => renderTranscript(items, width, blink ? items.length - 1 : -1, tick, running),
    [items, width, blink, tick, running],
  );
  const allLines = rendered.lines;
  const typingCommand = !running && !dialog && input.startsWith("/") && !input.includes("\n");
  const menu: Command[] = typingCommand
    ? (input.includes(" ") ? [] : fuzzyFilter(COMMANDS, input.slice(1), (c) => c.name.slice(1), COMMANDS.length))
    : [];
  const inputLines = input.split("\n").reduce((n, l) => n + wrap(l || " ", width - 6).length, 0);
  const dialogRows = search ? 3 + Math.min(5, fuzzyFilter(history, search.query, (h) => h, 5).length)
    : dialog?.kind === "permission"
      ? 4 + (dialog.req.reason ? 1 : 0) + Math.min(12, dialog.req.after !== undefined
          ? renderDiff(dialog.req.before ?? "", dialog.req.after, width - 4, null, 1).length
          : (dialog.req.detail ?? "").split("\n").length)
    : dialog?.kind === "question" ? 4 + (dialog.options?.length ?? 0) + inputLines
    : dialog?.kind === "plan" ? 3
    : 2 + inputLines + (menu.length ? Math.min(menu.length, MENU_ROWS) + 3 : 0);
  const chromeRows = (caps.tty ? 1 : 0) /*top bar*/ + 1 /*activity*/ + (caps.tty ? 1 : 0) /*hotkeys*/;
  const transcriptRows = Math.max(3, size.rows - chromeRows - dialogRows - 1);
  const maxScroll = Math.max(0, allLines.length - transcriptRows);
  maxScrollRef.current = maxScroll; // the wheel and PgUp clamp against this
  const effScroll = Math.min(scroll, maxScroll);
  const end = allLines.length - effScroll;
  const firstVisible = Math.max(0, end - transcriptRows);
  const visible = allLines.slice(firstVisible, end);
  // A click reports a screen row; this is what turns it back into an item.
  viewRef.current = { firstVisible, top: caps.tty ? 1 : 0, owners: rendered.owners };

  const railTools = [
    { name: "files", state: "ok" as const },
    { name: "shell", state: (mode === "ask" ? "warn" : "ok") as "ok" | "warn", note: mode === "ask" ? "asks" : undefined },
    { name: "search", state: "ok" as const },
    { name: "verify", state: (verify ? "ok" : "off") as "ok" | "off" },
    { name: "review", state: (review ? "ok" : "off") as "ok" | "off" },
  ];

  const beat: Beat =
    dialog ? "needs-you"
    : running ? (activeTool ? "tool" : "thinking")
    : failed ? "error"
    : totals.turns > 0 ? "done"
    : "idle";

  const ctxPct = Math.min(99, Math.round((ctxTokens / CONTEXT_BUDGET) * 100));
  const hotkeys: [string, string][] = ctrlC
    ? [["ctrl+c", "again to quit"]]
    : [
        [mode, "mode"],
        ["tab", showRail ? "hide rail" : "rail"],
        [mouse ? "shift+drag" : "drag", "select"],
        [mouse ? "click" : "\u2191\u2193", mouse ? "expand" : "scroll"],
        ["ctrl+r", "history"],
        ["/", "commands"],
        ["o/O", "expand"],
        [running ? "esc" : "ctrl+c", running ? "interrupt" : "quit"],
      ];

  // The composer keeps its face whatever happened: a tool that returned an
  // error is the transcript's business, not the input field's.
  const promptState: PromptState =
    running ? "busy" : dialog?.kind === "plan-notes" ? "notes" : dialog ? "confirm" : "idle";

  const secs = running ? (Date.now() - startedAt) / 1000 : 0;
  const elapsed = !running ? "" : secs < 60 ? `${secs.toFixed(1)}s` : `${Math.floor(secs / 60)}m${String(Math.floor(secs % 60)).padStart(2, "0")}s`;
  const spinner = G.spinner[tick % G.spinner.length];

  return (
    <Box flexDirection="column" width={cols} height={size.rows}>
      {caps.tty ? (
        <TopBar
          beat={beat}
          tick={tick}
          model={running && phase ? roleModel(phase.role) : MODEL_FAMILY.toLowerCase()}
          cwd={opts.cwd}
          branch={branch}
          dirty={dirty}
          step={totals.turns ? `${totals.turns} calls` : null}
          elapsed={elapsed}
          cost={`$${totals.cost.toFixed(4)}`}
          width={cols}
        />
      ) : null}

      {/* transcript + rail */}
      <Box flexGrow={1} overflow="hidden">
        <Box flexDirection="column" flexGrow={1} paddingX={1} overflow="hidden">
          {visible.map((line, i) => <LineView key={`${end - visible.length + i}`} line={line} />)}
        </Box>
        {showRail ? (
          <Rail
            width={railW}
            height={transcriptRows}
            contextUsed={ctxTokens}
            contextBudget={CONTEXT_BUDGET}
            tools={railTools}
            files={files}
            tokensIn={agentRef.current?.totals.prompt_tokens ?? 0}
            tokensOut={agentRef.current?.totals.completion_tokens ?? 0}
            calls={toolCalls}
          />
        ) : null}
      </Box>

      {/* live activity: one row, replaced in place */}
      <Box paddingX={1}>
        <Text wrap="truncate">
          {running ? (
            <>
              <Text color={col(phase ? roleColor(phase.role) : C.accent)}>{spinner} </Text>
              <Text color={col(C.fg)}>{activeTool ?? (phase ? `${PHASE_LABEL[phase.phase] ?? phase.phase} ${G.sep} ${roleModel(phase.role)}` : "thinking")}</Text>
              <Text color={col(C.muted)}>{activeTool && phase ? ` ${G.sep} ${roleModel(phase.role)}` : ""} {G.sep} {elapsed}</Text>
            </>
          ) : effScroll > 0 ? (
            <Text color={col(C.muted)}>{G.arrow === "→" ? "↑" : "^"} {effScroll} lines above · PgDn to follow</Text>
          ) : (
            <Text color={col(C.muted)}> </Text>
          )}
        </Text>
      </Box>

      {/* input or dialog */}
      {search ? (
        <HistorySearch query={search.query} matches={fuzzyFilter(history, search.query, (h) => h, 5)} selected={search.sel} width={width} />
      ) : dialog?.kind === "permission" ? (
        <PermissionView req={dialog.req} width={width} />
      ) : dialog?.kind === "question" ? (
        <Box flexDirection="column" borderStyle="round" borderColor={col(C.warn)} paddingX={1}>
          <Text wrap="truncate">
            <Text color={col(C.warn)} bold>{G.warn} </Text>
            <Text color={col(C.bright)}>{dialog.question}</Text>
          </Text>
          {dialog.options?.map((o, i) => (
            <Text key={o} wrap="truncate">
              <Text color={col(C.accent)} bold>{`  ${i + 1} `}</Text>
              <Text color={col(C.fg)}>{o}</Text>
            </Text>
          ))}
          <InputBox
            value={input}
            cursor={cursor}
            width={width - 2}
            state="confirm"
            placeholder={dialog.options?.length ? "press a number, or type an answer" : "type an answer, Esc to skip"}
          />
        </Box>
      ) : dialog?.kind === "plan" ? (
        <Box borderStyle="round" borderColor={col(C.planner)} paddingX={1}>
          <Text wrap="truncate">
            <Text color={col(C.planner)} bold>{G.warn} </Text>
            <Text color={col(C.bright)}>run this plan?</Text>
            <Text color={col(C.muted)}>{"   "}</Text>
            <Text color={col(C.ok)} bold>y</Text><Text color={col(C.muted)}> go   </Text>
            <Text color={col(C.accent)} bold>e</Text><Text color={col(C.muted)}> add notes   </Text>
            <Text color={col(C.danger)} bold>n</Text><Text color={col(C.muted)}> stop</Text>
          </Text>
        </Box>
      ) : (
        <>
          <CommandMenu matches={menu} selected={menuSel} query={input} width={width} />
          <InputBox
            value={input}
            cursor={cursor}
            width={width}
            state={promptState}
            placeholder={
              running ? "working… Ctrl+C to cancel"
              : dialog?.kind === "plan-notes" ? "what should change? Enter to proceed, Esc to stop"
              : "Describe a change, or / for commands"
            }
          />
        </>
      )}

      {/* hotkeys (terminals only) */}
      {caps.tty ? <HotKeys hints={hotkeys} width={cols} /> : null}
    </Box>
  );
}

function LineView({ line }: { line: Line }) {
  // An empty <Text> collapses to zero height in Ink, which would silently eat
  // every blank separator; a single space keeps the row.
  if (line.every((s) => s.text === "")) return <Text> </Text>;
  return (
    <Text wrap="truncate">
      {line.map((s, i) => (
        <Text key={i} color={segColor(s)} bold={s.bold} dimColor={s.dim} italic={s.italic} backgroundColor={segBg(s)} inverse={s.inverse}>{s.text}</Text>
      ))}
    </Text>
  );
}

function PermissionView({ req, width }: { req: PermissionRequest; width: number }) {
  const danger = req.risk === "dangerous";
  const tone = danger ? C.danger : C.warn;
  const lang = req.path ? req.path.split(".").pop() ?? null : null;
  const inner = width - 4;

  // An edit or a write shows the change itself; a command shows the command.
  let preview: Line[] = [];
  let stat = "";
  if (req.after !== undefined) {
    preview = renderDiff(req.before ?? "", req.after, inner, lang, 1).slice(0, 10);
    const { added, removed } = diffStat(req.before ?? "", req.after);
    stat = `+${added} ${G.sep} -${removed}`;
  }

  const verb = req.tool === "bash" ? "run" : req.tool === "edit_file" ? "edit" : req.tool === "write_file" ? "write" : req.tool;
  const target = req.tool === "bash" ? (req.detail ?? req.summary) : req.path ?? req.summary;
  // "always" is the server's call, not ours.
  const remember = req.allowRemember !== false && !danger;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={col(tone)} paddingX={1}>
      <Text wrap="truncate">
        <Text color={col(tone)} bold>{G.warn} </Text>
        <Text color={col(tone)}>{danger ? "dangerous " : ""}{verb} </Text>
        <Text color={col(C.bright)}>{target}</Text>
        {stat ? <Text color={col(C.muted)}>{"  " + stat}</Text> : null}
      </Text>
      {preview.map((l, i) => <LineView key={i} line={l} />)}
      {req.reason ? <Text color={col(C.muted)} wrap="truncate">{req.reason}</Text> : null}
      <Text wrap="truncate">
        <Text color={col(C.ok)} bold>y</Text><Text color={col(C.muted)}> once   </Text>
        {remember ? <><Text color={col(C.accent)} bold>a</Text><Text color={col(C.muted)}> always this session   </Text></> : null}
        <Text color={col(C.danger)} bold>n</Text><Text color={col(C.muted)}> skip</Text>
      </Text>
    </Box>
  );
}

function shorten(p: string, max: number): string {
  const s = p.replace(/\\/g, "/");
  return s.length <= max ? s : "…" + s.slice(-max + 1);
}
