---
'@zhushanwen/pi-subagent-workflow': minor
---

Add `message` and `start` actions to the `/subagents` RPC surface: GUI clients can now send a directed message to a running subagent or start a new one without going through the main agent LLM. Successful dispatches are recorded in the main session as `subagent-directive` custom_message entries (hidden from TUI) so the conversation stays auditable and reload-safe
