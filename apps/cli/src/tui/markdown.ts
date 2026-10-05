import { C, G } from "./theme.js";
import { clampLine, displayWidth, pad, type Line, type Seg } from "./box.js";
import { highlightLine, languageOf } from "./highlight.js";

/** Wrap plain text to width, preserving explicit newlines. */
export function wrap(text: string, width: number, indent = 0): string[] {
  const out: string[] = [];
  const w = Math.max(8, width);
  const padding = " ".repeat(indent);
  for (const raw of text.split("\n")) {
    let line = raw.replace(/\t/g, "  ");
    if (displayWidth(line) <= w) { out.push(line); continue; }
    let first = true;
    while (displayWidth(line) > w) {
      let cut = line.lastIndexOf(" ", w);
      if (cut <= indent) cut = w;
      out.push((first ? "" : padding) + line.slice(0, cut).trimEnd());
      line = line.slice(cut).trimStart();
      first = false;
    }
    out.push((first ? "" : padding) + line);
  }
  return out;
}

/** Inline spans: `code`, **bold**, _italic_ and bare links. */
export function inline(s: string): Seg[] {
  const segs: Seg[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\bhttps?:\/\/\S+)/g;
  let i = 0;
  for (const m of s.matchAll(re)) {
    if (m.index! > i) segs.push({ text: s.slice(i, m.index), color: C.fg });
    const t = m[0]!;
    if (t.startsWith("`")) segs.push({ text: t.slice(1, -1), color: C.accent });
    else if (t.startsWith("**")) segs.push({ text: t.slice(2, -2), color: C.fg, bold: true });
    else segs.push({ text: t, color: C.implementer, italic: true });
    i = m.index! + t.length;
  }
  if (i < s.length) segs.push({ text: s.slice(i), color: C.fg });
  return segs.length ? segs : [{ text: "", color: C.fg }];
}

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isTableRule = (l: string) => /^\s*\|[\s:|-]+\|\s*$/.test(l);

const splitRow = (l: string): string[] =>
  l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

/**
 * Tables reflow to the terminal: columns are sized by content, then shrunk
 * proportionally (widest first) until the table fits.
 */
export function tableLines(rows: string[][], width: number): Line[] {
  const cols = Math.max(...rows.map((r) => r.length));
  const grid = rows.map((r) => Array.from({ length: cols }, (_, i) => r[i] ?? ""));
  const widths = Array.from({ length: cols }, (_, i) => Math.max(...grid.map((r) => displayWidth(r[i]!))));
  const overhead = cols * 3 + 1;
  let total = widths.reduce((a, b) => a + b, 0) + overhead;
  while (total > width) {
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest]! <= 6) break;
    widths[widest]!--;
    total--;
  }
  const line = (cells: string[], header: boolean): Line =>
    clampLine(
      cells.flatMap((c, i): Seg[] => [
        { text: i === 0 ? `${G.boxV} ` : " ", color: C.border },
        // Cells carry inline markup too, so `code` and **bold** render here.
        ...pad(clampLine(header ? [{ text: c, color: C.fg, bold: true }] : inline(c), widths[i]!), widths[i]!),
        { text: " " + G.boxV, color: C.border },
      ]),
      width,
    );
  const rule: Line = [{ text: widths.map((w) => G.boxH.repeat(w + 2)).join(G.boxH), color: C.border }];
  const [head, ...body] = grid;
  return [line(head!, true), rule, ...body.map((r) => line(r, false))];
}

/** Headings, lists, block quotes, fenced code with highlighting, and tables. */
export function markdownLines(text: string, width: number): Line[] {
  const lines: Line[] = [];
  const src = text.split("\n");
  let i = 0;

  while (i < src.length) {
    const raw = src[i]!;

    // fenced code
    const fence = raw.match(/^\s*```+\s*([\w+-]*)\s*$/);
    if (fence) {
      const lang = fence[1] || null;
      const code: string[] = [];
      i++;
      while (i < src.length && !/^\s*```+\s*$/.test(src[i]!)) code.push(src[i++]!);
      i++; // closing fence
      const gutterW = String(code.length).length;
      const inner = Math.max(12, width - gutterW - 4);
      if (lang) lines.push([{ text: "  " + lang, color: C.muted, italic: true }]);
      code.forEach((l, n) => {
        const parts = wrap(l, inner);
        parts.forEach((part, k) => {
          lines.push([
            { text: "  " + (k === 0 ? String(n + 1).padStart(gutterW) : " ".repeat(gutterW)), color: C.border },
            { text: " " },
            ...highlightLine(part, languageOf(lang ?? undefined)),
          ]);
        });
      });
      continue;
    }

    // table
    if (isTableRow(raw) && i + 1 < src.length && isTableRule(src[i + 1]!)) {
      const rows: string[][] = [splitRow(raw)];
      i += 2;
      while (i < src.length && isTableRow(src[i]!)) rows.push(splitRow(src[i++]!));
      lines.push(...tableLines(rows, width));
      continue;
    }

    i++;

    const h = raw.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      lines.push([{ text: h[2]!, bold: true, color: C.fg }]);
      if (h[1]!.length <= 2) lines.push([{ text: G.boxH.repeat(Math.min(width, displayWidth(h[2]!))), color: C.border }]);
      continue;
    }

    const quote = raw.match(/^\s*>\s?(.*)$/);
    if (quote) {
      wrap(quote[1]!, width - 2).forEach((t) => lines.push([{ text: `${G.boxV} `, color: C.accent }, { text: t, color: C.fg, italic: true }]));
      continue;
    }

    const bullet = raw.match(/^(\s*)([-*]|\d{1,2}[.)])\s+(.*)$/);
    const body = bullet ? bullet[3]! : raw;
    const marker = bullet ? (/^\d/.test(bullet[2]!) ? bullet[2]! + " " : "• ") : "";
    const prefix = bullet ? bullet[1]! + marker : "";
    wrap(body, Math.max(10, width - displayWidth(prefix))).forEach((t, k) =>
      lines.push([
        { text: k === 0 ? prefix : " ".repeat(displayWidth(prefix)), color: bullet ? C.accent : undefined },
        ...inline(t),
      ]),
    );
  }
  return lines;
}
