---
"@zhushanwen/pi-subagent-workflow": patch
"@zhushanwen/pi-unified-hooks": patch
---

Migrate bare console.* to shared extension-logger (three-channel routing via appendEntry/file-log). Eliminates TUI raw stderr pollution and redundant tool-error notify.
