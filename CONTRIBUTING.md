# Contributing

## Setup

Node 24 (22 works) and pnpm 9.

```sh
pnpm install
pnpm demo                    # the scripted session, no account needed
pnpm cli                     # the CLI from source, against https://api.xcodit.dev
XCODIT_SERVER=https://... pnpm cli login   # or another server
```

## Before a pull request

```sh
pnpm typecheck
pnpm test
```

Tests are plain `tsx` scripts using `node:assert`; each prints one `ok` line
per case. Add a case for any bug you fix, and check that it fails without the
fix.

## Conventions

- **Terminal UI.** Colors and glyphs come from `apps/cli/src/tui/theme.ts`
  only, which also degrades them for 16-color and ASCII terminals. Frames are
  never nested, and every message keeps its gutter marker.
- **Dependencies.** The CLI bundles to a single file with three runtime
  dependencies (ink, react, zod). Prefer a short helper in the repo to a new
  package — the diff, markdown, highlighting and fuzzy matching are all here
  for that reason.
- **Protocol.** `packages/shared` is the contract with the service, and the
  service has to keep working with every CLI release still in use. Add fields
  as optional; do not rename or remove them.
- **Permissions.** Changes to `packages/shared/src/permissions.ts` need a case
  in `packages/agent/src/__tests__/permissions.test.ts`: a wrong verdict either
  nags on every read or runs something destructive unattended.

## Releasing

Bump the version in the package's `package.json`, add the changes to
`CHANGELOG.md`, and push a tag:

```sh
git tag cli-v0.0.3      # publishes apps/cli as xcodit-ai
git tag shared-v0.1.1   # publishes packages/shared as @xcodit/shared
git push --tags
```

The release workflow checks that the tag matches `package.json`, runs the
checks, and publishes to npm with provenance — no token is stored anywhere.
