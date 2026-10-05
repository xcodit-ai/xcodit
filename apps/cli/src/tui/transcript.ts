import type { AgentEvent } from "@xcodit/agent";
import { homedir } from "node:os";
import { C, G, PHASE_LABEL, caps, roleColor, roleGlyph, roleModel } from "./theme.js";
import { box, card, clampLine, displayWidth, lineWidth, pad, type Line, type Seg } from "./box.js";
import { FAMILY, SPECIALIST_LINE, VERSION, WORDMARK_TEXT, prettyCwd, type BannerFacts } from "./banner.js";
import { markdownLines, wrap } from "./markdown.js";

export type { Line, Seg };
export { wrap };

export interface PlanStep {
  text: string;
  state: "pending" | "active" | "done";
}

export type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; done: boolean; steps?: PlanStep[] }
  | { kind: "phase"; phase: string; role: string; detail?: string }
  | { kind: "tool"; id: string; name: string; summary: string; depth: number; state: "running" | "ok" | "error" | "denied"; ms?: number; output?: string; lines?: number; expanded?: boolean }
  | { kind: "subagent"; role: string; state: "running" | "done"; turns?: number; cost?: number }
  | { kind: "verify"; commands?: string[]; passed?: boolean; report?: string; attempt?: number; expanded?: boolean }
  | { kind: "review"; verdict: "approve" | "request_changes"; summary: string; issues: { severity: string; file?: string; line?: number; description: string }[]; cost: number }
  | { kind: "plan"; text: string; steps: PlanStep[] }
  | { kind: "todos"; items: PlanStep[] }
  | { kind: "note"; text: string; color?: string }
  | { kind: "banner"; facts: BannerFacts }
  | { kind: "error"; text: string };

/** How many lines of a long output to show before collapsing. */
const PREVIEW_LINES = 8;
const KEEP_OUTPUT_LINES = 400;

// ---- event reducer ----------------------------------------------------------

export function applyEvent(items: Item[], e: AgentEvent): Item[] {
  const last = items[items.length - 1];
  switch (e.type) {
    case "phase":
      return markPlanStep([...items, { kind: "phase", phase: e.phase, role: e.role, detail: e.detail }], e.phase);
    case "text_delta": {
      if (e.depth > 0) return items;
      if (last?.kind === "assistant" && !last.done) return [...items.slice(0, -1), { ...last, text: last.text + e.text }];
      return [...items, { kind: "assistant", text: e.text, done: false }];
    }
    case "model_done": {
      if (e.depth > 0) return items;
      if (last?.kind === "assistant" && !last.done) return [...items.slice(0, -1), { ...last, done: true }];
      return items;
    }
    case "tool_start":
      return [...items, { kind: "tool", id: e.id, name: e.name, summary: e.summary, depth: e.depth, state: "running" }];
    case "tool_end": {
      const idx = findLastIndex(items, (it) => it.kind === "tool" && it.id === e.id);
      if (idx < 0) return items;
      const cur = items[idx] as Extract<Item, { kind: "tool" }>;
      const all = e.result.content.split("\n");
      const output = all.slice(0, KEEP_OUTPUT_LINES).join("\n");
      return replace(items, idx, { ...cur, state: e.result.isError ? "error" : "ok", ms: e.ms, output, lines: all.length });
    }
    case "tool_denied": {
      const idx = findLastIndex(items, (it) => it.kind === "tool" && it.id === e.id);
      return idx < 0 ? items : replace(items, idx, { ...(items[idx] as Extract<Item, { kind: "tool" }>), state: "denied" });
    }
    case "subagent_start":
      return [...items, { kind: "subagent", role: e.role, state: "running" }];
    case "subagent_end": {
      const idx = findLastIndex(items, (it) => it.kind === "subagent" && it.state === "running");
      return idx < 0 ? items : replace(items, idx, { kind: "subagent", role: e.role, state: "done", turns: e.turns, cost: e.cost });
    }
    case "verify_start":
      return [...items, { kind: "verify", commands: e.commands }];
    case "verify_end": {
      const idx = findLastIndex(items, (it) => it.kind === "verify" && it.passed === undefined);
      const next: Item = {
        kind: "verify",
        commands: idx >= 0 ? (items[idx] as Extract<Item, { kind: "verify" }>).commands : undefined,
        passed: e.passed,
        report: e.report,
        attempt: e.attempt,
      };
      return idx >= 0 ? replace(items, idx, next) : [...items, next];
    }
    case "review_start":
      return [...items, { kind: "note", text: `reviewing a ${e.diffChars.toLocaleString()}-character diff`, color: C.muted }];
    case "review_end":
      return [...items, { kind: "review", verdict: e.verdict, summary: e.summary, issues: e.issues, cost: e.cost }];
    case "plan_ready":
      return [...items, { kind: "plan", text: e.plan, steps: parsePlanSteps(e.plan) }];
    case "todos": {
      // One live checklist per run: the newest replaces the last one.
      const steps: PlanStep[] = e.items.map((t) => ({ text: t.text, state: t.status }));
      const idx = findLastIndex(items, (it) => it.kind === "todos");
      const next: Item = { kind: "todos", items: steps };
      return idx >= 0 ? replace(items, idx, next) : [...items, next];
    }
    case "compaction":
      return [...items, { kind: "note", text: `compacted context ${e.before.toLocaleString()} ${G.arrow} ${e.after.toLocaleString()} tokens`, color: C.muted }];
    case "error":
      return [...items, { kind: "error", text: e.message }];
    default:
      return items;
  }
}

