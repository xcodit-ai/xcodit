import React from "react";
import { render } from "ink-testing-library";
import assert from "node:assert/strict";
import { App } from "../App.js";
import { setTheme, detectCaps } from "../theme.js";
import { COMMANDS } from "../commands.js";
import { MENU_ROWS } from "../Input.js";

/**
 * The composer and the command palette.
 *
 * The composer used to turn red after any tool call returned an error, even
 * when the run went on to succeed, and the palette was capped at six rows so
 * the commands below them could not be reached.
 */

const ESC = String.fromCharCode(27);
const DOWN = ESC + "[B";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pass: string[] = [];
const ok = (n: string) => pass.push(n);

setTheme("dark", { ...detectCaps(), level: 3, unicode: true, tty: true });

const { lastFrame, stdin, unmount } = render(
  <App opts={{ creds: { server: "", token: "" }, cwd: process.cwd(), mode: "ask", verify: true, review: true, plan: false }} />,
);
const frame = () => lastFrame() ?? "";
const type = async (s: string) => { for (const ch of s) { stdin.write(ch); await sleep(5); } };
// The composer is the bordered row carrying a prompt glyph; the transcript
// can hold its own ✗ lines, which are not what this is asking about.
const composerRow = () =>
  frame().split("\n").filter((l) => /[│|]\s*[›…!✗_>]/.test(l) || l.includes("Describe a change")).pop() ?? "";

try {
  await sleep(700);
  const idle = composerRow();
  assert.match(idle, /›/, "the composer starts with the idle prompt");
  assert.doesNotMatch(idle, /✗/, "and no error mark");
  ok("the composer starts plain");

  // A run that fails outright (no gateway here) must not change the composer.
  await type("do something"); stdin.write("\r");
  await sleep(1200);
  const after = composerRow();
  assert.doesNotMatch(after, /✗/, "a failed run leaves the composer alone");
  assert.match(after, /›/, "the idle prompt comes back");
  ok("the composer keeps its face after a failure");

  // ---- the palette reaches every command ----------------------------------
  await type("/");
  await sleep(120);
  assert.ok(COMMANDS.length > MENU_ROWS, "this test only means something with a long list");

  // Walk to the very last command; the window has to follow the selection.
  for (let i = 0; i < COMMANDS.length + 3; i++) { stdin.write(DOWN); await sleep(12); }
  const last = COMMANDS[COMMANDS.length - 1]!.name;
  assert.ok(frame().includes(last), `the last command (${last}) is reachable`);
  assert.ok(frame().includes(`${COMMANDS.length}/${COMMANDS.length}`), "the counter shows the position in the list");
  ok("the palette scrolls to every command");

  stdin.write("\r");
  await sleep(200);
  assert.ok(frame().includes(last), "selecting the last command fills it in");
  ok("the last command can be chosen");
} catch (err) {
  unmount();
  console.error("FAIL\n" + String(err));
  console.error("\nlast frame:\n" + frame());
  process.exit(1);
}

unmount();
console.log(pass.map((p) => "ok   " + p).join("\n"));
process.exit(0);
