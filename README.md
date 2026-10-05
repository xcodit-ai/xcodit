# xcodit

A coding agent for your terminal. It reads your repository, plans, makes the
change, runs your project's checks, and has the diff reviewed by a second
model before you see it — on your machine, in your working tree.

```sh
xcodit --demo        # a scripted session: no account, no network, no files touched
xcodit login         # connect this machine to your xcodit account
xcodit               # start working in the current directory
```

This repository holds the CLI and the agent engine. The models are served by
the xcodit service; the CLI never holds a model provider key.

## Install

Requires Node 22 or newer.

```sh
# Linux and macOS (no sudo)
curl -fsSL https://xcodit.dev/install.sh | bash

# or by hand
npm i -g xcodit-ai --prefix ~/.xcodit
export PATH="$HOME/.xcodit/bin:$PATH"
```

```powershell
# Windows (PowerShell)
npm i -g xcodit-ai --prefix "$env:USERPROFILE/.xcodit"
$env:Path = "$env:USERPROFILE/.xcodit;$env:Path"
```

A plain `npm i -g xcodit-ai` works where your npm prefix is writable (nvm,
fnm, Homebrew). On Ubuntu's system Node it is not; never use sudo.

## How a message is handled

xcodit is a relay of specialists — the **Relay** model family:

| specialist    | does                                                                 |
|---------------|----------------------------------------------------------------------|
| `relay-plan`  | with `--plan` or `/plan`: explores read-only, writes a plan you approve |
| `relay-build` | makes the change with tools; may hand subtasks to subagents          |
| verify        | runs your project's checks; failures go back to `relay-build` (up to 2 rounds) |
| `relay-judge` | reads the diff cold and returns a verdict; blocking issues get one fix round |
| `relay-scout` | cheap, read-only exploration for subagents                          |
| `relay-fold`  | condenses long sessions so nothing important is lost                 |

The judge is never the model that wrote the change.

## Commands

```
xcodit                          interactive session in the current directory
xcodit run TASK                 one task, then exit (exit code reflects the outcome)
xcodit resume ID                continue an earlier session
xcodit sessions                 list saved sessions
xcodit login [--server URL]     connect this machine to your account
xcodit logout                   forget stored credentials
xcodit whoami                   account, plan and usage this month
xcodit policy                   the specialists on your plan
xcodit ask [--role ROLE] TEXT   one question, no tools

--mode ask|auto-edit|full-auto  what may run without asking (default ask)
--plan                          plan first, implement after you approve
--no-verify / --no-review       skip the checks / the review
--cwd DIR                       project directory
--plain                         line-mode REPL instead of the full-screen UI
--theme dark|light              color theme
```

Inside a session, `/` opens the command palette: `/plan`, `/mode`, `/verify`,
`/review`, `/undo`, `/cost`, `/new`, `/theme`, `/mouse`.

## Permission modes

| mode        | runs without asking                                                  |
|-------------|----------------------------------------------------------------------|
| `ask`       | reads only (read_file, grep, glob, read-only shell)                  |
| `auto-edit` | + file edits; shell commands that change state ask                   |
| `full-auto` | everything except dangerous commands (rm -rf, force push, reset --hard, ...) |

Before a tool runs, the agent sends the tool name, the mode and the command
line or path (never file contents) to the service, which answers `allow`,
`ask` or `deny`. Rules can then be corrected without a release, and a plan can
forbid an action outright. If the service cannot be reached, the same rules
run locally and anything they would allow becomes a prompt instead.

This protects you, not the service: the check runs in this client, on your
machine, and a modified client can skip it. xcodit has no sandbox — it works
directly in your files with your permissions, so pick the mode accordingly.

`/undo` reverts the files changed by the last message. Shell side effects are
not reverted.

## Your project

- **Instructions** — `AGENTS.md` at the project root (or
  `.xcodit/instructions.md`) is read into every session.
- **Checks** — found automatically: `typecheck`, `lint` and `test` scripts in
  `package.json`, `tsc --noEmit`, `cargo check`, `go vet`, `pytest`. Override
  them in `.xcodit/config.json`:
  ```json
  { "verify": ["pnpm typecheck", "pnpm test"], "review": true, "verify_timeout": 300 }
  ```
- **Skills** — `.xcodit/skills/NAME/SKILL.md` for jobs you repeat; the agent
  loads one when the task calls for it.
- **Sessions** — `~/.xcodit/sessions/ID.jsonl`, resumable with `xcodit resume`.

## Tools

| | |
|---|---|
| `read_file` `edit_file` `write_file` | one file at a time |
| `patch` | several edits across several files, validated before any is written |
| `bash` | Git Bash on Windows when present, PowerShell otherwise |
| `grep` `glob` `list` | search by content, by pattern, or look around |
| `diagnostics` | the project's own typechecker and linter, as `file:line` problems |
| `todo_write` | the task list for a multi-step job, shown as a live checklist |
| `web_fetch` `web_search` | read a page, or search through the service |
| `skill` | load a `SKILL.md` |
| `ask_user` | one question when a choice would change the outcome |
| `delegate` | hand a subtask to a subagent and get back only its answer |

File tools are confined to the project directory.

## Terminal

Drag to select text. Scroll with the wheel, `↑`/`↓` on an empty composer, or
`PgUp`/`PgDn`. `o` opens the next collapsed output and `O` all of them;
`Ctrl+↑`/`Ctrl+↓` walk input history and `Ctrl+R` searches it; `Tab` toggles
the side rail; `Ctrl+C` interrupts a run.

| variable        | effect |
|-----------------|--------|
| `XCODIT_SERVER` | the service to log in to (default `https://api.xcodit.dev`) |
| `XCODIT_SHELL`  | shell for the `bash` tool |
| `NO_COLOR`      | no color |
| `FORCE_COLOR`   | force a color level (0–3) |
| `XCODIT_ASCII=1`| ASCII glyphs only |

## This repository

```
apps/cli         the xcodit CLI                        npm: xcodit-ai
packages/agent   the engine: loop, tools, permissions, verify, review, undo
packages/shared  the wire protocol, roles and permission rules   npm: @xcodit/shared
```

```sh
pnpm install
pnpm demo                 # the scripted session
pnpm cli                  # run the CLI from source (XCODIT_SERVER to point it elsewhere)
pnpm typecheck && pnpm test
pnpm build
```

Releases are published from CI: push a tag `cli-vX.Y.Z` or `shared-vX.Y.Z`
matching the package's version. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE)