const replace = (items: Item[], i: number, next: Item): Item[] => [...items.slice(0, i), next, ...items.slice(i + 1)];

function findLastIndex<T>(arr: T[], pred: (t: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i]!)) return i;
  return -1;
}

/** Numbered steps out of the planner's markdown, for the progress bar. */
export function parsePlanSteps(plan: string): PlanStep[] {
  const steps: PlanStep[] = [];
  for (const raw of plan.split("\n")) {
    const m = raw.match(/^\s{0,3}(\d{1,2})[.)]\s+(.*\S)/);
    if (!m) continue;
    const text = m[2]!.replace(/\*\*/g, "").replace(/`/g, "");
    if (text.length > 2) steps.push({ text, state: "pending" });
  }
  return steps.slice(0, 12);
}

/** Advance the plan's progress as phases go by (presentation only). */
function markPlanStep(items: Item[], phase: string): Item[] {
  if (phase !== "implement" && phase !== "verify") return items;
  const idx = findLastIndex(items, (it) => it.kind === "plan");
  if (idx < 0) return items;
  const plan = items[idx] as Extract<Item, { kind: "plan" }>;
  if (!plan.steps.length) return items;
  const next = plan.steps.map((s) => ({ ...s }));
  if (phase === "verify") {
    next.forEach((s) => (s.state = "done"));
  } else {
    const i = next.findIndex((s) => s.state === "pending");
    if (i >= 0) {
      next.slice(0, i).forEach((s) => (s.state = "done"));
      next[i]!.state = "active";
    }
  }
  const withPlan = replace(items, idx, { ...plan, steps: next });
  // Mirror the checklist onto the newest agent message so it reads as one block.
  const ai = findLastIndex(withPlan, (it) => it.kind === "assistant");
  if (ai < 0) return withPlan;
  return replace(withPlan, ai, { ...(withPlan[ai] as Extract<Item, { kind: "assistant" }>), steps: next });
}

const expandable = (it: Item): boolean =>
  (it.kind === "tool" && Boolean(it.output) && it.output!.split("\n").length > PREVIEW_LINES) ||
  (it.kind === "verify" && Boolean(it.report) && it.report!.split("\n").length > PREVIEW_LINES);

const setExpanded = (it: Item, open: boolean): Item =>
  it.kind === "tool" || it.kind === "verify" ? { ...it, expanded: open } : it;

/**
 * Walk backwards: each press opens the next collapsed block above the last one
 * opened, so a second press reaches the output before it rather than closing
 * the one you just opened.
 */
export function toggleExpand(items: Item[]): Item[] | null {
  const idx = findLastIndex(items, (it) => expandable(it) && !(it as { expanded?: boolean }).expanded);
  if (idx >= 0) return replace(items, idx, setExpanded(items[idx]!, true));
  // Everything is open: the next press closes the newest again.
  const last = findLastIndex(items, expandable);
  return last < 0 ? null : replace(items, last, setExpanded(items[last]!, false));
}

/** Open every collapsed block, or close them all when they are already open. */
export function toggleExpandAll(items: Item[]): Item[] | null {
  const targets = items.filter(expandable);
  if (!targets.length) return null;
  const open = !targets.every((it) => (it as { expanded?: boolean }).expanded);
  return items.map((it) => (expandable(it) ? setExpanded(it, open) : it));
}

// ---- rendering --------------------------------------------------------------

const sevColor = (s: string) => (s === "critical" || s === "high" ? C.danger : s === "medium" ? C.warn : C.muted);

/** Every message starts with a two-column marker so the left edge stays readable. */
/**
 * Markers sit in a three-column gutter. Two columns are not enough: glyphs
 * like the diamond and the square are East Asian Ambiguous, so plenty of
 * fonts draw them two cells wide and they swallow a single trailing space.
 */
export const GUTTER = 3;
const INDENT = " ".repeat(GUTTER);

function gutter(glyph: string, color: string): Seg {
  return { text: glyph + " ".repeat(Math.max(1, GUTTER - displayWidth(glyph))), color };
}

function withGutter(glyph: string, color: string, lines: Line[]): Line[] {
  return lines.map((l, i) => [i === 0 ? gutter(glyph, color) : { text: INDENT }, ...l]);
}

/** A full-width band: the background has to reach both edges to read as one. */
function band(line: Line, width: number, bg: string): Line {
  return pad(clampLine(line, width), width).map((seg) => ({ ...seg, bg: seg.bg ?? bg }));
}

/** Collapse a long block to a preview plus an expand hint. */
function preview(text: string, expanded: boolean | undefined, width: number): { lines: Line[]; hint?: string } {
  const all = text.replace(/\s+$/, "").split("\n");
  const show = expanded ? all.slice(0, KEEP_OUTPUT_LINES) : all.slice(0, PREVIEW_LINES);
  const lines = show.flatMap((l) => wrap(l, width).map((t): Line => [{ text: t, color: C.fg }]));
  const hidden = all.length - show.length;
  return {
    lines,
    hint: hidden > 0 ? `${G.ellipsis} ${hidden} more lines · press o` : expanded && all.length > PREVIEW_LINES ? "press o to collapse" : undefined,
  };
}

/**
 * A light sweeps the label while the phase is running. The wordmark keeps its
 * own heartbeat; this is the same idea applied to the state line.
 */
function shimmer(text: string, color: string, tick: number): Seg[] {
  const chars = [...text];
  // A pause between sweeps so it reads as a pulse, not a strobe.
  const period = chars.length + 12;
  const head = tick % period;
  return chars.map((ch, i) => {
    const d = head - i;
    if (d === 0) return { text: ch, color: C.bright, bold: true };
    if (d === 1 || d === 2) return { text: ch, color, bold: true }; // the tail
    return { text: ch, color, bold: true, dim: true };
  });
}

export function itemToLines(it: Item, width: number, cursor = false, active = false, tick = 0): Line[] {
  const w = Math.max(24, width);
  const body = w - GUTTER; // gutter
  switch (it.kind) {
    case "user": {
      const lines = wrap(it.text, body - 1).map((l): Line => [{ text: l, color: C.bright, bold: true }]);
      return [[{ text: "" }], ...withGutter(G.user, C.accent, lines).map((l) => band(l, w, C.panel))];
    }

    case "assistant": {
      const lines = markdownLines(it.text, body);
      if (!it.done && cursor && lines.length) lines[lines.length - 1] = [...lines[lines.length - 1]!, { text: G.cursor, color: C.accent }];
      // The plan's steps live under the agent's own words, not in a second panel.
      const steps = it.steps?.length ? stepLines(it.steps, body) : [];
      const blocks = [...lines, ...(steps.length ? [[{ text: "" }] as Line, ...steps] : [])];
      return [[{ text: "" }], ...withGutter(G.agent, C.accent, blocks), ...(it.done ? [[{ text: "" }] as Line] : [])];
    }

    case "phase": {
      // A state change is a rule across the column, not another sentence.
      const color = roleColor(it.role);
      const label = PHASE_LABEL[it.phase] ?? it.phase;
      const head: Line = [
        gutter(roleGlyph(it.role), color),
        ...(active ? shimmer(label, color, tick) : [{ text: label, color, bold: true } as Seg]),
        ...(it.detail ? [{ text: ` (${it.detail})`, color: C.muted }] : []),
        { text: "  " + roleModel(it.role), color: C.muted },
      ];
      const rule = Math.max(0, w - lineWidth(head) - 2);
      return [[{ text: "" }], [...head, { text: "  " + G.boxH.repeat(rule), color: C.border }]];
    }

    case "tool": {
      // A card per tool call: header carries the call, the body only opens when
      // it failed or the reader asked for it.
      const indent = 2 + it.depth * 2;
      const arg = toolArg(it);
      const status: Seg[] =
        it.state === "running" ? [{ text: "running" + G.ellipsis, color: C.muted }]
        : it.state === "ok" ? [{ text: `${G.ok} ${describeResult(it)}`, color: C.ok }]
        : it.state === "denied" ? [{ text: `${G.err} skipped`, color: C.warn }]
        : [{ text: `${G.err} failed`, color: C.danger }];
      const long = (it.lines ?? 0) > PREVIEW_LINES;
      const open = Boolean(it.output) && (it.expanded || it.state === "error");
      const p = open ? preview(it.output!, it.expanded, w - indent - 4) : null;
      return card({
        width: w,
        indent,
        color: it.state === "error" ? C.danger : C.border,
        head: {
          glyph: G.tool,
          glyphColor: it.state === "error" ? C.danger : C.warn,
          name: it.name,
          arg,
          status,
          marker: !it.output ? undefined : open ? G.expanded + " expanded" : long ? G.collapsed + " collapsed" : undefined,
        },
        body: p?.lines,
        foot: p?.hint ? [{ text: p.hint, color: C.faint }] : undefined,
      });
    }

    case "subagent":
      return [[
        { text: "  " },
        gutter(G.sub, C.muted),
        { text: roleModel(it.role), color: roleColor(it.role) },
        { text: it.state === "running" ? " working" + G.ellipsis : ` done ${G.sep} ${it.turns} calls ${G.sep} $${(it.cost ?? 0).toFixed(4)}`, color: C.muted },
      ]];

    case "verify": {
      const cmds = (it.commands ?? []).join(`  ${G.sep}  `);
      if (it.passed === undefined) {
        return card({ width: w, indent: 2, head: { glyph: G.tool, glyphColor: C.warn, name: "checks", arg: cmds, status: [{ text: "running" + G.ellipsis, color: C.muted }] } });
      }
      if (it.passed) {
        return card({ width: w, indent: 2, head: { glyph: G.tool, glyphColor: C.warn, name: "checks", arg: cmds, status: [{ text: `${G.ok} all passed`, color: C.ok }] } });
      }
      const p = preview(it.report ?? "", it.expanded, w - 6);
      return card({
        width: w,
        indent: 2,
        color: C.danger,
        head: { glyph: G.tool, glyphColor: C.danger, name: "checks", arg: cmds, status: [{ text: `${G.err} failed`, color: C.danger }], marker: `attempt ${it.attempt}` },
        body: p.lines,
        foot: p.hint ? [{ text: p.hint, color: C.faint }] : undefined,
      });
    }

    case "review": {
      const ok = it.verdict === "approve";
      const out: Line[] = [[
        gutter(ok ? G.ok : G.warn, ok ? C.ok : C.warn),
        { text: ok ? "approved" : "changes requested", color: ok ? C.ok : C.warn, bold: true },
        { text: `  ${roleModel("reviewer")} ${G.sep} $${it.cost.toFixed(4)}`, color: C.muted },
      ]];
      for (const l of wrap(it.summary, body)) out.push([{ text: "  " }, { text: l, color: C.fg }]);
      for (const i of it.issues) {
        const loc = i.file ? `${i.file}${i.line ? `:${i.line}` : ""} — ` : "";
        out.push(clampLine([{ text: "  " }, { text: `[${i.severity}] `, color: sevColor(i.severity) }, { text: loc + i.description, color: C.fg }], w));
      }
      return out;
    }

    case "plan": {
      const content = markdownLines(it.text, w - 6);
      const done = it.steps.filter((x) => x.state === "done").length;
      const hint = it.steps.length ? `${done}/${it.steps.length} steps` : undefined;
      return [[{ text: "" }], ...box(content, { width: w, color: C.planner, title: "plan", hint })];
    }

    case "todos": {
      const done = it.items.filter((t) => t.state === "done").length;
      return [
        [{ text: "" }],
        [
          gutter(G.stepDone, C.accent),
          { text: "task list", color: C.fg, bold: true },
          { text: `  ${done}/${it.items.length}`, color: C.muted },
        ],
        ...stepLines(it.items, body).map((l) => [{ text: INDENT }, ...l] as Line),
      ];
    }

    case "note":
      return withGutter(G.info, C.muted, wrap(it.text, body).map((l): Line => [{ text: l, color: it.color || C.muted }]));

    case "banner":
      return bannerLines(it.facts, w);

    case "error":
      return withGutter(G.err, C.danger, wrap(it.text, body).map((l): Line => [{ text: l, color: C.danger }]));
  }
}

const fmtMs = (ms?: number) => (ms === undefined ? "" : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

/** The step checklist: done ticks, one active dot, the rest waiting. */
export function stepLines(steps: PlanStep[], width: number): Line[] {
  return steps.map((s) =>
    clampLine(
      [
        s.state === "done"
          ? { text: `${G.stepDone} `, color: C.ok }
          : s.state === "active"
            ? { text: `${G.stepActive} `, color: C.accent }
            : { text: `${G.stepTodo} `, color: C.faint },
        { text: s.text, color: s.state === "active" ? C.fg : s.state === "done" ? C.muted : C.faint },
      ],
      width,
    ),
  );
}

const describeResult = (it: Extract<Item, { kind: "tool" }>): string => {
  const ms = fmtMs(it.ms);
  return it.lines && it.lines > 1 ? `${it.lines} lines ${G.sep} ${ms}` : ms;
};

/** The card shows the tool by name, so the summary's own prefix is redundant. */
function toolArg(it: Extract<Item, { kind: "tool" }>): string {
  const s = it.summary;
  if (it.name === "bash") return s.replace(/^\$\s*/, "");
  const verb = s.match(/^(read|edit|write|glob|grep|delegate)\b[^\s]*\s+(.*)$/);
  return verb ? verb[2]! : s;
}

/** Progress bar for a multi-step plan; completed steps collapse into the count. */
export function progressLines(steps: PlanStep[], width: number): Line[] {
  if (!steps.length) return [];
  const done = steps.filter((s) => s.state === "done").length;
  const active = steps.find((s) => s.state === "active");
  const barW = Math.min(24, Math.max(8, width - 40));
  const filled = Math.round((done / steps.length) * barW);
  const bar = clampLine(
    [
      { text: "  " },
      { text: G.barFull.repeat(filled), color: C.planner },
      { text: G.barEmpty.repeat(Math.max(0, barW - filled)), color: C.border },
      { text: `  ${done}/${steps.length}`, color: C.muted },
      ...(active ? [{ text: "  " + active.text, color: C.fg }] : []),
    ],
    width,
  );
  // One line per step: done collapses to a tick, pending stays dim.
  const rows = steps.map((s) =>
    clampLine(
      [
        { text: "  " },
        s.state === "done"
          ? { text: `${G.ok} `, color: C.ok }
          : s.state === "active"
            ? { text: `${G.stepActive} `, color: C.planner }
            : { text: `${G.info} `, color: C.border },
        { text: s.text, color: s.state === "done" ? C.muted : s.state === "active" ? C.fg : C.muted, bold: s.state === "active" },
      ],
      width,
    ),
  );
  return [bar, ...rows];
}

/**
 * Boot screen: the lockup, then the facts of this session as a key/value
 * grid, then what loaded. Everything the design calls for, in eleven rows.
 */
export function bannerLines(f: BannerFacts, width: number): Line[] {
  const w = Math.max(40, width);
  const labelW = 9;
  const kv = (label: string, value: Line): Line => [
    { text: "  " },
    { text: label.padEnd(labelW), color: C.muted },
    ...value,
  ];
  const home = homedir();

  const rows: Line[] = [
    [
      { text: " " },
      { text: "x", color: C.accent, bold: true },
      { text: WORDMARK_TEXT, color: C.bright, bold: true },
      { text: " " + G.heart, color: C.accent },
      { text: `  v${VERSION}`, color: C.muted },
    ],
    [{ text: "  " }, { text: `"${f.tagline}"`, color: C.faint, italic: true }],
    [{ text: "" }],
    kv("model", [{ text: FAMILY, color: C.fg }, { text: `  ${SPECIALIST_LINE}`, color: C.faint }]),
    kv("cwd", [{ text: prettyCwd(f.cwd, home, w - labelW - 6), color: C.fg }]),
  ];
  if (f.branch) {
    rows.push(kv("branch", [
      { text: `${G.branch} ${f.branch}`, color: f.dirty ? C.warn : C.ok },
      ...(f.dirty ? [{ text: "  uncommitted changes", color: C.faint } as Seg] : []),
    ]));
  }
  rows.push(kv("context", [{ text: `${Math.round(f.contextBudget / 1000)}k`, color: C.fg }, { text: "  0% used", color: C.faint }]));
  rows.push(kv("tools", [{ text: `${f.tools} ready`, color: C.fg }]));
  rows.push(kv("theme", [{ text: f.theme, color: C.fg }]));
  rows.push([{ text: "" }]);
  rows.push([
    { text: "  " },
    { text: f.connected ? G.ok : G.err, color: f.connected ? C.ok : C.danger },
    { text: f.connected ? " connected" : " offline", color: C.muted },
    { text: `  ${G.sep}  `, color: C.border },
    { text: G.ok, color: C.ok },
    { text: ` ${f.checks} ${f.checks === 1 ? "check" : "checks"} discovered`, color: C.muted },
  ]);
  rows.push([{ text: "" }]);
  return rows.map((r) => clampLine(r, w));
}

const isBlank = (l: Line): boolean => l.every((s) => s.text.trim() === "" && !s.bg);

/**
 * Render a transcript with an even rhythm: items bring their own leading and
 * trailing space, and runs of blank lines collapse to one so nothing drifts.
 */
export interface Rendered {
  lines: Line[];
  /** owners[i] is the index of the item that produced lines[i]. */
  owners: number[];
}

export function renderTranscript(items: Item[], width: number, cursorAt = -1, tick = 0, runningPhase = false): Rendered {
  const lines: Line[] = [];
  const owners: number[] = [];
  // Only the last phase animates, and only while the run is still going.
  const activePhase = runningPhase ? findLastIndex(items, (it) => it.kind === "phase") : -1;
  items.forEach((it, i) => {
    for (const line of itemToLines(it, width, i === cursorAt, i === activePhase, tick)) {
      if (isBlank(line) && (lines.length === 0 || isBlank(lines[lines.length - 1]!))) continue;
      lines.push(line);
      owners.push(i);
    }
  });
  while (lines.length && isBlank(lines[lines.length - 1]!)) { lines.pop(); owners.pop(); }
  return { lines, owners };
}

export function renderItems(items: Item[], width: number, cursorAt = -1, tick = 0, runningPhase = false): Line[] {
  return renderTranscript(items, width, cursorAt, tick, runningPhase).lines;
}

/** Open or close one specific block, for a click that landed on it. */
export function toggleExpandAt(items: Item[], index: number): Item[] | null {
  const it = items[index];
  if (!it || !expandable(it)) return null;
  return replace(items, index, setExpanded(it, !(it as { expanded?: boolean }).expanded));
}

/** Whether a click on this block would do anything. */
export const isExpandable = (it: Item | undefined): boolean => Boolean(it && expandable(it));
