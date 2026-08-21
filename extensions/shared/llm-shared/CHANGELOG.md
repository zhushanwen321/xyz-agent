# @zhushanwen/pi-llm-shared

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
