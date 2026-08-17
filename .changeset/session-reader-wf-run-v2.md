---
"@zhushanwen/pi-session-reader": patch
---

Accept `wf-run-v2` workflow snapshots written by `@zhushanwen/pi-subagent-workflow` 8.x (one-shot lifecycle):

- **Workflow discovery and overview now read v2 runs.** The sibling extension bumped its run snapshot format from `wf-run-v1` to `wf-run-v2`; until this patch, session-reader's version guards only accepted v1, so `family`/`workflows` discovery silently returned an empty `calls` list for every v2 run (all agent call session file references lost) and the `workflow` overview action returned no result for them. The v2 reading surface is shape-compatible with v1 — `state.calls[].sessionFile` / `result.sessionFile` are unchanged — so only the version literals were widened (`extractCallSessionFiles` NEW branch and `parseRunSnapshot` NEW branch), and `WorkflowOverview.version` now reports `'wf-run-v2'` for v2 snapshots. Legacy no-`v` (`callCache`) snapshots keep the existing best-effort parsing; future formats (e.g. a hypothetical `wf-run-v3`) still parse as null until explicitly evaluated.
