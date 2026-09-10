---
"@zhushanwen/pi-goal": minor
---

Add dual-dimension continuation circuit breaker: a persisted hard total-count cap (never reset by tool activity) combined with no-progress backoff that clears on resume. Defer notifications are now deduplicated by pending-set changes.
