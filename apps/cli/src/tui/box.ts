import { C, G, col } from "./theme.js";

export interface Seg {
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  bg?: string;
  inverse?: boolean;
}
export type Line = Seg[];

/** Printable width; good enough for the box/braille/CJK ranges we emit. */
export function displayWidth(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f)) continue; // ZWJ / variation selectors
    n += (c >= 0x1100 && (c <= 0x115f || c === 0x2329 || c === 0x232a ||
      (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1f64f) || (c >= 0x1f900 && c <= 0x1f9ff))) ? 2 : 1;
  }
  return n;
}

export const lineWidth = (l: Line): number => l.reduce((n, s) => n + displayWidth(s.text), 0);

/** Truncate a styled line to `width`, appending an ellipsis when it was cut. */
export function clampLine(line: Line, width: number): Line {
  if (lineWidth(line) <= width) return line;
  const out: Line = [];
  let left = width - 1;
  for (const s of line) {
    const w = displayWidth(s.text);
    if (w <= left) { out.push(s); left -= w; continue; }
    let acc = "";
    for (const ch of s.text) {
      const cw = displayWidth(ch);
      if (cw > left) break;
      acc += ch; left -= cw;
    }
    if (acc) out.push({ ...s, text: acc });
    break;
  }
  out.push({ text: G.ellipsis, color: C.muted });
  return out;
}

export function pad(line: Line, width: number): Line {
  const gap = width - lineWidth(line);
  return gap > 0 ? [...line, { text: " ".repeat(gap) }] : line;
}

export interface BoxOptions {
  title?: string;
  /** Right-aligned hint in the top border, e.g. a duration or a count. */
  hint?: string;
  color?: string;
  /** Left indent applied to the whole box. */
  indent?: number;
  /** Total width available (the box fills it). */
  width: number;
}

/**
 * A single rounded frame around pre-rendered lines. Boxes are never nested:
 * callers pass plain content lines only.
 */
export function box(content: Line[], o: BoxOptions): Line[] {
  const color = o.color ?? C.border;
  const indent = o.indent ?? 0;
  const inner = Math.max(8, o.width - indent - 4);
  const lead = indent ? [{ text: " ".repeat(indent) }] : [];
  const bar = (n: number): Seg => ({ text: G.boxH.repeat(Math.max(0, n)), color });

  const title = o.title ? ` ${o.title} ` : "";
  const hint = o.hint ? ` ${o.hint} ` : "";
  const fill = Math.max(0, inner + 2 - displayWidth(title) - displayWidth(hint) - 2);
  const top: Line = [
    ...lead,
    { text: G.boxTL, color },
    bar(1),
    ...(title ? [{ text: title, color: o.color ?? C.fg, bold: true }] : []),
    bar(fill),
    ...(hint ? [{ text: hint, color: C.muted }] : []),
    bar(1),
    { text: G.boxTR, color },
  ];
  const bottom: Line = [...lead, { text: G.boxBL, color }, bar(inner + 2), { text: G.boxBR, color }];
  const body = content.map((l) => [
    ...lead,
    { text: G.boxV + " ", color },
    ...pad(clampLine(l, inner), inner),
    { text: " " + G.boxV, color },
  ]);
  return [top, ...body, bottom];
}

/** Ink's <Text> rejects empty-string colors, so normalize at the edge. */
export const segColor = (s: Seg) => col(s.color ?? "");
export const segBg = (s: Seg) => col(s.bg ?? "");

export interface CardOptions {
  /** Left indent applied to the whole card. */
  indent?: number;
  width: number;
  color?: string;
  /** Panel fill behind the card body. Off by default: a filled block reads as
   *  a hole in terminals whose background is not ours. */
  fill?: string;
  /** Header: glyph, name, argument, right-aligned status, open/closed marker. */
  head: { glyph: string; glyphColor: string; name: string; arg?: string; status?: Seg[]; marker?: string };
  body?: Line[];
  /** Key hints or hunk counters along the bottom edge. */
  foot?: Line;
}

/**
 * The tool card from the design: a rounded panel whose header carries the
 * tool, its argument and its result, with the body divided by a rule.
 */
export function card(o: CardOptions): Line[] {
  const color = o.color ?? C.border;
  const indent = o.indent ?? 0;
  const inner = Math.max(10, o.width - indent - 4);
  const lead: Seg[] = indent ? [{ text: " ".repeat(indent) }] : [];
  const bar = (n: number): Seg => ({ text: G.boxH.repeat(Math.max(0, n)), color });
  const fill = o.fill ?? "";
  const frame = (l: Line): Line => {
    const row: Line = [...lead, { text: G.boxV + " ", color }, ...pad(clampLine(l, inner), inner), { text: " " + G.boxV, color }];
    // The fill has to cover the padding too, or the card looks ragged.
    return fill ? row.map((seg, i) => (i === 0 && lead.length ? seg : { ...seg, bg: seg.bg ?? fill })) : row;
  };
  const rule: Line = [...lead, { text: G.tee, color }, bar(inner + 2), { text: G.teeR, color }];

  const { glyph, glyphColor, name, arg, status = [], marker } = o.head;
  const left: Line = [
    { text: glyph + " ", color: glyphColor },
    { text: name, color: C.fg },
    ...(arg ? [{ text: " " + arg, color: C.muted }] : []),
  ];
  const right: Line = [...status, ...(marker ? [{ text: "  " + marker, color: C.faint }] : [])];
  const gap = Math.max(1, inner - lineWidth(left) - lineWidth(right));
  const header = frame([...left, { text: " ".repeat(gap) }, ...right]);

  const out: Line[] = [
    [...lead, { text: G.boxTL, color }, bar(inner + 2), { text: G.boxTR, color }],
    header,
  ];
  if (o.body?.length) {
    out.push(rule, ...o.body.map(frame));
  }
  if (o.foot) out.push(rule, frame(o.foot));
  out.push([...lead, { text: G.boxBL, color }, bar(inner + 2), { text: G.boxBR, color }]);
  return out;
}

/** Key hint: a lit letter and its label, as used along card footers. */
export const keyHint = (key: string, label: string, color: string): Seg[] => [
  { text: key, color, bold: true },
  { text: " " + label, color: C.muted },
];
