# Security

Please report a vulnerability to **security@xcodit.dev**, not in a public
issue. Say what you found, how to reproduce it, and what it affects.

In scope: the CLI and agent engine in this repository, and the xcodit service
they talk to (`api.xcodit.dev`, `xcodit.dev`).

Keep in mind what the agent is: it runs commands and edits files on your
machine with your permissions, and has no sandbox. The permission mode you
pick decides what it may do without asking. The service's permission policy
is enforced by this client, so it guards against mistakes, not against a
modified client. Running `full-auto` on code or instructions you do not trust —
an `AGENTS.md`, a fetched page, a dependency's README — is at your own risk.
