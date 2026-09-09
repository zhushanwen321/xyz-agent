---
"@zhushanwen/pi-pending-notifications": minor
---

Align with engine protocol v1.x: background-task (subagent/workflow) pending registrations are pinned to the process tier, and read-side consumers filter by sessionId so cross-session views no longer silently drop long-running registrations.
