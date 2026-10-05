import { SPECIALISTS, type Role } from "@xcodit/shared";

/**
 * "signal-dark" — the one place colors, glyphs and markers are defined.
 *
 * `C` is mutated in place by setTheme() so every module can `import { C }`
 * once and still follow theme changes with no per-render lookup cost.
 */

export type ThemeName = "dark" | "light";
/** 0 = no color, 1 = 16 colors, 2 = 256, 3 = truecolor. */
export type ColorLevel = 0 | 1 | 2 | 3;

export interface Palette {
  /** One accent only: agent glyph, cursor, links, active step. */
  accent: string;
  bg: string;
  panel: string;
  border: string;
  /** Brightest text, for the wordmark and what the user typed. */
  bright: string;
  fg: string;
  muted: string;
  /** Dimmest tier: pending steps, hotkey hints, unchanged diff lines. */
  faint: string;
  ok: string;
  warn: string;
  danger: string;
  /** Diff row tints. */
  addBg: string;
  delBg: string;
  addFg: string;
  delFg: string;
  /** Specialist hues, keyed by agent role. */
  planner: string;
  implementer: string;
  navigator: string;
  reviewer: string;
  compactor: string;
  verify: string;
  /** Syntax highlighting. */
  synKeyword: string;
  synString: string;
  synNumber: string;
  synComment: string;
  synFunc: string;
  synPunct: string;
}

const DARK: Palette = {
  accent: "#ff5a1f",
  bg: "#0b0e14",
  panel: "#0f131b",
  border: "#1c2230",
  bright: "#f4f6f8",
  fg: "#c9d1d9",
  muted: "#8b95a5",
  faint: "#4c5666",
  ok: "#34d399",
  warn: "#f5b942",
  danger: "#f87171",
  addBg: "#0f2a1f",
  delBg: "#2a1518",
  addFg: "#34d399",
  delFg: "#f87171",
  planner: "#e879f9",
  implementer: "#22d3ee",
  navigator: "#8b95a5",
  reviewer: "#f5b942",
  compactor: "#8b95a5",
  verify: "#34d399",
  synKeyword: "#e879f9",
  synString: "#34d399",
  synNumber: "#f5b942",
  synComment: "#4c5666",
  synFunc: "#22d3ee",
  synPunct: "#8b95a5",
};

/** The same system inverted: paper, not screen. */
const LIGHT: Palette = {
  accent: "#d1400c",
  bg: "#fbfbfa",
  panel: "#f3f4f6",
  border: "#dfe3e8",
  bright: "#0b0e14",
  fg: "#2b323c",
  muted: "#66707e",
  faint: "#a8b0bb",
  ok: "#047857",
  warn: "#a15c07",
  danger: "#b42318",
  addBg: "#e7f6ee",
  delBg: "#fdecea",
  addFg: "#047857",
  delFg: "#b42318",
  planner: "#a21caf",
  implementer: "#0e7490",
  navigator: "#66707e",
  reviewer: "#a15c07",
  compactor: "#66707e",
  verify: "#047857",
  synKeyword: "#a21caf",
  synString: "#047857",
  synNumber: "#a15c07",
  synComment: "#a8b0bb",
  synFunc: "#0e7490",
  synPunct: "#66707e",
};

/** 16-color fallback: named ANSI so the mapping is ours, not chalk's guess. */
const ANSI16: Record<keyof Palette, string> = {
  accent: "yellow", bg: "black", panel: "black", border: "gray",
  bright: "whiteBright", fg: "white", muted: "gray", faint: "gray",
  ok: "green", warn: "yellow", danger: "red",
  addBg: "", delBg: "", addFg: "green", delFg: "red",
  planner: "magenta", implementer: "cyan", navigator: "gray", reviewer: "yellow", compactor: "gray",
  verify: "green",
  synKeyword: "magenta", synString: "green", synNumber: "yellow", synComment: "gray", synFunc: "cyan", synPunct: "gray",
};

/** Live palette. Import once; setTheme() rewrites it in place. */
export const C: Palette = { ...DARK };

export interface Caps {
  level: ColorLevel;
  unicode: boolean;
  /** stdout is an interactive terminal. */
  tty: boolean;
}

