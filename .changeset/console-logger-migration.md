---
'@zhushanwen/pi-file-lock': patch
'@zhushanwen/pi-llm-shared': patch
'@zhushanwen/pi-msg-id-mapper': patch
'@zhushanwen/pi-system-prompt-trace': patch
'@zhushanwen/pi-ask-user': patch
'@zhushanwen/pi-pending-notifications': patch
'@zhushanwen/pi-permission': patch
'@zhushanwen/pi-plan': patch
'@zhushanwen/pi-rename-session': patch
'@zhushanwen/pi-todo': patch
'@zhushanwen/pi-unified-hooks': patch
---

Migrate bare console calls to the shared extension logger (pi-extension-logger) so diagnostic logs flow through the unified logging channel with structured fields instead of raw stdout, and drop the redundant generalized log entry emitted on tool errors
