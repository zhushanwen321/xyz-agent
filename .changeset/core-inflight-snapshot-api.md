---
'@zhushanwen/subagent-core': minor
---

In-flight subagent snapshot API + size-rotated engine journal stream.

Adds `setInFlightListener` / `getInFlightSnapshot` / `InFlightSnapshot` / `InFlightListener` exports (index.ts barrel + execution/engine/inflight-snapshot.ts), the engine port surface for in-flight snapshots, and a size-rotated journal stream for engine clients. Consumed by `@zhushanwen/pi-subagent-workflow` in-flight reporting (D5). Purely additive.

NOTE for release (apply-version): bump 时必须同步 `src/index.ts` 的 `CORE_PACKAGE_VERSION = "0.7.1"` 双源字面量到新版本号（`check-subagent-core-closure.mjs` 检查项 0 会拦截漏同步）。
