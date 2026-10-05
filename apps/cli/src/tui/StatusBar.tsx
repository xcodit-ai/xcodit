import { Box, Text } from "ink";
import { C, G, col } from "./theme.js";
import { displayWidth } from "./box.js";

export interface StatusSegment {
  text: string;
  color?: string;
  bold?: boolean;
  /** Higher survives longer when the terminal is narrow. */
  priority: number;
}

export const compactTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

/** Drop the lowest-priority segments until the bar fits. */
export function fitSegments(left: StatusSegment[], right: StatusSegment[], width: number, sep: string): { left: StatusSegment[]; right: StatusSegment[] } {
  const l = [...left];
  const r = [...right];
  const measure = () => {
    const w = (xs: StatusSegment[]) => xs.reduce((n, s) => n + displayWidth(s.text), 0) + Math.max(0, xs.length - 1) * displayWidth(sep);
    return w(l) + w(r) + 4;
  };
  while (measure() > width && (l.length > 1 || r.length > 0)) {
    const pool = [...l.map((s, i) => ({ s, i, from: "l" as const })), ...r.map((s, i) => ({ s, i, from: "r" as const }))];
    const worst = pool.reduce((a, b) => (b.s.priority < a.s.priority ? b : a));
    if (worst.s.priority >= 100) break; // never drop the essentials
    (worst.from === "l" ? l : r).splice(worst.i, 1);
  }
  return { left: l, right: r };
}

/**
 * Persistent bottom bar. Not rendered when stdout is not a terminal — the
 * caller decides; this component only draws.
 */
export function StatusBar({ left, right, width }: { left: StatusSegment[]; right: StatusSegment[]; width: number }) {
  const sep = `  ${G.info}  `;
  const fitted = fitSegments(left, right, width, sep);
  const row = (xs: StatusSegment[]) =>
    xs.map((s, i) => (
      <Text key={i}>
        {i > 0 ? <Text color={col(C.border)}>{sep}</Text> : null}
        <Text color={col(s.color ?? C.muted)} bold={s.bold}>{s.text}</Text>
      </Text>
    ));
  return (
    <Box justifyContent="space-between" paddingX={1} gap={2}>
      <Text wrap="truncate">{row(fitted.left)}</Text>
      <Text wrap="truncate">{row(fitted.right)}</Text>
    </Box>
  );
}
