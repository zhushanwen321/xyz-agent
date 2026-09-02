---
'@zhushanwen/pi-agent-ext': minor
---

**agent-ext: remove the `/xyz-navigate` slash command**

- The `/xyz-navigate <entryId>` command (session tree navigation via `ctx.navigateTree`) is removed. Its only consumer was the runtime-side bridge that intercepted the `navigate-result` custom message and forwarded it to the renderer's session tree view; that bridge was deleted in the monorepo era, and no session tree view exists in the current renderer, so the command had no reachable caller. The remaining `/__xyz_reload__` and `/__xyz_get_system_prompt__` internal commands are unchanged. Original design: docs/adr/0008-extension-bridge-for-navigate-tree.md (now marked superseded).
