/**
 * Mouse handling.
 *
 * A terminal hands the mouse to the application or keeps it for itself; there
 * is no way to have both. So there are two modes:
 *
 *   select (default) — the terminal keeps the mouse, so a plain drag selects
 *     text. The application never sees clicks. Wheel ticks arrive as arrow
 *     keys, which is how scrolling still works.
 *
 *   click (`/mouse on`) — the application takes the mouse, so clicking a block
 *     can open it and the wheel reports properly. Selecting then needs the
 *     terminal's own bypass, which is shift on every mainstream terminal.
 */

/** Button-event tracking plus SGR encoding (works past column 223). */
export const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
export const MOUSE_OFF = "\x1b[?1006l\x1b[?1000l";

/** `ESC [ < button ; col ; row (M|m)` — M is press, m is release. */
const SGR = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
/** Ink hands us the sequence with the escape already stripped. */
const SGR_BARE = /^\[?<\d+;\d+;\d+[Mm]$/;

export type Wheel = "up" | "down";

export interface Click {
  /** One-based, as the terminal reports them. */
  col: number;
  row: number;
}

/** Wheel ticks in a chunk of terminal input, oldest first. */
export function parseWheel(data: string): Wheel[] {
  const out: Wheel[] = [];
  for (const m of data.matchAll(SGR)) {
    const button = Number(m[1]);
    if (!(button & 64)) continue; // not a wheel event
    out.push((button & 1) === 0 ? "up" : "down");
  }
  return out;
}

/** Left-button presses. Releases and drags are ignored so clicks stay clicks. */
export function parseClicks(data: string): Click[] {
  const out: Click[] = [];
  for (const m of data.matchAll(SGR)) {
    const button = Number(m[1]);
    const press = m[4] === "M";
    // Low two bits pick the button; 32 marks motion, 64 marks the wheel.
    if (!press || button & 64 || button & 32 || (button & 3) !== 0) continue;
    out.push({ col: Number(m[2]), row: Number(m[3]) });
  }
  return out;
}

/** True when this keystroke is really a mouse report that should not be typed. */
export const isMouseReport = (s: string): boolean =>
  s.includes("\x1b[<") || SGR_BARE.test(s);
