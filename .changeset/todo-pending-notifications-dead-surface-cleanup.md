---
'@zhushanwen/pi-todo': patch
'@zhushanwen/pi-pending-notifications': patch
---

**todo / pending-notifications: dead-surface and type cleanup from the drift-cleanup sweep**

- `pi-todo`: the dead `getDisplayStatus` export is removed (`model.ts`) — it was an internal-equivalent wrapper over `migrateTodo(t).status` whose only in-repo caller inlined it directly, and the `todo_list` tool description now says "View all todos for the current session" (matches actual per-session behavior, not per-branch). Tool-detector types narrow `unknown` fields to `string | undefined`.
- `pi-pending-notifications`: the pending tool-result shape declares `result`/`error`/`patchFile` as `string | undefined` instead of `unknown` — matching the `typeof === "string"` guards already applied at every extraction site; no runtime behavior change.
