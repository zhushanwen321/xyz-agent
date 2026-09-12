---
'@zhushanwen/pi-ext-guards': minor
'@zhushanwen/pi-plan': patch
'@zhushanwen/pi-scheduler': patch
'@zhushanwen/pi-structured-output': patch
---

Crash-resilience guard against stale-context async callbacks.

- **pi-ext-guards**: exports the new `guardStaleCtx` helper. It wraps session-scoped async callbacks so that, once the hosting session is no longer active, late resolves are dropped instead of writing into a dead or recycled context.
- **pi-plan / pi-scheduler / pi-structured-output**: adopt `guardStaleCtx` around their session-lifetime async flows (plan compaction, scheduler tick handlers, structured-output loop gating), preventing late callbacks from landing in a session that has already ended.
