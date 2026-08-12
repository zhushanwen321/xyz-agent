---
'@zhushanwen/pi-session-reader': minor
'@zhushanwen/pi-subagent-workflow': minor
---

Add nested execution tree reading and workflow/session record discovery

- `session-reader`: resolveSessionId now supports three forms (sessionId, taskId/runId, subagent slug), builds nested execution trees via parentRecordId (family mode), discovers workflow runs, enriches SubagentRef records with agent name and manifest/parent fallbacks, and adds find-by-task/slug/agentName matching with source filtering.
- `subagent-workflow`: persist parentRecordId in the subagent manifest so session-reader can reconstruct the nested execution tree.
