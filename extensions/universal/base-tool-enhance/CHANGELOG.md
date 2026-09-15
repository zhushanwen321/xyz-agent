# @zhushanwen/pi-base-tool-enhance

## 0.5.3

### Patch Changes

- 64f17310a: ext-simplify-17 cross-package shared extraction (shared-layer convergence):

  - ext-guards: new isRecord (array-excluding) and isEnoentError predicates,
  plus SUBAGENT_MARKER_ENV / isSubagentProcess for engine-spawned subagent
  detection (ext-simplify-17 D2/D3/D4)
  - llm-shared: adopts toErrorMessage internally; new isThinkingLevel (seven
  values incl. xhigh), normalizeModelSelector, joinTextBlocks exports. Note
  for standalone pi users: llm-shared now depends on @zhushanwen/pi-ext-guards
  (runtime dependency closure grows by one zero-dep package, D1/D5/D6/D7)
  - extension-protocol: new callMarkerRpc select+marker RPC primitive with
  MarkerRpcResult discriminated union and ChannelErrorResult error-shape
  single source; GuiContext.ui.select gains timeout field; firstContentText
  helper; mapReasonToStatus pending-entry mapping; plugin-bridge guard family
  moved here (four guards token-identical; isBridgeErrorResponse delegates to
  shared isChannelErrorResult, condition-equivalent). Existing type exports
  keep their names — SessionManagerErrorResult / BridgeErrorResponse are now
  aliases over the shared shape, public API unbroken (D8/D9/D10/D11)
  - base-tool-enhance: adopts ext-guards toErrorMessage (13 inline sites);
  subagent detection rerooted to the engine-injected XYZ_AGENT_SUBAGENT
  marker (old PI_SUBAGENT_* keys had no injector — in-subagent background
  downgrade was dead and now works again); pending unregister entries now
  write mapped status instead of raw reason (D1/D4/D10)
  - rename-session: drops local THINKING_LEVELS / normalizeModelSelector /
  joinTextBlocks / isRecord copies in favor of shared exports; three-site
  code-point truncation merged into truncateCodePoints, byte-identical
  (D3/D5/D6/D7/D13)
  - plan: inline firstContentText copy replaced by protocol import (new
  dependency wiring) (D9)
  - pi-rpc: ThinkingLevel whitelist gains xhigh — the :xhigh model suffix was
  silently dropped before; now accepted per pi-ai ModelThinkingLevel (P1-a)
  - session-manager: non-JSON channel responses now surface as isError with a
  logged trace instead of silently passing through as success text (intended
  behavior change, aligns with plugin-bridge shape) (D8)
  - todo: fixedWidth retired in favor of pi-tui truncateToWidth combination,
  visible output byte-identical (double-ellipsis truncation form locked by
  tests) (D14); firstContentText copy now imports from protocol (D9)
  - scheduler: adopts toErrorMessage (7 sites), entry-type literal converged
  to a constant, dual task/snapshot converters and history helpers unified
  in types.ts, isEnoentError imported from ext-guards — all behavior-neutral
  (D1/D12/D2)
  - permission: local THINKING_LEVELS/isModelThinkingLevel copies dropped in
  favor of llm-shared isThinkingLevel (D5)
  - smart-context: compact-model restore uses llm-shared
  normalizeModelSelector (D6); subagent detection converges on
  XYZ_AGENT_SUBAGENT marker via ext-guards (D4)
  - pending-notifications: mapReasonToStatus now delegates to the protocol
  single source (D10)
  - subagent-workflow: wide isEnoentError copy replaced by strict ext-guards
  import (D2); renderTextFallback delegates to protocol firstContentText
  (D9); inflight reporter send path uses callMarkerRpc primitive (D8)
  - plugin-bridge: callBridge transport core replaced by callMarkerRpc
  primitive (mode gate stays caller-side); guard family moved to protocol
  (four token-identical, error guard delegating) with local copies importing
  from there (D8/D11/D3)

- 64f17310a: ext-simplify-18 shared adoption batch (ext-simplify-17 registered legacy

  topic cash-in):

  - llm-shared: new parseModelRef export ("provider/modelId" ref parsing,
  renamed from private parseRef, body verbatim) (D4)
  - Five packages gain @zhushanwen/pi-ext-guards dependency
  (session-reader / cache-probe / cw-tool / ask-user /
  system-prompt-trace): standalone pi users' closure grows by one
  zero-dependency pure-function package (dependency groundwork)
  - toErrorMessage adoption: 26 hand-written inline sites across
  permission (7), session-reader (5), cache-probe (5, incl. one
  String()-wrapper variant), structured-output (3), smart-context (2),
  subagent-workflow (2), ask-user (1), cw-tool (1) all switched to the
  ext-guards export (D1)
  - isRecord/isPlainObject adoption: 9 local copies removed (3 strict
  identical + 5 lenient migrated to strict with per-site equivalence
  argued + bte missed-site caught by zero-residue grep). All in-package
  consumers switched to ext-guards isRecord. structured-output keeps a
  deprecated isPlainObject re-export for its deep-path public name;
  system-prompt-trace deletes its exported copy outright (taiji group,
  zero external imports) (D2)
  - isEnoentError adoption: cw-tool spawn-error hints (2 sites) and
  rename-session flag cleanup (1 site, also drops an as-cast) (D3)
  - permission: model-picker provider/model preselection now parses specs
  via llm-shared parseModelRef — intended micro-change: a pathological
  "provider/" (empty modelId) manual config value now falls back to Auto
  instead of half-selecting the provider; all well-formed refs unchanged
  (D4, pinned by MPT8)
  - session-reader: three SessionHeader first-line readers consolidated
  into discovery/session-header.ts (two near-identical async 8KB copies
  merged; sync 4KB id-reader moved verbatim) (D5)
  - Thinking-vocabulary guard: subagent-core THINKING_ORDER joins the
  check-thinking-levels comparison plane (T3, set-equality; order
  semantics stay pinned by subagent-core tests); pre-commit trigger
  surface gains model-ref.ts; C-build-10 registration synced (D6)

## 0.5.2

### Patch Changes

- 4955dad6e: Refresh pending-reconcile against the entries single-source pending API.

  `src/background/pending-reconcile.ts` now computes the pending projection via `countActiveFromEntries` (session entries as single source of truth, matching pending-notifications 0.7.0). Republishing in the same batch also refreshes the published `@zhushanwen/pi-pending-notifications` peer pin (workspace-resolved to the 0.7.0 release), avoiding ERESOLVE under npm 7+ strict peer resolution.

## 0.5.1

### Patch Changes

- 838806898: chore: refresh dependency range (triggered by @zhushanwen/pi-llm-shared@0.5.1 → @zhushanwen/pi-llm-shared@0.6.0, @zhushanwen/pi-pending-notifications@0.5.3 → @zhushanwen/pi-pending-notifications@0.6.0)

## 0.5.0

### Minor Changes

- bbd8e5e8a: Background tasks: killing intent is now read back when the poller exits, so kill requests that race with task completion are confirmed instead of silently dropped. Background spawn and task-store lifecycle bookkeeping hardened accordingly.

## 0.4.1

### Patch Changes

- 730fa1779: Maintenance release: keep the published package in sync with repository source (refactors and fixes shipped in v0.9.14); no public API contract changes.

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
