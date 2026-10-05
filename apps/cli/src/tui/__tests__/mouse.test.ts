import assert from "node:assert/strict";
import { setTheme, detectCaps } from "../theme.js";
import { parseClicks, parseWheel, isMouseReport } from "../mouse.js";
import { renderTranscript, toggleExpandAt, isExpandable, type Item } from "../transcript.js";

/**
 * Mouse handling: telling wheel ticks from clicks, and turning a screen row
 * back into the block that drew it.
 */

const ESC = String.fromCharCode(27);
const pass: string[] = [];
const ok = (n: string) => pass.push(n);
setTheme("dark", { ...detectCaps(), level: 3, unicode: true, tty: true });

// ---- press, release, drag, wheel --------------------------------------------
assert.deepEqual(parseClicks(ESC + "[<0;12;7M"), [{ col: 12, row: 7 }], "a left press is a click");
assert.deepEqual(parseClicks(ESC + "[<0;12;7m"), [], "a release is not a second click");
assert.deepEqual(parseClicks(ESC + "[<32;12;7M"), [], "a drag is not a click");
assert.deepEqual(parseClicks(ESC + "[<2;12;7M"), [], "the right button is not a click");
assert.deepEqual(parseClicks(ESC + "[<64;12;7M"), [], "a wheel tick is not a click");
assert.deepEqual(parseWheel(ESC + "[<0;12;7M"), [], "a click is not a wheel tick");
assert.equal(isMouseReport(ESC + "[<0;12;7M"), true);
ok("clicks, drags, buttons and wheel ticks are told apart");

// ---- a screen row maps back to the block that drew it ----------------------
const long = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
const items: Item[] = [
  { kind: "user", text: "do the thing" },
  { kind: "phase", phase: "implement", role: "implementer" },
  { kind: "tool", id: "a", name: "bash", summary: "npm test", depth: 0, state: "ok", ms: 10, output: long, lines: 40 },
  { kind: "assistant", text: "done", done: true },
];
const { lines, owners } = renderTranscript(items, 70);
assert.equal(lines.length, owners.length, "every line reports an owner");
assert.ok(owners.every((o) => o >= 0 && o < items.length), "owners point at real blocks");

// The click handler's arithmetic: screen row -> line -> owner.
const topRows = 1; // the top bar
const firstVisible = 0;
const rowOf = (owner: number) => owners.indexOf(owner) - firstVisible + topRows + 1; // 1-based rows
const clickRow = rowOf(2); // the tool card
const lineIdx = firstVisible + (clickRow - 1 - topRows);
assert.equal(owners[lineIdx], 2, "a click on the card resolves to the card");
assert.ok(isExpandable(items[owners[lineIdx]!]), "and that block can be opened");

const opened = toggleExpandAt(items, owners[lineIdx]!)!;
assert.equal((opened[2] as { expanded?: boolean }).expanded, true, "clicking opens it");
const closed = toggleExpandAt(opened, 2)!;
assert.equal((closed[2] as { expanded?: boolean }).expanded, false, "clicking again closes it");
assert.equal(toggleExpandAt(items, 0), null, "a click on prose does nothing");
ok("a click resolves to the block under it and toggles only that one");

console.log(pass.map((p) => "ok   " + p).join("\n"));
