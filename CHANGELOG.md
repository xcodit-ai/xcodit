# Changelog

## Unreleased

- **Planning and scouts no longer refuse ordinary searches.** 0.0.1 fixed the
  read-only check for the permission policy, but the read-only shell that the
  planner and scout subagents use kept its own older copy. That copy refused
  `grep -E "a|b"` and let `find … -delete` and `echo $(npm install)` through
  as reads. It now uses the same classifier as the policy.
- **An interrupt no longer breaks the session.** Pressing Ctrl+C while the
  agent was working through several tool calls left the ones that had not run
  without a result, and the next message in that session was rejected. Every
  call now gets an answer — "cancelled" for those that never ran — and a
  session saved by an earlier version is repaired when it is resumed.
- **The CLI sends its version with every request** (`x-xcodit-client`), so the
  server can tell a release it no longer supports to update instead of failing
  part-way through a run.

## 0.0.2 — 2026-10-05

- **The CLI connects to `https://api.xcodit.dev` by default.** 0.0.1 pointed
  at `localhost:3000`, so a fresh install could not log in.
- **The CLI trusts the operating system's certificate store** alongside
  Node's own, the way a browser does — so a local development CA works, and
  so do corporate proxies that re-sign traffic.
- **The Windows install instructions put the right folder on `PATH`.** npm
  puts `xcodit.cmd` in the prefix itself on Windows, not in a `bin` folder.
- `pnpm cli` and `pnpm demo` work again after the package was renamed to
  `xcodit-ai`.

## 0.0.1 — 2026-09-19

### Permissions moved to the server

The client no longer decides what it is allowed to do. Before each tool call it
asks `POST /v1/permission` and obeys the answer.

- **`allow` / `ask` / `deny`.** `deny` is new: it never reaches a prompt, and
  the model is told it was refused by policy — so it explains itself to the user
  instead of hunting for a way around. `ask` carries the server's own wording
  into the prompt, and says whether "always allow this tool" may be offered at
  all.
- **The policy is data.** `permissionPolicies` holds one active version per
  tier: dangerous-command patterns, read-only patterns, the mode matrix, tools
  that never ask, and a `forbidden` list refused in every mode. Edits reach
  every session within 30s with no restart and no release. The shipped defaults
  reproduce the old behaviour exactly, plus `npm publish` and destructive
  `kubectl`/`docker` subcommands in the dangerous set.
- **Only what is needed to judge is sent** — tool, mode, command line, path.
  Never file contents. Verdicts are memoised per session.
- **Offline is not a free pass.** If the server cannot be reached the agent
  applies the same rules locally, but downgrades anything it would have allowed
  to a prompt. An unreachable server can never be more permissive than a
  reachable one.

### Read-only mode stopped refusing ordinary searches

`grep -E "room|three|webgl"` was classified as a state-changing command and
refused in plan mode and in scout subagents. The classifier split a command
line on `|`, `&&` and `;` without minding quotes, so a search pattern was torn
into fragments — `three`, `webgl` — none of which look like a read-only
command. Anything with an operator inside a quoted argument was affected.

- The line is now scanned with quoting in mind: an operator inside quotes is an
  argument, not a separator.
- Command substitutions are pulled out and judged in their own right, so
  `echo $(npm install)` is no longer read-only on the strength of the `echo`.
- Redirects are read properly: `2>&1`, `>&2` and `&> /dev/null` write nothing,
  while `&> out.txt` does.
- Commands that read by default but write when asked — `find … -delete`,
  `find … -exec`, `sed -i`, `sort -o`, `uniq in out` — are no longer read-only.
  They used to pass on the strength of their first word.
- More genuine read-only commands recognised: `sed -n`, `cut`, `tr`, `nl`,
  `jq`, `diff`, `sort`, `uniq`, `basename`, `dirname`, `realpath`, the checksum
  tools, and `git ls-tree|cat-file|shortlog|tag -l|config --get`.

The shipped policy now carries a revision, and a database holding an older one
is upgraded on start — so a rule corrected here reaches deployments rather than
only new installations. A policy installed by hand is left alone.

Refusing a path outside the project now says where the project is. Told only
that it failed, a model tries `..`, then `../..`, then the same thing through
the shell.

