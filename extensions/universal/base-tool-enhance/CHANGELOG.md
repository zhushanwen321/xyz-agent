# @zhushanwen/pi-base-tool-enhance

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
