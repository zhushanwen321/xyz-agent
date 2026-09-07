---
"@zhushanwen/pi-subagent-workflow": minor
---

Sync batch collection v2: batch-member manifests are written at finalized exit, settled-state rescans are bounded, and batch markers survive orphan overwrites, making collect recoverable across crash windows. Also fixes the published npm package missing session-lifecycle.ts (8.8.1 regression).
