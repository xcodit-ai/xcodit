import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashReadOnlyTool, listTool, patchTool, skillTool, discoverSkills, htmlToText, parseDiagnostics } from "../tools/index.js";
import { makeTodoTool } from "../tools/todo.js";
import { makeAskTool } from "../tools/ask.js";
import type { TodoItem, ToolContext } from "../types.js";

const pass: string[] = [];
const ok = (n: string) => pass.push(n);

const root = await mkdtemp(join(tmpdir(), "xcodit-tools-"));
const ctx: ToolContext = { cwd: root, mode: "full-auto", askPermission: async () => true, snapshotFile: async () => {} };

await mkdir(join(root, "src/deep"), { recursive: true });
await writeFile(join(root, "src/a.ts"), "export const a = 1;\nexport const b = 2;\n");
await writeFile(join(root, "src/deep/b.ts"), "export const c = 3;\n");
await mkdir(join(root, "node_modules/junk"), { recursive: true });
await writeFile(join(root, "node_modules/junk/x.js"), "nope");

try {
  // ---- list ---------------------------------------------------------------
  const listed = await listTool.execute({ depth: 2 }, ctx);
  assert.match(listed.content, /src\//);
  assert.match(listed.content, /a\.ts/);
  assert.match(listed.content, /deep\//);
  assert.doesNotMatch(listed.content, /node_modules/, "build output stays out of the way");
  ok("list shows the tree and skips build output");

  // ---- patch: all or nothing ---------------------------------------------
  const bad = await patchTool.execute({
    changes: [
      { path: "src/a.ts", old_string: "const a = 1", new_string: "const a = 10" },
      { path: "src/a.ts", old_string: "not present", new_string: "x" },
    ],
  }, ctx);
  assert.equal(bad.isError, true);
  assert.match(bad.content, /Nothing was written/);
  assert.match(await readFile(join(root, "src/a.ts"), "utf8"), /const a = 1;/, "the good change was not applied either");
  ok("patch writes nothing when any change fails");

  const good = await patchTool.execute({
    changes: [
      { path: "src/a.ts", old_string: "const a = 1", new_string: "const a = 10" },
      { path: "src/deep/b.ts", old_string: "const c = 3", new_string: "const c = 30" },
      { path: "src/new.ts", old_string: "", new_string: "export const made = true;\n" },
    ],
  }, ctx);
  assert.equal(good.isError, undefined);
  assert.match(await readFile(join(root, "src/a.ts"), "utf8"), /const a = 10;/);
  assert.match(await readFile(join(root, "src/deep/b.ts"), "utf8"), /const c = 30;/);
  assert.match(await readFile(join(root, "src/new.ts"), "utf8"), /made = true/);
  ok("patch applies across several files at once and can create one");

  // two edits to the same file in one call both land
  const twice = await patchTool.execute({
    changes: [
      { path: "src/a.ts", old_string: "const a = 10", new_string: "const a = 11" },
      { path: "src/a.ts", old_string: "const b = 2", new_string: "const b = 22" },
    ],
  }, ctx);
  assert.equal(twice.isError, undefined);
  const both = await readFile(join(root, "src/a.ts"), "utf8");
  assert.ok(both.includes("a = 11") && both.includes("b = 22"), "both edits to one file survive");
  ok("patch stacks several edits on one file");

  // ---- todo ---------------------------------------------------------------
  let seen: TodoItem[] = [];
  const todo = makeTodoTool((t) => { seen = t; });
  const wrote = await todo.execute({
    todos: [
      { text: "read the module", status: "done" },
      { text: "write the types", status: "active" },
      { text: "run the tests", status: "pending" },
    ],
  }, ctx);
  assert.equal(seen.length, 3);
  assert.equal(seen[1]!.status, "active");
  assert.match(wrote.content, /\[x\] read the module/);
  assert.match(wrote.content, /\[>\] write the types/);
  assert.equal(todo.summary({ todos: seen } as never), "todo 1/3");
  ok("todo_write replaces the list and reports progress");

  // Models trained on other todo tools send other field names; take them all.
  const alt = todo.parse({
    todos: [
      { content: "written as content", status: "completed", id: 1, priority: "high" },
      { task: "written as task", status: "in_progress" },
      { title: "written as title" },
    ],
  });
  assert.deepEqual(alt.todos.map((t) => t.status), ["done", "active", "pending"]);
  assert.equal(alt.todos[0]!.text, "written as content");
  assert.throws(() => todo.parse({ todos: [{ status: "done" }] }), /text/, "an item with no text at all is still refused");
  ok("todo_write accepts the field names other tools use");

  // ---- ask ----------------------------------------------------------------
  const ask = makeAskTool(async (q, o) => (o ? o[1]! : `answered: ${q}`));
  assert.match((await ask.execute({ question: "which one?", options: ["a", "b"] }, ctx)).content, /answered: b|The user answered: b/);
  const silent = makeAskTool(async () => "");
  assert.match((await silent.execute({ question: "anything?" }, ctx)).content, /did not answer/);
  ok("ask_user carries the answer back, and copes with silence");

  // ---- skills -------------------------------------------------------------
  await mkdir(join(root, ".xcodit/skills/release"), { recursive: true });
  await writeFile(join(root, ".xcodit/skills/release/SKILL.md"),
    "---\nname: release\ndescription: how we cut a release\n---\n\nBump the version, then tag.\n");
  const skills = await discoverSkills(root);
  assert.equal(skills.length, 1);
  assert.equal(skills[0]!.name, "release");
  assert.match((await skillTool.execute({}, ctx)).content, /release — how we cut a release/);
  assert.match((await skillTool.execute({ name: "release" }, ctx)).content, /Bump the version/);
  assert.equal((await skillTool.execute({ name: "nope" }, ctx)).isError, true);
  ok("skills are discovered, listed and loaded");

  // ---- html to text -------------------------------------------------------
  const text = htmlToText(`
    <html><head><style>p{color:red}</style><script>evil()</script></head>
    <body><nav>skip me</nav><main><h1>Title</h1><p>Hello &amp; welcome.</p>
    <ul><li>one</li><li>two</li></ul>
    <a href="https://example.com/docs">the docs</a><code>npm i</code></main></body></html>`);
  assert.match(text, /# Title/);
  assert.match(text, /Hello & welcome/);
  assert.match(text, /- one/);
  assert.match(text, /the docs \(https:\/\/example\.com\/docs\)/);
  assert.match(text, /`npm i`/);
  assert.doesNotMatch(text, /evil|color:red/, "scripts and styles are dropped");
  ok("web_fetch reduces a page to readable prose");

  // ---- diagnostics parsing ------------------------------------------------
  const diags = parseDiagnostics([
    "src/stack.ts(9,3): error TS2339: Property 'length' does not exist on type 'Stack'.",
    "src/app.js:12:5: warning: 'x' is assigned but never used",
    "main.go:7:2: undefined: fmt",
    "noise that is not a diagnostic",
  ].join("\n"));
  assert.equal(diags.length, 3);
  assert.deepEqual(
    { file: diags[0]!.file, line: diags[0]!.line, code: diags[0]!.code, severity: diags[0]!.severity },
    { file: "src/stack.ts", line: 9, code: "TS2339", severity: "error" },
  );
  assert.equal(diags[1]!.severity, "warning");
  assert.equal(diags[2]!.file, "main.go");
  ok("diagnostics parses tsc, eslint-style and go output");

  // ---- read-only shell (planner, scouts) -----------------------------------
  // It must agree with the permission policy: a quoted pipe is a search, and a
  // write hidden in a flag or a substitution is still a write.
  const searched = await bashReadOnlyTool.execute({ command: `echo "room|three|webgl"` }, ctx);
  assert.equal(searched.isError, false);
  assert.match(searched.content, /room\|three\|webgl/);
  const deleting = await bashReadOnlyTool.execute({ command: `find . -name no-such-file -delete` }, ctx);
  assert.match(deleting.content, /^Rejected/);
  const smuggled = await bashReadOnlyTool.execute({ command: `echo $(touch smuggled.txt)` }, ctx);
  assert.match(smuggled.content, /^Rejected/);
  assert.equal(await readFile(join(root, "smuggled.txt"), "utf8").catch(() => null), null, "the substitution never ran");
  ok("the read-only shell judges commands the way the policy does");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(pass.map((p) => "ok   " + p).join("\n"));
