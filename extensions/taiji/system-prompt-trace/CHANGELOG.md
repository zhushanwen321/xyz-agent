# @zhushanwen/pi-system-prompt-trace

## 0.1.6

### Patch Changes

- 4955dad6e: Remove the self-persisted baseline subsystem and fix the missing diff summary on the restart-resume path.

  The `system-prompt-trace-baseline.json` sidecar (atomic write, tmp uniquification, 64-session pruning, ~120 lines) existed to cover restart paths assumed unable to reach the session file; pi's `sessionManager.getSessionFile()` covers all of them. Baseline resolution is now three-tier — switch stash, fork via the event's `previousSessionFile`, then a direct read of the current session JSONL — leaving the JSONL as the single persistence source. Existing baseline files (including `*.tmp_*` residue) become orphans with no reader/writer and are safe to delete manually. As a data-layer fix, `parentVersionDiffSummary` is now populated on the "restart, then prompt changed" path where the old sidecar could never provide it (it stored only hash + version). The package's public entry is unchanged (default export only; the removed `Like*Event` interfaces were never exported), so this ships as a patch: behavioral fix plus internal export-surface shrink (`parseTraceEntryData` / `computePromptHash` un-exported).

## 0.1.5

### Patch Changes

- 730fa1779: Maintenance release: keep the published package in sync with repository source (refactors and fixes shipped in v0.9.14); no public API contract changes.

## 0.1.4

### Patch Changes

- 7b33e6f00: **system-prompt-trace: wire the extension-logger pi handle so error logs actually persist**

  - The extension factory now calls `setPiHandle(pi)` from `@zhushanwen/pi-extension-logger` (already a runtime dependency, no dependency change). Without the injection the logger's appendEntry channel is a no-op, so trace/baseline failures — e.g. persisted-baseline write errors — were completely silent in production; the persisted-logging semantics the code comments claimed did not actually exist. README and type comments also align the cross-restart baseline resolution to the four-path priority (the fork `previousSessionFile` path made explicit alongside stash / persisted file / always-write fallback).

## 0.1.3

### Patch Changes

- 837f2faf6: (no changeset body; patch version bump)

## 0.1.2

### Patch Changes

- d4f466667: Migrate bare console calls to the shared extension logger (pi-extension-logger) so diagnostic logs flow through the unified logging channel with structured fields instead of raw stdout, and drop the redundant generalized log entry emitted on tool errors

## 0.1.1

### Patch Changes

- 63aa77435: Repo reorganization and dependency convergence for the 0.9.5 cycle

  - Extension packages are grouped into `extensions/taiji/` (xyz-agent integrated) and `extensions/universal/` (standalone); install targets and READMEs updated accordingly
  - earendil family dependencies converged to 0.84.1 (peer/dependency ranges updated)
  - llm-shared: export shared `getCurrentModelId` helper for model consumers
  - model-switch: consume the shared helper, internal simplification
