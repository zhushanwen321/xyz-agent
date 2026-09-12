---
'@zhushanwen/pi-smart-context': minor
---

Normalize events to pi SDK types and align token estimation.

- Like-event interfaces and `ToolInfo` are replaced with pi SDK event types across the extension, removing local duplicates.
- The shadowed-token estimate now aligns with pi's `estimateTokens`, so compaction reminders trigger on the same numbers the agent core sees.
- Handler gating during an active compaction is decided by `isGatingActive` instead of ad-hoc flags.
