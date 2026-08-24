# @zhushanwen/pi-file-lock

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
