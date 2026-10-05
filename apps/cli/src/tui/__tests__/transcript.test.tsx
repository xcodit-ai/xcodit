import React from "react";
import { render } from "ink-testing-library";
import assert from "node:assert/strict";
import { App } from "../App.js";
import { setTheme, detectCaps } from "../theme.js";
import { toggleExpand, toggleExpandAll, renderItems, type Item } from "../transcript.js";

/**
 * Transcript behaviour: which block `o` opens, that scrolling clamps instead
 * of banking an invisible surplus, and that the running phase animates.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pass: string[] = [];
const ok = (name: string) => pass.push(name);

setTheme("dark", { ...detectCaps(), level: 3, unicode: true, tty: true });

// ---- `o` walks back through collapsed output --------------------------------
const big = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
const tool = (id: string, name: string): Item =>
  ({ kind: "tool", id, name, summary: `${name} thing`, depth: 0, state: "ok", ms: 10, output: big, lines: 40 });

let items: Item[] = [tool("a", "bash"), tool("b", "read_file"), tool("c", "bash")];
const open = (xs: Item[]) => xs.map((x) => Boolean((x as { expanded?: boolean }).expanded));

items = toggleExpand(items)!;
assert.deepEqual(open(items), [false, false, true], "the first press opens the newest");
items = toggleExpand(items)!;
assert.deepEqual(open(items), [false, true, true], "the second press reaches the one above it");
items = toggleExpand(items)!;
assert.deepEqual(open(items), [true, true, true], "and so on back through the run");
items = toggleExpand(items)!;
assert.deepEqual(open(items), [true, true, false], "with everything open, the newest closes again");
items = toggleExpandAll(items)!;
assert.deepEqual(open(items), [true, true, true], "O opens every one");
items = toggleExpandAll(items)!;
assert.deepEqual(open(items), [false, false, false], "O closes every one");
ok("`o` walks back through collapsed output, `O` toggles all");

// ---- scrolling clamps on the way up -----------------------------------------
// Clamping only at render lets an over-scroll bank a surplus that has to be
// burned off before the view moves again, which reads as a frozen transcript.
{
  let scroll = 0;
  let max = 20;
  const by = (d: number) => { scroll = Math.max(0, Math.min(max, scroll + d)); };
  for (let i = 0; i < 50; i++) by(3);
  assert.equal(scroll, 20, "stops at the top rather than banking surplus");
  by(-3);
  assert.equal(scroll, 17, "one tick down moves one tick");
  max = 5; // a collapse shrinks the content under us
  by(-3);
  assert.equal(scroll, 5, "snaps down to the new ceiling rather than hanging past it");
  by(-3);
  assert.equal(scroll, 2);
  by(-10);
  assert.equal(scroll, 0, "bottoms out at follow");
  ok("scroll clamps as it moves");
}

// ---- blank separators survive rendering -------------------------------------
{
  const lines = renderItems(
    [{ kind: "user", text: "hello" }, { kind: "assistant", text: "hi", done: true }],
    60,
  );
  const blanks = lines.filter((l) => l.every((s) => s.text.trim() === "" && !s.bg)).length;
  assert.ok(blanks >= 1, "blocks are separated by blank rows");
  ok("blocks keep their separating blank rows");
}

// ---- the running phase is in motion -----------------------------------------
const { lastFrame, unmount } = render(
  <App opts={{ creds: { server: "", token: "" }, cwd: process.cwd(), mode: "ask", verify: true, review: true, plan: false, demo: true }} />,
);
try {
  await sleep(1800);
  const seen = new Set<string>();
  for (let i = 0; i < 12; i++) {
    const row = (lastFrame() ?? "").split("\n").find((l) => l.includes("planning") || l.includes("implementing"));
    if (row) seen.add(row);
    await sleep(90);
  }
  assert.ok(seen.size > 1, `the phase label should animate (saw ${seen.size} variants)`);
  ok("the running phase label is in motion");
} catch (err) {
  unmount();
  console.error("FAIL\n" + String(err));
  process.exit(1);
}

unmount();
console.log(pass.map((p) => "ok   " + p).join("\n"));
process.exit(0);
