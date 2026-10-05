import { Box, Text } from "ink";
import { C, G, col, heartbeat, type Beat } from "./theme.js";
import { displayWidth } from "./box.js";

/** The wordmark: x in accent, the rest bright, and the dot that carries state. */
export function Wordmark({ beat, tick, small = true }: { beat: Beat; tick: number; small?: boolean }) {
  const dot = heartbeat(beat, tick);
  return (
    <Text>
      <Text color={col(C.accent)} bold>x</Text>
      <Text color={col(C.bright)} bold>codit</Text>
      <Text color={col(dot.color)} dimColor={dot.dim}>{(small ? " " : "  ") + dot.glyph}</Text>
    </Text>
  );
}

export interface TopBarProps {
  beat: Beat;
  tick: number;
  model: string;
  cwd: string;
  branch: string | null;
  dirty: boolean;
  step: string | null;
  elapsed: string;
  cost: string;
  width: number;
}

/**
 * Status strip above the transcript: who we are, where we are, and what this
 * turn is costing. Items drop right-to-left as the terminal narrows.
 */
export function TopBar(p: TopBarProps) {
  const right = [p.step, p.elapsed, p.cost].filter(Boolean) as string[];
  const rightW = right.join("  ").length + 2;
  const room = p.width - 10 - rightW;
  const items: { text: string; color: string }[] = [];
  if (room > 18) items.push({ text: p.model, color: C.muted });
  if (room > 34) items.push({ text: shorten(p.cwd, Math.max(12, room - 34)), color: C.muted });
  if (p.branch && room > 50) items.push({ text: `${G.branch} ${p.branch}${p.dirty ? "*" : ""}`, color: p.dirty ? C.warn : C.ok });

  return (
    <Box paddingX={1} gap={2} justifyContent="space-between">
      <Text wrap="truncate">
        <Wordmark beat={p.beat} tick={p.tick} />
        {items.map((i, n) => (
          <Text key={n} color={col(i.color)}>{"  " + i.text}</Text>
        ))}
      </Text>
      <Text wrap="truncate" color={col(C.muted)}>{right.join("  ")}</Text>
    </Box>
  );
}

/** The rail earns its keep only on wide terminals; below 100 columns it hides. */
export const RAIL_MIN_COLS = 100;

export function railWidth(cols: number, open: boolean, tty: boolean): number {
  if (!open || !tty || cols < RAIL_MIN_COLS) return 0;
  return Math.min(34, Math.max(26, Math.round(cols * 0.26)));
}

export interface RailProps {
  width: number;
  height: number;
  contextUsed: number;
  contextBudget: number;
  tools: { name: string; state: "ok" | "warn" | "off"; note?: string }[];
  files: { name: string; state: "read" | "changed" }[];
  tokensIn: number;
  tokensOut: number;
  calls: number;
}

/** The right rail: context, tools, touched files, session totals. */
export function Rail(p: RailProps) {
  const inner = p.width - 3;
  const pct = Math.min(100, Math.round((p.contextUsed / p.contextBudget) * 100));
  const barW = inner;
  const filled = Math.round((pct / 100) * barW);
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

  return (
    <Box flexDirection="column" width={p.width} height={p.height} paddingX={1} flexShrink={0}>
      <Heading>context</Heading>
      <Text>
        <Text color={col(C.accent)}>{G.barFull.repeat(filled)}</Text>
        <Text color={col(C.border)}>{G.barEmpty.repeat(Math.max(0, barW - filled))}</Text>
      </Text>
      <Row left={`${k(p.contextUsed)} / ${k(p.contextBudget)}`} right={`${pct}%`} />

      <Box marginTop={1} flexDirection="column">
        <Heading>tools</Heading>
        {p.tools.slice(0, 6).map((t) => (
          <Text key={t.name} wrap="truncate">
            <Text color={col(t.state === "ok" ? C.ok : t.state === "warn" ? C.warn : C.faint)}>
              {t.state === "off" ? G.stepTodo : G.heart}
            </Text>
            <Text color={col(C.fg)}> {t.name}</Text>
            {t.note ? <Text color={col(C.faint)}> {t.note}</Text> : null}
          </Text>
        ))}
      </Box>

      {p.files.length ? (
        <Box marginTop={1} flexDirection="column">
          <Heading>files</Heading>
          {p.files.slice(0, 5).map((f) => (
            <Text key={f.name} wrap="truncate">
              <Text color={col(f.state === "changed" ? C.accent : C.fg)}>{f.name}</Text>
              {f.state === "changed" ? <Text color={col(C.muted)}> M</Text> : null}
            </Text>
          ))}
        </Box>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        <Heading>session</Heading>
        <Row left="tokens in" right={p.tokensIn.toLocaleString()} />
        <Row left="tokens out" right={p.tokensOut.toLocaleString()} />
        <Row left="tool calls" right={String(p.calls)} />
      </Box>
    </Box>
  );
}

const Heading = ({ children }: { children: string }) => (
  <Text color={col(C.muted)} bold>{children.toUpperCase()}</Text>
);

function Row({ left, right }: { left: string; right: string }) {
  return (
    <Box justifyContent="space-between">
      <Text color={col(C.muted)} wrap="truncate">{left}</Text>
      <Text color={col(C.fg)}>{right}</Text>
    </Box>
  );
}

/** Hotkey strip under the composer. */
export function HotKeys({ hints, width }: { hints: [string, string][]; width: number }) {
  const out: [string, string][] = [];
  let used = 0;
  for (const h of hints) {
    const w = displayWidth(h[0] + h[1]) + 4;
    if (used + w > width - 2) break;
    used += w;
    out.push(h);
  }
  return (
    <Box paddingX={1} gap={2}>
      {out.map(([key, label]) => (
        <Text key={key + label} wrap="truncate">
          <Text color={col(C.muted)}>{key}</Text>
          <Text color={col(C.faint)}> {label}</Text>
        </Text>
      ))}
    </Box>
  );
}

function shorten(p: string, max: number): string {
  const s = p.replace(/\\/g, "/");
  return s.length <= max ? s : G.ellipsis + s.slice(-(max - 1));
}
