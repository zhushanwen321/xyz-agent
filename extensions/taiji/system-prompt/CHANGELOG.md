# @zhushanwen/pi-system-prompt

## 1.1.3

### Patch Changes

- 7b33e6f00: **Supplemental changesets for five packages that changed src without a declaration (4N.1 scan finding)**

  - `@xyz-agent/extension-protocol`: add the `background-task` protocol module (task registration/reaping contract types consumed by the runtime background-task reaper sunk from base-tool-enhance), plus 183 lines of contract tests and index re-exports.
  - `@zhushanwen/pi-msg-id-mapper`: comment/test text sync with implementation (stale pi version comment fix, dead test mock dropped).
  - `@zhushanwen/pi-smart-context`: minor text sync in pure.ts.
  - `@zhushanwen/pi-system-prompt`: doc-comment sync clarifying the deliberate divergence from pi 0.84.4's `loadContextFileFromDir` (global-dir-only candidate list, no `AGENTS.override.md`); no behavior change.
  - `@zhushanwen/pi-unified-hooks` (deprecated package): text sync with implementation in the deprecated notice era.

## 1.1.2

### Patch Changes

- 837f2faf6: (no changeset body; patch version bump)

## 1.1.1

### Patch Changes

- d4f466667: Migrate bare console calls to the shared extension logger (pi-extension-logger) so diagnostic logs flow through the unified logging channel with structured fields instead of raw stdout, and drop the redundant generalized log entry emitted on tool errors

## 1.1.0

### Minor Changes

- df69a18fc: KV-cache stable system-prompt construction: deterministic ordering of injected sections plus mtime-based cache invalidation, keeping prompt bytes stable across restarts to maximize prompt-cache hits.

## 1.0.2

### Patch Changes

- 63aa77435: Repo reorganization and dependency convergence for the 0.9.5 cycle

  - Extension packages are grouped into `extensions/taiji/` (xyz-agent integrated) and `extensions/universal/` (standalone); install targets and READMEs updated accordingly
  - earendil family dependencies converged to 0.84.1 (peer/dependency ranges updated)
  - llm-shared: export shared `getCurrentModelId` helper for model consumers
  - model-switch: consume the shared helper, internal simplification

## 1.0.1

### Patch Changes

- 8e52cb3ba: Builtin extension npm migration completion

  - agent-ext: session tree navigation (`/xyz-navigate`) + `/__xyz_reload__` internal reload command, migrated from builtin file to npm package
  - msg-id-mapper: message id mapping extension, migrated from builtin file to npm package; hook internals refactored for complexity (behavior unchanged: rpc-tag strip → pending uuid → leafId flush → custom entry)
  - system-prompt: system prompt injection extension, migrated from builtin file to npm package; config parsing / prompt assembly split into helpers for complexity (injection order and fail-safe semantics unchanged)
  - runtime drops the getBuiltinExtensionPaths chain; extensions load as regular npm packages

  No public API change: package roots keep `index.ts` (pi.extensions manifest entry) and `export { default } from "./src/index.ts"`; no export was removed.
