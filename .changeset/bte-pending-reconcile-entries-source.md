---
'@zhushanwen/pi-base-tool-enhance': patch
---

Refresh pending-reconcile against the entries single-source pending API.

`src/background/pending-reconcile.ts` now computes the pending projection via `countActiveFromEntries` (session entries as single source of truth, matching pending-notifications 0.7.0). Republishing in the same batch also refreshes the published `@zhushanwen/pi-pending-notifications` peer pin (workspace-resolved to the 0.7.0 release), avoiding ERESOLVE under npm 7+ strict peer resolution.
