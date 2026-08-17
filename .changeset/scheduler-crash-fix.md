---
"@zhushanwen/pi-scheduler": patch
---

Fix a pi-process crash caused by a leaked tick timer after session replacement:

- **Root cause**: when a scheduled task dispatch was inside its `await sendMessage` window and the session got replaced (`new_session` / `switch_session`), the old 30s tick timer could survive. Its next tick called `refreshWidget` on the captured stale ctx whose `ui` getter throws, and the fire-and-forget `void tickScheduler()` turned that rejection into an `unhandledRejection` that killed the pi process (exit 1).
- **Source fix**: the `session_start` handler now stops the prior runtime's timer first (`service?.runtime.stopScheduler()`) — an idempotent guard against multi-fired/re-entered `session_start` leaking the previous interval.
- **Defense in depth**: the tick interval callback now catches tick rejections. Stale-ctx errors (message contains "stale after session replacement") self-retire the timer with a warning; other errors warn and keep scheduling. The timer is deliberately not `unref`-ed — in rpc/daemon mode that would let the process exit early and kill scheduled tasks.
