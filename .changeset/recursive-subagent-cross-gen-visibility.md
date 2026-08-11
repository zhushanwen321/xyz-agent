---
"@zhushanwen/pi-subagent-workflow": minor
---

Recursive subagent cross-process visibility: `/subagents` now shows the full recursive tree (A->B->C...), not just level-1

- Identity fields (rootSessionId/parentRecordId/depth) propagated across process boundaries via 3 new env vars (PI_SUBAGENT_ROOT_SESSION_ID / SELF_RECORD_ID / DEPTH), mirroring the existing PI_SUBAGENT_FORK_DEPTH mechanism
- createRecordForMode uses the propagated true root session id instead of the per-process session id, so deep recursive records survive the collectRecords rootSessionId filter
- Fork-branch subagents now attach to the top ROOT and are visible from the main session
- Process-level baselines (execCtxBaseline/forkDepthBaseline) as fallback for ALS reads, since RPC mode ALS stores do not propagate across independent async chains
