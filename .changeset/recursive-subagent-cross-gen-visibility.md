---
"@zhushanwen/pi-subagent-workflow": minor
---

Recursive subagent cross-process visibility: `/subagents` now shows the full recursive tree (A->B->C...), not just level-1

- Identity fields (rootSessionId/parentRecordId/depth) propagated across process boundaries via 3 new env vars (PI_SUBAGENT_ROOT_SESSION_ID / SELF_RECORD_ID / DEPTH), mirroring the existing PI_SUBAGENT_FORK_DEPTH mechanism
- A 4th env var (PI_SUBAGENT_ROOT_CWD) carries the true ROOT cwd into child processes: with worktree isolation (spawn cwd = checkout path) the session/record persistence dirs are now uniformly encoded under enc(ROOT cwd), so deep (depth >= 2) records remain visible to the ROOT process's disk reconstruction (previously they landed in enc(checkout) and vanished from /subagents)
- createRecordForMode uses the propagated true root session id instead of the per-process session id, so deep recursive records survive the collectRecords rootSessionId filter
- Fork-branch subagents now attach to the top ROOT and are visible from the main session
- Process-level baselines (execCtxBaseline/forkDepthBaseline) as fallback for ALS reads, since RPC mode ALS stores do not propagate across independent async chains
- Behavior change: the nesting guard now counts from the propagated process baseline (previously ALS gaps could reset depth to 0 in child processes), so flows nesting beyond MAX_FORK_DEPTH are now rejected with ForkDepthExceededError instead of silently passing
