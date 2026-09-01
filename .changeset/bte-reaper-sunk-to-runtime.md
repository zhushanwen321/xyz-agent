---
'@zhushanwen/pi-base-tool-enhance': minor
'@zhushanwen/pi-permission': minor
'@zhushanwen/pi-subagent-workflow': minor
---

**base-tool-enhance: orphan reaping sunk to the xyz-agent runtime; permission / subagent-workflow: session_start side effects guarded**

- `@zhushanwen/pi-base-tool-enhance`: orphaned background-task reaping no longer runs inside every pi process (the global session_start scan with the global `reaper.lock` — the crash trigger surface of the 2026-09-01 incident). The xyz-agent runtime now owns collection with two trigger faces: at session destruction (covers delete/process-exit/forceQuit/restore cleanup) and as a startup full scan chained after orphaned-pi reaping. This package keeps writing only its own session's registry (now typed by the `@xyz-agent/extension-protocol` contract, a new dependency) and the per-session pending reconcile; `bash_kill`'s user-facing hint now points at runtime collection instead of "the reaper will collect at next session start".
- `@zhushanwen/pi-permission`: the legacy-config migration in session_start is wrapped with `oncePerProcess` (replacing the package's inline module-level flag), so a factory double-invocation can no longer re-run the agentDir-global file migration. New dependency: `@zhushanwen/pi-ext-guards`.
- `@zhushanwen/pi-subagent-workflow`: the six cross-session side effects in the session_start handler (engines.json sync, idle GC timer registration, expired session-file cleanup, manifest tmp recovery, orphan worktree scan, crashed-run recovery) are each wrapped with `oncePerProcess` — process-level maintenance now runs at most once per process under handler accumulation, while session-scoped operations (identity appendEntry, notify-ledger bind/recover, service init, sessionState) keep per-event semantics. New dependency: `@zhushanwen/pi-ext-guards`.
