# @zhushanwen/pi-rename-session

## 0.4.0

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

## 0.3.0

### Minor Changes

- 83e97ab: Integrate xyz-pi-extensions into xyz-agent monorepo

  - Migrate 17 @zhushanwen/pi-\* extension packages from standalone repository
  - Unify typebox imports to @sinclair/typebox across all extensions
  - Add unit tests for vision, quota-providers/cache, model-switch/advisor+setup
  - Fix type safety issues (PiAPI=any, TUnsafe compatibility)
  - Clean up migration residue (dead aliases, dangling symlinks, stale comments)

## 0.2.0

### Minor Changes

- eea3e5f: New extension: auto-rename sessions after the first turn.

  - Listens to `turn_end` and, on a new session's first assistant reply, generates a short (3-8 word, language-following) title via an independent LLM call that reuses the main turn's full context (hits kvcache, near-zero extra cost).
  - Title is persisted via `setSessionName` without touching session history.
  - Subagent sub-process sessions (path contains a `subagents` segment) are auto-excluded.
  - fire-and-forget: any failure (LLM / extraction / auth / read) is silently skipped, leaving the original label and never blocking the agent loop.
  - Gated by an opt-in switch file (default off).
