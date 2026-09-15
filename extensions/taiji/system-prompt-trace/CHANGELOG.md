# @zhushanwen/pi-system-prompt-trace

## 0.1.7

### Patch Changes

- 64f17310a: ext-simplify-18 shared adoption batch (ext-simplify-17 registered legacy

  topic cash-in):

  - llm-shared: new parseModelRef export ("provider/modelId" ref parsing,
  renamed from private parseRef, body verbatim) (D4)
  - Five packages gain @zhushanwen/pi-ext-guards dependency
  (session-reader / cache-probe / cw-tool / ask-user /
  system-prompt-trace): standalone pi users' closure grows by one
  zero-dependency pure-function package (dependency groundwork)
  - toErrorMessage adoption: 26 hand-written inline sites across
  permission (7), session-reader (5), cache-probe (5, incl. one
  String()-wrapper variant), structured-output (3), smart-context (2),
  subagent-workflow (2), ask-user (1), cw-tool (1) all switched to the
  ext-guards export (D1)
  - isRecord/isPlainObject adoption: 9 local copies removed (3 strict
  identical + 5 lenient migrated to strict with per-site equivalence
  argued + bte missed-site caught by zero-residue grep). All in-package
  consumers switched to ext-guards isRecord. structured-output keeps a
  deprecated isPlainObject re-export for its deep-path public name;
  system-prompt-trace deletes its exported copy outright (taiji group,
  zero external imports) (D2)
  - isEnoentError adoption: cw-tool spawn-error hints (2 sites) and
  rename-session flag cleanup (1 site, also drops an as-cast) (D3)
  - permission: model-picker provider/model preselection now parses specs
  via llm-shared parseModelRef — intended micro-change: a pathological
  "provider/" (empty modelId) manual config value now falls back to Auto
  instead of half-selecting the provider; all well-formed refs unchanged
  (D4, pinned by MPT8)
  - session-reader: three SessionHeader first-line readers consolidated
  into discovery/session-header.ts (two near-identical async 8KB copies
  merged; sync 4KB id-reader moved verbatim) (D5)
  - Thinking-vocabulary guard: subagent-core THINKING_ORDER joins the
  check-thinking-levels comparison plane (T3, set-equality; order
  semantics stay pinned by subagent-core tests); pre-commit trigger
  surface gains model-ref.ts; C-build-10 registration synced (D6)

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
