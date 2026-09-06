---
'@zhushanwen/subagent-core': patch
---

Consolidate engine transport layers: migrated renderer api middleware and mock layer into core/transport, and converged the zcode engine to a single resident app-server form (launcher rewrite, session-channel turn timers and dispose-harvest, model validation for engine params). Worker message pump extracted from error-recovery with postMessage hardening, plus settled-watchdog and round-settlement improvements for more reliable subagent lifecycle handling.