### The transcript

- Tool cards no longer paint a panel behind their body. A filled block reads as
  a hole in any terminal whose background is not ours; the cards now sit on the
  terminal's own background and are held together by their rule and gutter.

### The tool surface

The agent now carries the whole set a modern coding agent is expected to have,
written here rather than taken from another agent's package.

- **`patch`** — several edits across several files in one call. Every change is
  validated first, so a rename that touches six files either lands completely or
  writes nothing and tells you which change failed.
- **`list`** — a directory tree, for orienting in an unfamiliar area.
- **`diagnostics`** — what a language server is actually asked for, without
  running one: the project's own typechecker and linter, parsed into
  `file:line: message` for tsc, eslint-style, rustc, go and Python output.
- **`todo_write`** — the model's task list for a multi-step job, rendered in the
  transcript as a live checklist. It accepts the field names other todo tools
  use, so a model trained on one of those does not waste a turn being corrected.
- **`web_fetch`** — a page reduced to readable prose, with headings, lists,
  links and code kept. Private addresses are refused.
- **`web_search`** — runs through the gateway, so no search key ever reaches
  your machine and the cost is metered with everything else.
- **`skill`** — loads a `SKILL.md` the project keeps for a recurring job, from
  `.xcodit/skills`, `.claude/skills` or `.agent/skills`.
- **`ask_user`** — one question, mid-run, when a choice would change the result.
  The composer becomes the answer box; numbered options can be picked with a
  keypress.

### Changed

- **The mouse belongs to the terminal by default.** A terminal hands the mouse
  to the application or keeps it for itself, never both, so capturing it for
  scrolling is what had broken plain drag-selection. xcodit no longer captures
  it: **drag selects text, with no modifier**. Wheel ticks arrive as arrow keys
  in that mode, so `↑`/`↓` scroll the transcript whenever the composer is empty
  and input history moved to `Ctrl+↑`/`Ctrl+↓` (and `Ctrl+R` search).
- **`/mouse on` trades selection for clicking.** It takes the mouse, which lets
  you **click a block to open or close it** and gives the wheel proper events;
  selecting text then needs the terminal's own shift bypass. `/mouse off`
  returns to plain selection.

### Fixed

- **The composer keeps its face.** It turned red with a `✗` whenever any tool
  call returned an error — a grep that matched nothing, a command that exited
  non-zero mid-exploration — even though the run went on to succeed. A tool
  result is the transcript's business; the input field now looks the same
  whatever happened, and only waiting on you changes it. A run that actually
  fails still shows in the transcript and on the wordmark's dot.
- **The command palette reaches every command.** It was capped at six matches,
  so arrowing down stopped partway through the list. It now scrolls a window
  around the selection and shows the position in the list.

- **Scrolling could look frozen.** Scroll position was clamped only when
  drawing, so over-scrolling banked an invisible surplus that had to be burned
  off before the view moved again — most obvious right after expanding a long
  output. It now clamps as it moves, and snaps down when a collapse shrinks the
  content.
- **`o` reaches the output you meant.** It opened the newest block and then
  closed it again. Each press now walks back to the next collapsed block above
  the last, and `O` opens or closes every one at once.
- **Text selection works with the mouse.** Capturing the wheel takes the mouse
  away from the terminal, so drag-select stopped working. Hold **shift** to
  select while capture is on — the hotkey strip says so — or run `/mouse off`
  to hand the mouse back entirely on terminals where shift does not bypass.
- **The running phase animates.** A light sweeps the active label, the same
  idea as the wordmark's heartbeat, so a live state reads as live.

- **Prompts, state changes and replies now read as distinct blocks.** They
  shared a margin and ran together with no space between them. What you typed
  sits on a filled band, a phase change is a rule across the column, replies
  stay bare prose with air above and below, and tool cards carry the panel
  fill. The marker gutter widened to three columns because several markers are
  East Asian Ambiguous and fonts that draw them two cells wide were eating
  their own padding. Blank separators were also being dropped in the
  full-screen UI: an empty Ink `<Text>` collapses to zero height, so blanks now
  render as a spacer row.

