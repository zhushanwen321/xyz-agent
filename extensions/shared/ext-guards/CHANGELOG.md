# @zhushanwen/pi-ext-guards

## 0.4.0

### Minor Changes

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

## 0.3.0

### Minor Changes

- 4955dad6e: Crash-resilience guard against stale-context async callbacks.

  - **pi-ext-guards**: exports the new `guardStaleCtx` helper. It wraps session-scoped async callbacks so that, once the hosting session is no longer active, late resolves are dropped instead of writing into a dead or recycled context.
  - **pi-plan / pi-scheduler / pi-structured-output**: adopt `guardStaleCtx` around their session-lifetime async flows (plan compaction, scheduler tick handlers, structured-output loop gating), preventing late callbacks from landing in a session that has already ended.

## 0.2.1

### Patch Changes

- 730fa1779: Maintenance release: keep the published package in sync with repository source (refactors and fixes shipped in v0.9.14); no public API contract changes.

## 0.2.0

### Minor Changes

- 7b33e6f00: **extension-logger: XYZ_AGENT_EXT_LOG info-level sink; ext-guards: first release of the oncePerProcess guard package**

  - `@zhushanwen/pi-extension-logger`: a new `XYZ_AGENT_EXT_LOG=1` environment variable makes extensions log at INFO level to `<agentDir>/logs/<ext>-<date>.log` with 7-day retention, for hosts (xyz-agent runtime) that inject the variable when spawning pi. Without any of the logging variables the logger stays a zero-disk no-op — standalone pi users see no behavior change. `XYZ_AGENT_DEBUG=1` keeps full DEBUG logging unchanged; when both are set the more verbose wins.
  - `@zhushanwen/pi-ext-guards` (new shared package): `oncePerProcess(key, fn)` — a process-level dedup wrapper for cross-session side effects in session_start handlers. Rationale: pi's extension cache is keyed by cwd, so a `switch_session` to a session with the same cwd re-invokes the extension factory and accumulates handler registrations — the same event is dispatched once per registration group. `oncePerProcess` caches the first result (value/Promise/error all replayed as the same instance, a rejected Promise does not release the key, and fn errors are re-thrown unwrapped), which makes "at most once per process" semantics explicit instead of relying on each extension's ad-hoc inline flags.
