# @zhushanwen/pi-system-prompt-trace

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
