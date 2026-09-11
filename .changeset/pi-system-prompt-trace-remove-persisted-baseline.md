---
"@zhushanwen/pi-system-prompt-trace": patch
---

Remove the self-persisted baseline subsystem and fix the missing diff summary on the restart-resume path.

The `system-prompt-trace-baseline.json` sidecar (atomic write, tmp uniquification, 64-session pruning, ~120 lines) existed to cover restart paths assumed unable to reach the session file; pi's `sessionManager.getSessionFile()` covers all of them. Baseline resolution is now three-tier — switch stash, fork via the event's `previousSessionFile`, then a direct read of the current session JSONL — leaving the JSONL as the single persistence source. Existing baseline files (including `*.tmp_*` residue) become orphans with no reader/writer and are safe to delete manually. As a data-layer fix, `parentVersionDiffSummary` is now populated on the "restart, then prompt changed" path where the old sidecar could never provide it (it stored only hash + version). The package's public entry is unchanged (default export only; the removed `Like*Event` interfaces were never exported), so this ships as a patch: behavioral fix plus internal export-surface shrink (`parseTraceEntryData` / `computePromptHash` un-exported).
