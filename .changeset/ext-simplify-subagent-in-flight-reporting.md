---
'@zhushanwen/pi-subagent-workflow': minor
---

In-flight subagent reporting channel.

Adds a production-side reporting channel for in-flight subagent activity (design D5): running subagents are reported while they execute instead of only surfacing at completion, and a retention debug IPC plus stale-context guards harden the reporting path.