export function detectCaps(stream: NodeJS.WriteStream = process.stdout): Caps {
  const env = process.env;
  const tty = Boolean(stream.isTTY);
  const dumb = env.TERM === "dumb";
  const noColor = "NO_COLOR" in env && env.NO_COLOR !== "";
  const forced = env.FORCE_COLOR;

  let level: ColorLevel = 0;
  if (forced === "0") level = 0;
  else if (noColor || dumb) level = 0;
  else if (forced === "3") level = 3;
  else if (forced === "2") level = 2;
  else if (forced === "1") level = 1;
  else if (!tty) level = 0;
  else if (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit" || env.TERM_PROGRAM === "iTerm.app" || env.TERM_PROGRAM === "WezTerm" || env.WT_SESSION) level = 3;
  else if (/-256(color)?$/i.test(env.TERM ?? "")) level = 2;
  else if (env.TERM) level = 1;

  // Windows consoles and most modern terminals handle the box/braille set; TERM=dumb and
  // legacy code pages do not.
  const unicode = !dumb && env.XCODIT_ASCII !== "1" && (process.platform !== "win32" || Boolean(env.WT_SESSION || env.TERM_PROGRAM || env.TERM));
  return { level, unicode, tty };
}

export let caps: Caps = detectCaps();

/** Glyph set; falls back to ASCII when the terminal can't be trusted with Unicode. */
export interface Glyphs {
  user: string; agent: string; tool: string; ok: string; err: string; info: string; warn: string; sub: string;
  /** Step checklist. */
  stepDone: string; stepActive: string; stepTodo: string;
  spinner: string[];
  /** The heartbeat dot, by agent state. */
  heart: string; heartRing: string;
  cursor: string;
  barFull: string; barEmpty: string;
  boxTL: string; boxTR: string; boxBL: string; boxBR: string; boxH: string; boxV: string;
  /** Card header dividers. */
  tee: string; teeR: string;
  arrow: string; branch: string; ellipsis: string; sep: string;
  collapsed: string; expanded: string;
  promptIdle: string; promptBusy: string; promptConfirm: string; promptError: string;
}

const UNICODE: Glyphs = {
  user: "▸", agent: "◆", tool: "⚙", ok: "✓", err: "✗", info: "·", warn: "!", sub: "↳",
  stepDone: "✓", stepActive: "●", stepTodo: "○",
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  heart: "●", heartRing: "◉",
  cursor: "█",
  barFull: "━", barEmpty: "─",
  boxTL: "╭", boxTR: "╮", boxBL: "╰", boxBR: "╯", boxH: "─", boxV: "│",
  tee: "├", teeR: "┤",
  arrow: "→", branch: "⎇", ellipsis: "…", sep: "·",
  collapsed: "▸", expanded: "▾",
  promptIdle: "›", promptBusy: "…", promptConfirm: "!", promptError: "✗",
};

const ASCII: Glyphs = {
  user: ">", agent: "*", tool: "%", ok: "+", err: "x", info: "-", warn: "!", sub: "\\",
  stepDone: "+", stepActive: "*", stepTodo: "o",
  spinner: ["|", "/", "-", "\\"],
  heart: "*", heartRing: "o",
  cursor: "_",
  barFull: "=", barEmpty: "-",
  boxTL: "+", boxTR: "+", boxBL: "+", boxBR: "+", boxH: "-", boxV: "|",
  tee: "+", teeR: "+",
  arrow: "->", branch: "@", ellipsis: "...", sep: "-",
  collapsed: ">", expanded: "v",
  promptIdle: ">", promptBusy: "...", promptConfirm: "!", promptError: "x",
};

export let G: Glyphs = UNICODE;

let current: ThemeName = "dark";
export const themeName = () => current;

/** Apply a theme and terminal capabilities. Safe to call before first render. */
export function setTheme(name: ThemeName, c: Caps = caps): void {
  current = name;
  caps = c;
  G = c.unicode ? UNICODE : ASCII;
  const base = name === "light" ? LIGHT : DARK;
  const next: Palette = { ...base };
  if (c.level === 0) {
    for (const k of Object.keys(next) as (keyof Palette)[]) next[k] = "";
  } else if (c.level === 1) {
    for (const k of Object.keys(next) as (keyof Palette)[]) next[k] = ANSI16[k];
  }
  Object.assign(C, next);
}

/** Ink accepts undefined for "no color"; empty strings would throw. */
export const col = (v: string): string | undefined => (v === "" ? undefined : v);

export const roleColor = (role: Role | string): string =>
  (C as unknown as Record<string, string>)[role] ?? C.fg;

export const roleModel = (role: Role | string): string =>
  (SPECIALISTS as Record<string, { model: string }>)[role]?.model ?? role;

export const roleGlyph = (role: Role | string): string =>
  caps.unicode ? ((SPECIALISTS as Record<string, { glyph: string }>)[role]?.glyph ?? G.agent) : G.agent;

export const PHASE_LABEL: Record<string, string> = {
  plan: "planning",
  implement: "implementing",
  verify: "verifying",
  repair: "repairing",
  review: "reviewing",
  fix: "fixing review issues",
};

// ---- the heartbeat ----------------------------------------------------------

/** The dot beside the wordmark is the only thing that moves when nothing happens. */
export type Beat = "idle" | "thinking" | "tool" | "needs-you" | "error" | "done";

/** Returns the dot's glyph and color for this frame (tick = ~80ms). */
export function heartbeat(state: Beat, tick: number): { glyph: string; color: string; dim: boolean } {
  switch (state) {
    case "thinking":
      // Hard blink at cursor rate.
      return { glyph: G.heart, color: C.accent, dim: tick % 8 >= 4 };
    case "tool":
      // The dot becomes a ring spinner while a tool runs.
      return { glyph: G.spinner[tick % G.spinner.length]!, color: C.accent, dim: false };
    case "needs-you":
      return { glyph: tick % 10 < 5 ? G.heartRing : G.heart, color: C.warn, dim: false };
    case "error":
      return { glyph: G.heart, color: C.danger, dim: false };
    case "done":
      return { glyph: G.heart, color: C.ok, dim: false };
    default:
      // Slow breathe: 2.4s at 80ms a tick is 30 frames.
      return { glyph: G.heart, color: C.accent, dim: tick % 30 >= 18 };
  }
}
