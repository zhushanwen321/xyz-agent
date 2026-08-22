# @zhushanwen/pi-rename-session

## 0.5.1

### Patch Changes

- 8e52cb3ba: chore: refresh dependency range (triggered by @zhushanwen/pi-llm-shared@0.3.0 → @zhushanwen/pi-llm-shared@0.3.1)

## 0.5.0

### Minor Changes

- 2a724190c: **rename-session: round-end trigger, two-segment input, slug-style titles, and reliability hardening**

  - **Round-end trigger**: the rename LLM call now fires only after the session's first *successful* round fully completes (the final `turn_end` with `stopReason === "stop"`). Previously naming could effectively rely on the first turn's partial state; intermediate tool iterations are now skipped explicitly (`skip: stopReason=toolUse`), and error/aborted/length rounds defer naming to the next successful round instead of using error context.
  - **Two-segment input**: the title LLM now receives `[user(first prompt), assistant(final reply), user(instruction)]` — each text segment truncated to 4000 Unicode code points — instead of the full conversation prefix. Tool calls/results and other process data are no longer injected, which sharply reduces input tokens (cost no longer grows with the number of tool iterations) and improves title signal quality.
  - **Slug-style titles**: rewritten system prompt and instruction anchor a slug phrase style (noun/gerund phrase, no full sentences, no pronouns or tense markers, no trailing punctuation; lowercase kebab-case for English; follows the conversation language, 3-6 words). `cleanTitle` now also strips trailing punctuation.
  - **30s timeout**: the title LLM call is bounded by a fixed 30s timeout; timeouts normalize to a silent skip with a failure log line (`rename LLM call failed: ...`) instead of hanging the fire-and-forget promise.
  - **Manual-name race guard**: the session name is re-checked immediately before persisting, so a name set via pi (i.e. the `set_session_name` RPC) during the 2-30s LLM call window is not overwritten (`skip: name exists`); out-of-band JSONL edits (e.g. xyz-agent runtime rename) are not visible to the guard.
  - **Debug evidence chain**: `XYZ_AGENT_DEBUG=1` now emits an introspection log of the exact messages sent to the title LLM (role + head200/tail100 text preview) plus skip/decision logs with timestamps and turn indices — the contract used by the new E2E suite (`e2e/run-a1..a5.mjs`, `e2e/run-all.mjs`).

- 2a724190c: **rename-session: configurable thinking level for title generation**

  - **pi-llm-shared**: `CallLLMOptions` gains an optional `reasoning` field, forwarded to `completeSimple`'s `SimpleStreamOptions.reasoning` (pi-ai `ThinkingLevel`: minimal/low/medium/high/xhigh/max). Omitted = provider default; no behavioral change for existing callers (permission classifier etc.).

  - **pi-rename-session**: new `thinkingLevel` config field (`<agentDir>/config/rename-session-ext-config.json`), type `ModelThinkingLevel` ("off" | minimal | low | medium | high | xhigh | max), default "off". `"off"` maps to not passing `reasoning` (previous behavior); other values are forwarded to the LLM call. Invalid/missing values fall back to "off"; existing config files keep working unchanged.

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
