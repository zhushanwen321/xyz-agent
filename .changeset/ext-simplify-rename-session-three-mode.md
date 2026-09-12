---
'@zhushanwen/pi-rename-session': minor
---

Three-mode auto-rename trigger layer with subagent protection.

- Auto-rename triggering now runs through an explicit three-mode layer, making when a session gets renamed predictable per configuration.
- Tool execution initiated by subagents is guarded so a subagent turn no longer triggers session renaming on the parent session.
