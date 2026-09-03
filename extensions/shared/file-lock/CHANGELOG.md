# @zhushanwen/pi-file-lock

## 0.2.0

### Minor Changes

- 7b33e6f00: **file-lock: self-implemented mkdir lock core, proper-lockfile dependency removed**

  - The locking internals are replaced with a zero-dependency self-implementation of the same on-disk mkdir protocol (field-by-field compatible with proper-lockfile@4.1.2: `<target>.lock` directory acquire/release, stat-mtime stale takeover with the 2s floor clamp, ENOENT re-entry, graceful-exit cleanup via `process.on('exit')`, ELOCKED error shape). External API signatures and default constants are unchanged.
  - Why: under pi's jiti loader, proper-lockfile's mtime-precision probe violates ES Proxy invariants on the second async lock acquisition within one module graph, killing the pi process with an unrecoverable TypeError — the root cause of the 2026-09-01 cold-start first-click crash. The self-implementation only performs plain fs calls and is immune to module-system wrappers; the probe is gone along with the keep-alive timer it served (no compromise detection, documented boundary).
  - New `./core` sub-export: the dependency-free lock primitive (acquireLock/acquireLockSync), so hosts running outside pi (xyz-agent runtime) consume the same source of truth via `@zhushanwen/pi-file-lock/core`.
  - `proper-lockfile` is dropped from dependencies. Cross-implementation mutual exclusion (self-impl x proper-lockfile@4.1.2) is verified by a concurrency probe (2 workers x 100 loops, zero interleaving).

- 7b33e6f00: **shared libs: remove dead package-root barrels and llm-shared dead API surface**

  - The package-root `index.ts` in `@zhushanwen/pi-extension-logger`, `@zhushanwen/pi-file-lock`, and `@zhushanwen/pi-llm-shared` is deleted. Each package's `main` points at `src/index.ts` and none of the root barrels was ever resolved (zero deep imports across the repo), so resolution behavior is unchanged. The `index.ts` entry is dropped from `files` (publish surface shrink) and from the two tsconfigs' `include` that listed it.
  - `@zhushanwen/pi-llm-shared`: the `recoverable` field is removed from the `CallLLMResult` failure variant. All three construction sites in `src/call.ts` hardcoded `true`, the sole production constructor outside the library (`permission` classifier) never read it, and no consumer branched on it — the field was pure noise on every `ok:false` result. The `CallLLMResult`-typed test fixtures are updated accordingly.
  - `@zhushanwen/pi-llm-shared`: `extractText` is no longer re-exported from `src/index.ts` (zero external consumers; same-named helpers elsewhere in the repo are deliberate local implementations). The function itself stays in `src/call.ts` for internal use, so deep imports of `../call.ts` are unaffected.

## 0.1.2

### Patch Changes

- d4f466667: Migrate bare console calls to the shared extension logger (pi-extension-logger) so diagnostic logs flow through the unified logging channel with structured fields instead of raw stdout, and drop the redundant generalized log entry emitted on tool errors

## 0.1.1

### Patch Changes

- 8e52cb3ba: Cross-process write governance and cache correctness (integrity hardening)

  - file-lock: shared cross-process lock module (withFileLockSync) used by runtime and extensions; field-scope merge on concurrent config writes
  - llm-shared: config saves under file lock; unique tmp file names (pid + random suffix) eliminate concurrent same-name tmp collisions between processes
  - quota-providers: disk cache prunes removed/disabled provider entries on providers.json mtime change instead of waiting for TTL expiry; value domains aligned to pi 0.84.1 via SSOT derivation
  - session-reader: main session file resolved by sessionId (not getSessionFile), passed by value into initSession; entry-only orphan recovery after spawn-window deaths