- **The mouse wheel now scrolls the transcript.** Inside the alternate screen
  buffer a terminal has no scrollback to offer, so most of them translate wheel
  ticks into arrow-key bursts — the wheel walked through input history instead
  of scrolling, and a long burst could walk the history index past the end of
  the array and crash the session. xcodit now turns on SGR mouse reporting and
  handles wheel events itself; history navigation clamps to the array; and
  mouse reports can never be typed into the composer. Covered by
  `pnpm --filter @xcodit/cli test`.

### Redesign against the "signal-dark" reference

The terminal UI was rebuilt to the design mockups (boot, cockpit, permission
prompt, visual system, logo motion):

- **signal-dark palette** — `#0b0e14` ground, `#0f131b` panels, `#1c2230`
  borders, a four-tier text ramp (bright / text / muted / faint) and a single
  accent `#ff5a1f`. Diff rows carry real tints.
- **The dot is the heartbeat** — the wordmark never animates; its dot does.
  Six states: idle breathe, thinking blink, tool-call spinner, amber ring when
  a permission waits, red on failure, green when a run lands.
- **Top bar** — wordmark, active specialist, cwd, branch, calls, elapsed, cost.
- **Right rail** — context gauge, tool states, files touched this run, session
  totals. Toggles with Tab and hides below 100 columns.
- **Tool cards** — each call is a panel: tool, argument, result, and a
  collapsed/expanded marker. Output opens on failure or on demand.
- **Step checklist** — plan steps live under the agent's own words as
  ✓ / ● / ○, not in a separate progress panel.
- **Permission panel** — amber (red when dangerous), the change as a tinted
  diff, and the key row `y once · a always this session · n skip`.
- **Command palette** — a panel that echoes the query with the selected row
  filled.
- **Prompt states** — `›` idle, `…` working, `!` waiting on you, `✗` after a
  failed step.

### The terminal UI

The CLI was rebuilt as a designed surface rather than a scrolling log.

- **Identity** — a four-line startup lockup: mark, wordmark, version, model
  family, a tagline that rotates per launch, and a status line with the
  working directory, git branch (with a dirty marker), tool count and
  connection state. `xcodit --version` prints just the version.
- **One visual system** — colors, glyphs and message markers live in a single
  theme module with dark and light palettes. Terminal capability is detected
  (truecolor / 256 / 16 / none, Unicode vs ASCII) and the palette degrades to
  named ANSI colors rather than a nearest-match guess. `--theme dark|light`,
  `/theme`, and a saved preference in `~/.xcodit/config.json`.
- **A gutter** — every message carries a two-column marker: user, agent, tool,
  ok, error, info, warning, plan, subagent. Tool output and failed checks sit
  in rounded frames; prose stays plain, and frames are never nested.
- **Motion** — streaming text ends in a blinking block cursor; a single status
  row names the running tool with elapsed time and updates in place; plans get
  a progress bar with one collapsed line per step.
- **Status bar** — a persistent bottom bar with the active specialist, call
  count, context usage against the budget, session cost, permission mode and
  hotkeys. Segments drop by priority as the terminal narrows. Hidden when
  stdout is not a terminal.
- **Input** — a multi-line composer whose prompt symbol shows state (`›` idle,
  `…` working, `!` waiting on you), fuzzy slash-command autocomplete with a
  menu, and Ctrl-R fuzzy history search with matched letters highlighted.
- **Output quality** — markdown with headings, lists, quotes, links, tables
  that reflow to the terminal, and fenced code with line numbers and syntax
  highlighting. Edits and writes show a real diff with line numbers:
  side-by-side at 120 columns or wider, unified below. Long tool output
  collapses with `… N more lines · press o`.
- **Polish** — honors `NO_COLOR`, `TERM=dumb` and piped output (no ANSI, no
  alternate screen); resizes cleanly; `--demo` replays a scripted session
  through the real event pipeline, no network or files involved.

`--plain` keeps the line-based REPL, which now shares the same palette,
glyphs and banner. Nothing about agent behavior or tool execution changed;
the engine gained optional `before`/`after`/`path` fields on permission
requests so the UI can draw a diff instead of parsing a string.
