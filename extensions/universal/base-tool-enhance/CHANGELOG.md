# @zhushanwen/pi-base-tool-enhance

## 0.4.0

### Minor Changes

- 7b33e6f00: **base-tool-enhance: orphan reaping sunk to the xyz-agent runtime; permission / subagent-workflow: session_start side effects guarded**

  - `@zhushanwen/pi-base-tool-enhance`: orphaned background-task reaping no longer runs inside every pi process (the global session_start scan with the global `reaper.lock` — the crash trigger surface of the 2026-09-01 incident). The xyz-agent runtime now owns collection with two trigger faces: at session destruction (covers delete/process-exit/forceQuit/restore cleanup) and as a startup full scan chained after orphaned-pi reaping. This package keeps writing only its own session's registry (now typed by the `@xyz-agent/extension-protocol` contract, a new dependency) and the per-session pending reconcile; `bash_kill`'s user-facing hint now points at runtime collection instead of "the reaper will collect at next session start".
  - `@zhushanwen/pi-permission`: the legacy-config migration in session_start is wrapped with `oncePerProcess` (replacing the package's inline module-level flag), so a factory double-invocation can no longer re-run the agentDir-global file migration. New dependency: `@zhushanwen/pi-ext-guards`.
  - `@zhushanwen/pi-subagent-workflow`: the six cross-session side effects in the session_start handler (engines.json sync, idle GC timer registration, expired session-file cleanup, manifest tmp recovery, orphan worktree scan, crashed-run recovery) are each wrapped with `oncePerProcess` — process-level maintenance now runs at most once per process under handler accumulation, while session-scoped operations (identity appendEntry, notify-ledger bind/recover, service init, sessionState) keep per-event semantics. New dependency: `@zhushanwen/pi-ext-guards`.

## 0.3.1

### Patch Changes

- 837f2faf6: (no changeset body; patch version bump)

## 0.3.0

### Minor Changes

- 23d8fe3cc: **pi-base-tool-enhance (first release): bash background mode, configurable timeouts and tool-error audit**

  - `bash` tool gains an incremental `background` mode: long-running commands (test suites, dev servers, watch builds) return a `task_id` immediately instead of blocking the whole turn; results are delivered as a notification when the task finishes
  - Configurable allowlists auto-move test-class and long-running commands (e.g. `pnpm test`, `vitest --watch`) to the background — no more block-and-retry round trips just to add a timeout parameter
  - Foreground and background default timeouts are both configurable (`foregroundTimeoutSeconds` / `backgroundTimeoutSeconds`, off by default); forced-background tasks ignore the LLM-supplied timeout so long suites are never killed at 120s
  - New `bash_output` / `bash_kill` tools to list, poll and terminate background tasks (live output, exit codes, concurrent-task cap)
  - Orphan reaper: background processes left behind by a crashed or killed pi session are detected and cleaned up on next start
  - Tool errors are audited to the session log (custom entry `unified-hooks:tool-error`, same type as the deprecated unified-hooks extension so history stays queryable)

## 0.2.0

### Minor Changes

- b3a8cf77b: **pi-base-tool-enhance (first release): bash background mode, configurable timeouts and tool-error audit**

  - `bash` tool gains an incremental `background` mode: long-running commands (test suites, dev servers, watch builds) return a `task_id` immediately instead of blocking the whole turn; results are delivered as a notification when the task finishes
  - Configurable allowlists auto-move test-class and long-running commands (e.g. `pnpm test`, `vitest --watch`) to the background — no more block-and-retry round trips just to add a timeout parameter
  - Foreground and background default timeouts are both configurable (`foregroundTimeoutSeconds` / `backgroundTimeoutSeconds`, off by default); forced-background tasks ignore the LLM-supplied timeout so long suites are never killed at 120s
  - New `bash_output` / `bash_kill` tools to list, poll and terminate background tasks (live output, exit codes, concurrent-task cap)
  - Orphan reaper: background processes left behind by a crashed or killed pi session are detected and cleaned up on next start
  - Tool errors are audited to the session log (custom entry `unified-hooks:tool-error`, same type as the deprecated unified-hooks extension so history stays queryable)
