import { C, G } from "./theme.js";
import { clampLine, displayWidth, pad, type Line } from "./box.js";
import { highlightLine, languageOf } from "./highlight.js";

export type Op = "same" | "add" | "del";
export interface Row {
  op: Op;
  left?: string;
  right?: string;
  leftNo?: number;
  rightNo?: number;
}

/** Side-by-side is only worth it on wide terminals. */
export const SIDE_BY_SIDE_MIN_COLS = 120;

/**
 * Line diff via longest common subsequence. Inputs here are edit previews and
 * small patches, so the quadratic table is bounded rather than optimized.
 */
export function diffLines(before: string, after: string, maxLines = 400): Row[] {
  const a = before.split("\n").slice(0, maxLines);
  const b = after.split("\n").slice(0, maxLines);
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const rows: Row[] = [];
  let i = 0, j = 0, la = 0, lb = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { rows.push({ op: "same", left: a[i], right: b[j], leftNo: ++la, rightNo: ++lb }); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { rows.push({ op: "del", left: a[i], leftNo: ++la }); i++; }
    else { rows.push({ op: "add", right: b[j], rightNo: ++lb }); j++; }
  }
  while (i < n) rows.push({ op: "del", left: a[i++], leftNo: ++la });
  while (j < m) rows.push({ op: "add", right: b[j++], rightNo: ++lb });
  return rows;
}

/** Drop long runs of unchanged lines, keeping `context` on each side. */
export function collapseContext(rows: Row[], context = 2): (Row | { op: "skip"; count: number })[] {
  const keep = new Set<number>();
  rows.forEach((r, i) => {
    if (r.op === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) keep.add(k);
  });
  const out: (Row | { op: "skip"; count: number })[] = [];
  let run = 0;
  rows.forEach((r, i) => {
    if (keep.has(i)) {
      if (run) { out.push({ op: "skip", count: run }); run = 0; }
      out.push(r);
    } else run++;
  });
  if (run) out.push({ op: "skip", count: run });
  return out;
}

const marker = (op: Op) => (op === "add" ? "+" : op === "del" ? "-" : " ");
const opColor = (op: Op) => (op === "add" ? C.addFg : op === "del" ? C.delFg : C.faint);
const opBg = (op: Op) => (op === "add" ? C.addBg : op === "del" ? C.delBg : "");

function num(n: number | undefined, w: number): string {
  return (n === undefined ? "" : String(n)).padStart(w);
}

/** Unified: one column, line numbers from both sides. */
export function unifiedDiff(rows: (Row | { op: "skip"; count: number })[], width: number, lang: string | null): Line[] {
  const w = Math.max(3, String(rows.length + 8).length);
  return rows.map((r) => {
    if (r.op === "skip") return [{ text: `  ${G.ellipsis} ${r.count} unchanged`, color: C.muted, italic: true }] as Line;
    const row = r as Row;
    const text = row.op === "add" ? row.right ?? "" : row.left ?? "";
    const body = row.op === "same" ? [{ text, color: C.fg }] : highlightLine(text, languageOf(lang ?? undefined));
    const bg = opBg(row.op);
    return clampLine(
      [
        { text: num(row.leftNo, w), color: C.faint },
        { text: " " },
        { text: num(row.rightNo, w), color: C.faint },
        { text: ` ${marker(row.op)} `, color: opColor(row.op), bold: row.op !== "same", bg },
        ...(row.op === "same" ? body : body.map((x) => ({ ...x, color: opColor(row.op), bg }))),
      ],
      width,
    );
  });
}

/** Side-by-side: before on the left, after on the right, with a gutter. */
export function sideBySideDiff(rows: (Row | { op: "skip"; count: number })[], width: number, lang: string | null): Line[] {
  const numW = 4;
  const half = Math.floor((width - numW * 2 - 7) / 2);
  const cell = (text: string | undefined, no: number | undefined, op: Op, side: "l" | "r"): Line => {
    const show = side === "l" ? op !== "add" : op !== "del";
    if (!show || text === undefined) return pad([{ text: num(undefined, numW), color: C.faint }], numW + 2 + half);
    const color = op === "same" ? C.faint : opColor(op);
    const bg = opBg(op);
    const segs = op === "same" ? [{ text, color }] : highlightLine(text, languageOf(lang ?? undefined)).map((x) => ({ ...x, color, bg }));
    const row = pad(clampLine([{ text: num(no, numW), color: C.faint }, { text: op === "same" ? "  " : ` ${marker(op)} `, color, bg }, ...segs], numW + 2 + half), numW + 2 + half);
    // The tint has to reach the end of the cell, padding included.
    return bg ? row.map((x) => ({ ...x, bg: x.bg ?? bg })) : row;
  };
  return rows.map((r) => {
    if (r.op === "skip") return [{ text: `  ${G.ellipsis} ${r.count} unchanged`, color: C.muted, italic: true }] as Line;
    const row = r as Row;
    return clampLine(
      [...cell(row.left, row.leftNo, row.op, "l"), { text: ` ${G.boxV} `, color: C.border }, ...cell(row.right, row.rightNo, row.op, "r")],
      width,
    );
  });
}

/** Picks the layout that fits the terminal. */
export function renderDiff(before: string, after: string, width: number, lang: string | null = null, context = 2): Line[] {
  const rows = collapseContext(diffLines(before, after), context);
  return width >= SIDE_BY_SIDE_MIN_COLS ? sideBySideDiff(rows, width, lang) : unifiedDiff(rows, width, lang);
}

export const diffStat = (before: string, after: string): { added: number; removed: number } => {
  const rows = diffLines(before, after);
  return { added: rows.filter((r) => r.op === "add").length, removed: rows.filter((r) => r.op === "del").length };
};

export { displayWidth };
