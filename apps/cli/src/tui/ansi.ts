import { caps } from "./theme.js";
import type { Line, Seg } from "./box.js";

/** Nearest xterm-256 index for a hex color. */
function to256(r: number, g: number, b: number): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  return 16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5);
}

const NAMED: Record<string, number> = {
  black: 30, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37, gray: 90, grey: 90,
};

/** Wrap text in the strongest color escape the terminal supports. */
export function paint(text: string, color?: string, opts: { bold?: boolean; italic?: boolean; inverse?: boolean; dim?: boolean } = {}): string {
  if (caps.level === 0) return text;
  const codes: string[] = [];
  if (opts.bold) codes.push("1");
  if (opts.dim) codes.push("2");
  if (opts.italic) codes.push("3");
  if (opts.inverse) codes.push("7");
  if (color) {
    if (color.startsWith("#")) {
      const n = parseInt(color.slice(1), 16);
      const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
      codes.push(caps.level >= 3 ? `38;2;${r};${g};${b}` : `38;5;${to256(r, g, b)}`);
    } else if (NAMED[color] !== undefined) {
      codes.push(String(NAMED[color]));
    }
  }
  return codes.length ? `\x1b[${codes.join(";")}m${text}\x1b[0m` : text;
}

export const segToAnsi = (s: Seg): string => paint(s.text, s.color || undefined, s);

/** Render pre-laid-out lines to a printable string (used by --plain and --demo). */
export const linesToString = (lines: Line[]): string =>
  lines.map((l) => l.map(segToAnsi).join("").replace(/\s+$/, "")).join("\n");
