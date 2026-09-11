---
"@zhushanwen/pi-pending-notifications": minor
---

Make session entries the single source of truth and delete the dead session-tier machine.

The in-memory pending registry is removed: the `pending_notifications` tool projection and both write-side pre-pend checks (register dedup / unregister active check) now compute against `sessionManager.getEntries()` via the same `countActiveFromEntries` primitive already consumed by goal and subagent-workflow, so "what got persisted" and "what gets queried" can no longer diverge (root-fixes the documented bte reconcile divergence). The unused session-tier machinery — TTL expiry, cross-session flush, shutdown cancellation, and the `PENDING_LIFECYCLE` / `PENDING_TTL_MS` constants — serves 0 of 3 current pending types and is deleted along with `PendingEntry.expiresAt`. Write-side entry shape and tool output semantics are unchanged. Named exports shrink from 14 to 5 (`countActiveFromEntries` plus its signature types `CountActiveOptions` / `CountActiveResult` / `PendingEntry` / `PendingType`); the removed symbols were production-unused outside this package. Breaking for standalone consumers importing the removed symbols — shipped as a minor bump per the repo's 0.x convention (minor = breaking).
