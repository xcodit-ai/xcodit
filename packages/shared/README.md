# @xcodit/shared

The contract between the [xcodit](https://github.com/xcodit/xcodit) CLI and
the xcodit service:

- **Protocol** — zod schemas for chat requests, device login, account and
  policy responses, and the `x-xcodit-client` version header.
- **Roles** — the five specialists and their public Relay names.
- **Permissions** — the default permission policy, the shell-command
  classifier (`read` / `mutate` / `dangerous`), and the evaluator that turns a
  tool call into `allow`, `ask` or `deny`.

```ts
import { classifyCommand, evaluatePermission } from "@xcodit/shared";

classifyCommand(`grep -E "a|b" src`); // "read"
evaluatePermission({ tool: "bash", mode: "auto-edit", command: "npm test" }).decision; // "ask"
```

Apache-2.0.
