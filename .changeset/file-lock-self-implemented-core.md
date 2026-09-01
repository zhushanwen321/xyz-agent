---
'@zhushanwen/pi-file-lock': minor
---

**file-lock: self-implemented mkdir lock core, proper-lockfile dependency removed**

- The locking internals are replaced with a zero-dependency self-implementation of the same on-disk mkdir protocol (field-by-field compatible with proper-lockfile@4.1.2: `<target>.lock` directory acquire/release, stat-mtime stale takeover with the 2s floor clamp, ENOENT re-entry, graceful-exit cleanup via `process.on('exit')`, ELOCKED error shape). External API signatures and default constants are unchanged.
- Why: under pi's jiti loader, proper-lockfile's mtime-precision probe violates ES Proxy invariants on the second async lock acquisition within one module graph, killing the pi process with an unrecoverable TypeError — the root cause of the 2026-09-01 cold-start first-click crash. The self-implementation only performs plain fs calls and is immune to module-system wrappers; the probe is gone along with the keep-alive timer it served (no compromise detection, documented boundary).
- New `./core` sub-export: the dependency-free lock primitive (acquireLock/acquireLockSync), so hosts running outside pi (xyz-agent runtime) consume the same source of truth via `@zhushanwen/pi-file-lock/core`.
- `proper-lockfile` is dropped from dependencies. Cross-implementation mutual exclusion (self-impl x proper-lockfile@4.1.2) is verified by a concurrency probe (2 workers x 100 loops, zero interleaving).
