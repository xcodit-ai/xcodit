import { Box, Text } from "ink";
import { C, G, col } from "./theme.js";
import { wrap } from "./markdown.js";
import { matchPositions } from "./fuzzy.js";
import type { Command } from "./commands.js";

/** The composer looks the same whatever the run did; only waiting changes it. */
export type PromptState = "idle" | "busy" | "confirm" | "notes";

const promptGlyph = (s: PromptState) =>
  s === "busy" ? G.promptBusy : s === "confirm" || s === "notes" ? G.promptConfirm : G.promptIdle;
const promptColor = (s: PromptState) =>
  s === "busy" ? C.accent : s === "confirm" ? C.warn : s === "notes" ? C.planner : C.accent;

/** Multi-line editor: the caret is drawn as an inverse cell inside the text. */
export function InputBox({
  value, cursor, placeholder, state, width,
}: {
  value: string; cursor: number; placeholder: string; state: PromptState; width: number;
}) {
  const glyph = promptGlyph(state);
  const color = promptColor(state);
  const inner = Math.max(10, width - 4 - glyph.length - 1);

  // Lay the caret into the text so wrapping and the caret agree.
  const withCaret = value.length ? value : "";
  const rows: { text: string; caretAt: number | null }[] = [];
  let consumed = 0;
  for (const logical of withCaret.split("\n")) {
    const pieces = wrap(logical, inner);
    for (const piece of pieces) {
      const start = consumed;
      const end = start + piece.length;
      const caretAt = cursor >= start && cursor <= end ? cursor - start : null;
      rows.push({ text: piece, caretAt });
      consumed = end + (piece.length < logical.length ? 1 : 0);
    }
    consumed = Math.min(withCaret.length, consumed + 1); // newline
  }
  if (!rows.length) rows.push({ text: "", caretAt: 0 });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={col(state === "busy" ? C.border : color)} paddingX={1}>
      {rows.map((r, i) => (
        <Text key={i} wrap="truncate">
          <Text color={col(color)} bold>{i === 0 ? glyph + " " : " ".repeat(glyph.length + 1)}</Text>
          {value.length === 0 && i === 0 ? (
            <>
              <Text inverse> </Text>
              <Text color={col(C.muted)}>{placeholder}</Text>
            </>
          ) : (
            <CaretText text={r.text} caretAt={r.caretAt} />
          )}
        </Text>
      ))}
    </Box>
  );
}

function CaretText({ text, caretAt }: { text: string; caretAt: number | null }) {
  if (caretAt === null) return <Text>{text}</Text>;
  return (
    <>
      <Text>{text.slice(0, caretAt)}</Text>
      <Text inverse>{text[caretAt] ?? " "}</Text>
      <Text>{text.slice(caretAt + 1)}</Text>
    </>
  );
}

/** How many command rows fit before the list starts scrolling. */
export const MENU_ROWS = 8;

/**
 * Command palette: a panel whose first row echoes the query and whose
 * selected row is filled. Longer lists scroll a window around the selection
 * rather than truncating, so every command stays reachable.
 */
export function CommandMenu({ matches, selected, query, width }: { matches: Command[]; selected: number; query: string; width: number }) {
  if (!matches.length) return null;
  const nameW = Math.max(...matches.map((m) => m.name.length)) + 2;
  const inner = width - 4;
  const start = Math.max(0, Math.min(selected - Math.floor(MENU_ROWS / 2), matches.length - MENU_ROWS));
  const shown = matches.slice(start, start + MENU_ROWS);
  const hidden = matches.length - shown.length;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={col(C.border)} paddingX={1}>
      <Text wrap="truncate">
        <Text color={col(C.accent)}>/</Text>
        <Text color={col(C.bright)}>{query.replace(/^\//, "")}</Text>
        <Text inverse> </Text>
        {hidden > 0 ? (
          <Text color={col(C.faint)}>{`   ${selected + 1}/${matches.length}  ${G.arrow === "→" ? "↑↓" : "^v"} more`}</Text>
        ) : null}
      </Text>
      {shown.map((m, i) => {
        const on = start + i === selected;
        const label = m.name.padEnd(nameW);
        const help = m.help.slice(0, Math.max(0, inner - nameW - 2));
        return (
          <Text key={m.name} wrap="truncate">
            <Text color={col(on ? C.accent : C.fg)} inverse={on} bold={on}>{label}</Text>
            <Text color={col(on ? C.fg : C.muted)} inverse={on}>{help.padEnd(Math.max(0, inner - nameW))}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

/** Ctrl-R overlay: query line plus ranked history with matched letters lit. */
export function HistorySearch({ query, matches, selected, width }: { query: string; matches: string[]; selected: number; width: number }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={col(C.planner)} paddingX={1}>
      <Text wrap="truncate">
        <Text color={col(C.planner)} bold>history </Text>
        <Text>{query}</Text>
        <Text inverse> </Text>
        <Text color={col(C.muted)}>{matches.length ? `  ${matches.length} match${matches.length > 1 ? "es" : ""}` : "  no matches"}</Text>
      </Text>
      {matches.slice(0, 5).map((m, i) => {
        const hit = matchPositions(query, m);
        const on = i === selected;
        return (
          <Text key={i} wrap="truncate">
            <Text color={col(on ? C.accent : C.muted)}>{on ? `${G.user} ` : "  "}</Text>
            {[...m.slice(0, width - 8)].map((ch, j) => (
              <Text key={j} color={col(hit.has(j) ? C.accent : on ? C.fg : C.fg)} bold={hit.has(j)}>{ch}</Text>
            ))}
          </Text>
        );
      })}
    </Box>
  );
}
