# @zhushanwen/pi-llm-shared

## 0.8.0

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

## 0.7.0

### Minor Changes

- 4955dad6e: Remove dead `MigrationResult` type re-export from the public entry.

  `MigrationResult` is still defined in `src/migrate.ts` (return type of `migrateLegacyConfig`, kept until the permission v2.0.0 migration sunset), but it is no longer re-exported from the package entry: `rg "MigrationResult" extensions/` shows zero external consumers — the only production caller (`@zhushanwen/pi-permission`) ignores the return value, and no workspace package imports the type. For standalone TS consumers importing the type this is a compile-time breaking change, shipped as a minor bump per the repo's 0.x convention (minor = breaking; precedent: llm-shared 0.5.0 dead API surface removal).

## 0.6.0

### Minor Changes

- 838806898: `CallLLMResult` now carries token usage through to callers, enabling downstream LLM calls to report usage.

## 0.5.1

### Patch Changes

- 730fa1779: Maintenance release: keep the published package in sync with repository source (refactors and fixes shipped in v0.9.14); no public API contract changes.

## 0.5.0

### Minor Changes

- 7b33e6f00: **shared libs: remove dead package-root barrels and llm-shared dead API surface**

  - The package-root `index.ts` in `@zhushanwen/pi-extension-logger`, `@zhushanwen/pi-file-lock`, and `@zhushanwen/pi-llm-shared` is deleted. Each package's `main` points at `src/index.ts` and none of the root barrels was ever resolved (zero deep imports across the repo), so resolution behavior is unchanged. The `index.ts` entry is dropped from `files` (publish surface shrink) and from the two tsconfigs' `include` that listed it.
  - `@zhushanwen/pi-llm-shared`: the `recoverable` field is removed from the `CallLLMResult` failure variant. All three construction sites in `src/call.ts` hardcoded `true`, the sole production constructor outside the library (`permission` classifier) never read it, and no consumer branched on it — the field was pure noise on every `ok:false` result. The `CallLLMResult`-typed test fixtures are updated accordingly.
  - `@zhushanwen/pi-llm-shared`: `extractText` is no longer re-exported from `src/index.ts` (zero external consumers; same-named helpers elsewhere in the repo are deliberate local implementations). The function itself stays in `src/call.ts` for internal use, so deep imports of `../call.ts` are unaffected.

## 0.4.2

### Patch Changes

- 837f2faf6: (no changeset body; patch version bump)

## 0.4.1

### Patch Changes

- d4f466667: Migrate bare console calls to the shared extension logger (pi-extension-logger) so diagnostic logs flow through the unified logging channel with structured fields instead of raw stdout, and drop the redundant generalized log entry emitted on tool errors

## 0.4.0

### Minor Changes

- 63aa77435: Repo reorganization and dependency convergence for the 0.9.5 cycle

  - Extension packages are grouped into `extensions/taiji/` (xyz-agent integrated) and `extensions/universal/` (standalone); install targets and READMEs updated accordingly
  - earendil family dependencies converged to 0.84.1 (peer/dependency ranges updated)
  - llm-shared: export shared `getCurrentModelId` helper for model consumers
  - model-switch: consume the shared helper, internal simplification

## 0.3.1

### Patch Changes

- 8e52cb3ba: Cross-process write governance and cache correctness (integrity hardening)

  - file-lock: shared cross-process lock module (withFileLockSync) used by runtime and extensions; field-scope merge on concurrent config writes
  - llm-shared: config saves under file lock; unique tmp file names (pid + random suffix) eliminate concurrent same-name tmp collisions between processes
  - quota-providers: disk cache prunes removed/disabled provider entries on providers.json mtime change instead of waiting for TTL expiry; value domains aligned to pi 0.84.1 via SSOT derivation
  - session-reader: main session file resolved by sessionId (not getSessionFile), passed by value into initSession; entry-only orphan recovery after spawn-window deaths

## 0.3.0

### Minor Changes

