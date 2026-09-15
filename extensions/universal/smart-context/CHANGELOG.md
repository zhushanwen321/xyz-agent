# @zhushanwen/pi-smart-context

## 0.3.1

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

## 0.3.0

### Minor Changes

- 4955dad6e: Normalize events to pi SDK types and align token estimation.

  - Like-event interfaces and `ToolInfo` are replaced with pi SDK event types across the extension, removing local duplicates.
  - The shadowed-token estimate now aligns with pi's `estimateTokens`, so compaction reminders trigger on the same numbers the agent core sees.
  - Handler gating during an active compaction is decided by `isGatingActive` instead of ad-hoc flags.

## 0.2.0

### Minor Changes

- 838806898: Compaction entries now record the model used (`details.model`) for usage attribution.

## 0.1.4

### Patch Changes

- 730fa1779: Maintenance release: keep the published package in sync with repository source (refactors and fixes shipped in v0.9.14); no public API contract changes.

## 0.1.3

### Patch Changes

- 7b33e6f00: **Supplemental changesets for five packages that changed src without a declaration (4N.1 scan finding)**

  - `@xyz-agent/extension-protocol`: add the `background-task` protocol module (task registration/reaping contract types consumed by the runtime background-task reaper sunk from base-tool-enhance), plus 183 lines of contract tests and index re-exports.
  - `@zhushanwen/pi-msg-id-mapper`: comment/test text sync with implementation (stale pi version comment fix, dead test mock dropped).
  - `@zhushanwen/pi-smart-context`: minor text sync in pure.ts.
  - `@zhushanwen/pi-system-prompt`: doc-comment sync clarifying the deliberate divergence from pi 0.84.4's `loadContextFileFromDir` (global-dir-only candidate list, no `AGENTS.override.md`); no behavior change.
  - `@zhushanwen/pi-unified-hooks` (deprecated package): text sync with implementation in the deprecated notice era.

## 0.1.2

### Patch Changes

- 837f2faf6: (no changeset body; patch version bump)

## 0.1.1

### Patch Changes

- d4f466667: chore: refresh dependency range (triggered by @zhushanwen/pi-extension-logger@0.2.2 → @zhushanwen/pi-extension-logger@0.3.0, @zhushanwen/pi-llm-shared@0.4.0 → @zhushanwen/pi-llm-shared@0.4.1)

# Changelog

## 0.1.0

- 初始版本：compact_context 工具、双模式生成接管（same-model / cross-model）、3 档阈值提醒、排除模型门控与切换通知、接管熔断与收缩校验、transcript 回查指针、文件重注入、config skill。
