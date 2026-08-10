---
'@zhushanwen/pi-scheduler': patch
---

Extract `SchedulerBackend` and unify tool/command dispatch through `SchedulerService`. Fix the cron fallback loop and correct the misleading "every X" display for once tasks (now shown as "once in X").
