---
'@zhushanwen/pi-pending-notifications': minor
---

**pending-notifications: `bash` task type and `process` lifecycle tier**

- Extensions can now register async operations with a `process` lifecycle tier alongside the existing `session` tier
- `process`-tier entries are exempt from the 1h TTL expiry, survive across sessions and are not flushed on shutdown — long-running background tasks no longer get their completion notifications silently dropped while still running
- Adds the `bash` task type (used by pi-base-tool-enhance background tasks); type registry stays open for future extension-defined types