- 2a724190c: **llm-shared: ModelSelector collapsed to ref-exact only; permission classifier gains thinkingLevel**

  - **pi-llm-shared**: `ModelSelector` now supports `ref` (exact `provider/model-id`) only — the `fallback` / `available` / `scoped` forms and the `settings.json` `enabledModels` glob machinery are removed. Auto model choice belongs to consumers via `ctx.modelRegistry`; unresolvable refs resolve to `null` (callers skip silently). `CallLLMOptions.reasoning` is now typed `ModelThinkingLevel` including `"off"`, which maps to omitting the reasoning field (provider default).
  - **pi-permission**: classifier config gains a `thinkingLevel` field (`"off" | minimal | low | medium | high | xhigh | max`), validated on load (invalid values fall back to `"off"`) and forwarded to the classifier LLM call. `classifier.model = "auto"` is now resolved locally from `ctx.modelRegistry.getAvailable()[0]` instead of the removed scoped selector; exact `provider/model-id` refs go through llm-shared's ref selector (fail-closed when unresolvable).

- 2a724190c: **rename-session: configurable thinking level for title generation**

  - **pi-llm-shared**: `CallLLMOptions` gains an optional `reasoning` field, forwarded to `completeSimple`'s `SimpleStreamOptions.reasoning` (pi-ai `ThinkingLevel`: minimal/low/medium/high/xhigh/max). Omitted = provider default; no behavioral change for existing callers (permission classifier etc.).

  - **pi-rename-session**: new `thinkingLevel` config field (`<agentDir>/config/rename-session-ext-config.json`), type `ModelThinkingLevel` ("off" | minimal | low | medium | high | xhigh | max), default "off". `"off"` maps to not passing `reasoning` (previous behavior); other values are forwarded to the LLM call. Invalid/missing values fall back to "off"; existing config files keep working unchanged.

## 0.2.0

### Minor Changes

- 1565e57fa: **Shared LLM/config library + config path consolidation (first release of `@zhushanwen/pi-llm-shared`)**

  - **pi-llm-shared (new)**: shared library for extensions — generic config IO (`<agentDir>/config/<pkg>-ext-config.json`, mtime+size read-through cache, atomic write), unified LLM call helper (`callLLM`), `ModelSelector` resolution (ref exact only), and `migrateLegacyConfig` (idempotent best-effort rename used by session_start migration hooks). Note: must publish together with (or before) its consumers below; the packages resolve it via `workspace:*`.

  - **pi-permission**: config file moved from `<agentDir>/permission-config.json` to `<agentDir>/config/permission-ext-config.json` (one-shot idempotent migration on session_start, old file removed after move); LLM classifier plumbing now goes through pi-llm-shared (`callLLM` + `ModelSelector`); classifier model `auto` is resolved locally from `ctx.modelRegistry.getAvailable()`; exact `provider/model-id` uses the llm-shared ref selector.

  - **pi-rename-session**: switch and settings now live in `<agentDir>/config/rename-session-ext-config.json` (`enabled` / `model` / `maxTitleLength`); title generation uses an independent slim system prompt with explicit `tools: []` and its own model selector (ref exact only; default empty ref) instead of piggybacking the main session model. The legacy `<agentDir>/auto-rename-enabled` flag file is kept as a live override (checked every turn) so the released xyz-agent runtime toggle keeps working — `/auto-rename on|off` syncs both mechanisms.

  - **pi-model-switch**: config file moved from `<agentDir>/model-policy.json` to `<agentDir>/config/model-switch-ext-config.json` (session_start migration); new `model-switch-ext-config` skill documenting schema and defaults.

  - **pi-scheduler**: new `scheduler-ext-config` skill (cron/interval formats, JSONL event-sourcing storage); legacy store import now resolves candidate dirs via `getAgentDir()` so isolated agent dirs (`PI_CODING_AGENT_DIR`) work.

  - **pi-quota-providers**: quota cache moved from `<agentDir>/statusline_cache.json` to `<agentDir>/config/quota-cache.json` (first-load migration, old cache ignored → cold refetch); all paths derive from `getAgentDir()` for instance isolation.

  - **pi-subagent-workflow**: fix worktree registry pid staying 0 in RPC mode (reaper could reap live worktrees after grace timeout — pid is now registered right after spawn); skill/session-dir resolution derives from `getAgentDir()` instead of hard-coded `~/.pi/agent`.

  - **pi-plan**: global plan-template directory derives from `getAgentDir()` so isolated agent dirs (`PI_CODING_AGENT_DIR`) are respected.
