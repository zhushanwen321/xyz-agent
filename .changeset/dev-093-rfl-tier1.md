---
"@zhushanwen/pi-subagent-workflow": minor
---

Review-fix-loop tier-1 efficiency optimization

- M0 observability foundation: per-round metrics files, execution traces, stage timings
- M1 aggregation data chain: cross-batch score collection, dedup keys, aggregated report generation with authority guards (absent vs empty must_fix_ids)
- M2 scoring/eval: exec-review scoring rubric, dormant-partition directed tests, prompt contract enforcement
- MP prompt prefix stabilization (tier-1 T9): deterministic prompt prefixes across rounds
- Worktree registry lock + physical reconciliation (W4), orphan terminal fallback + execution-state projection (U2-U4), kill-9 recovery terminal state (U1)
- Round-finalized subagents never show working; markDead/revive via applySnapshot
- Sidebar status sync: subagent/workflow lists re-pull on reconnect, empty RPC result guards
- Lint backlog cleared (25 warnings)
