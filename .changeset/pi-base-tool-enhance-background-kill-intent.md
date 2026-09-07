---
"@zhushanwen/pi-base-tool-enhance": minor
---

Background tasks: killing intent is now read back when the poller exits, so kill requests that race with task completion are confirmed instead of silently dropped. Background spawn and task-store lifecycle bookkeeping hardened accordingly.
