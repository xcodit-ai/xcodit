import React from "react";
import { render } from "ink-testing-library";
import assert from "node:assert/strict";
import { App } from "../App.js";
import { setTheme, detectCaps } from "../theme.js";
import { parseWheel, isMouseReport } from "../mouse.js";

/**
 * Input regressions.
 *
 * A mouse wheel inside the alternate screen buffer arrives as a burst of arrow
 * keys, which used to walk the history index out of the array and crash the
 * app. These cover the burst and the wheel handling that replaced it.
 */

const ESC = String.fromCharCode(27);
const UP = ESC + "[A";
const DOWN = ESC + "[B";
// History moved to ctrl+arrows: a bare arrow scrolls, because that is how a
// wheel tick arrives when the terminal keeps the mouse for selection.
const CTRL_UP = ESC + "[1;5A";
const CTRL_DOWN = ESC + "[1;5B";
const WHEEL_UP = ESC + "[<64;40;12M";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pass: string[] = [];
const ok = (name: string) => pass.push(name);

setTheme("dark", { ...detectCaps(), level: 3, unicode: true, tty: true });

// ---- wheel parsing ----------------------------------------------------------
assert.deepEqual(parseWheel(ESC + "[<64;10;5M"), ["up"]);
assert.deepEqual(parseWheel(ESC + "[<65;10;5M"), ["down"]);
assert.deepEqual(parseWheel(ESC + "[<64;1;1M" + ESC + "[<64;1;1M" + ESC + "[<65;1;1M"), ["up", "up", "down"]);
assert.deepEqual(parseWheel(ESC + "[<0;10;5M"), [], "a click is not a wheel tick");
assert.deepEqual(parseWheel("hello"), []);
assert.equal(isMouseReport(WHEEL_UP), true);
assert.equal(isMouseReport("[<64;10;5M"), true, "ink hands us the sequence without its escape");
assert.equal(isMouseReport("hello"), false);
ok("wheel parsing");

// ---- the app under an arrow burst -------------------------------------------
const { lastFrame, stdin, unmount } = render(
  <App opts={{ creds: { server: "", token: "" }, cwd: process.cwd(), mode: "ask", verify: true, review: true, plan: false }} />,
);
const frame = () => lastFrame() ?? "";
const type = async (s: string) => { for (const ch of s) { stdin.write(ch); await sleep(4); } };

try {
  await sleep(700);

  for (let i = 0; i < 40; i++) stdin.write(CTRL_UP);
  await sleep(120);
  for (let i = 0; i < 40; i++) stdin.write(CTRL_DOWN);
  await sleep(120);
  assert.match(frame(), /Describe a change/, "an empty history survives a burst");
  ok("history burst with no history");

  // A bare arrow scrolls instead, and must never crash on an empty transcript.
  for (let i = 0; i < 40; i++) stdin.write(UP);
  await sleep(120);
  for (let i = 0; i < 40; i++) stdin.write(DOWN);
  await sleep(120);
  assert.match(frame(), /Describe a change/, "bare arrows scroll without disturbing the composer");
  ok("bare arrows scroll");

  // Two entries, then far more up-arrows than there are entries.
  await type("first task"); stdin.write("\r"); await sleep(150);
  await sleep(400); // the run fails fast: there is no gateway in this test
  await type("second task"); stdin.write("\r"); await sleep(150);
  await sleep(400);

  for (let i = 0; i < 50; i++) stdin.write(CTRL_UP);
  await sleep(250);
  assert.match(frame(), /› first task/, "stops at the oldest entry");
  ok("history burst past the end of history");

  for (let i = 0; i < 60; i++) stdin.write(CTRL_DOWN);
  await sleep(250);
  assert.match(frame(), /Describe a change/, "walking forward past the newest clears the composer");
  ok("history burst past the start of history");

  stdin.write(WHEEL_UP);
  await sleep(100);
  assert.doesNotMatch(frame(), /64;40;12/, "wheel bytes are never typed");
  ok("wheel bytes are not keystrokes");
} catch (err) {
  unmount();
  console.error("FAIL\n" + String(err));
  console.error("\nlast frame:\n" + frame());
  process.exit(1);
}

unmount();
console.log(pass.map((p) => "ok   " + p).join("\n"));
process.exit(0);
