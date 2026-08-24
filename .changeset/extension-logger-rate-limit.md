---
'@zhushanwen/pi-extension-logger': minor
---

Add per-message fixed-window rate limiting for appendEntry writes so a hot loop of log entries can no longer flood the session file; excess entries within a window are summarized instead of written one by one
