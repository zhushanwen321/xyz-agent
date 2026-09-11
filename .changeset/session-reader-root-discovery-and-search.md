---
'@zhushanwen/pi-session-reader': minor
---

session_read resolves its session roots explicitly and gains cross-session search plus a one-shot diagnostics action.

- **Explicit root discovery**: session roots are now resolved from labeled candidate roots (pi default layout, legacy layout, explicit environment override) and the matched label is reported, instead of assuming a single fixed layout. `resolveSessionRoots` replaces the previous single-path derivation.
- **Environment detection**: the extension now tells a hosted run (spawned by the xyz-agent runtime) apart from a standalone pi run by a conjunction of signals, and carries the resulting mode through the tool handler so every action reports the roots it actually used.
- **New `doctor` action**: probes the resolved roots for residual or orphaned session entries, and caches the resolved root for the turn so repeated calls do not re-walk the filesystem.
- **Cross-session content search**: matching now covers message content across every session file under the resolved roots, in addition to the existing metadata matches.
- **Title search**: titles are matched through `SessionManager.listAll`, so a session whose title exists only in the manager index is still found.
- **Grouped `find` output**: results are grouped by session and print full session ids, so a returned id can be pasted straight into a follow-up call without an extra lookup step.
- **UUID normalization**: session ids supplied in any of the accepted forms are normalized to the canonical id before lookup, and lookups self-check the id they report.
