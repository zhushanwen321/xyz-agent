---
'@zhushanwen/pi-system-prompt-trace': patch
---

**system-prompt-trace: wire the extension-logger pi handle so error logs actually persist**

- The extension factory now calls `setPiHandle(pi)` from `@zhushanwen/pi-extension-logger` (already a runtime dependency, no dependency change). Without the injection the logger's appendEntry channel is a no-op, so trace/baseline failures — e.g. persisted-baseline write errors — were completely silent in production; the persisted-logging semantics the code comments claimed did not actually exist. README and type comments also align the cross-restart baseline resolution to the four-path priority (the fork `previousSessionFile` path made explicit alongside stash / persisted file / always-write fallback).
