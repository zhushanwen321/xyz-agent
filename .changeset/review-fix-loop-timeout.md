---
"@zhushanwen/pi-subagent-workflow": patch
---

Adjust review-fix-loop stage timeouts to accommodate longer retry backoff and long-running write operations:

- reviewer / aggregate: 30min → 1h (read-only review stages; gives retry backoff more room before wall-clock cutoff)
- fix: 30min → unlimited (remove `timeoutMs`; write operations such as large refactors / multi-file edits must not be interrupted by a wall-clock timeout)
