# @zhushanwen/pi-permission

## 1.2.0

### Minor Changes

- 2a724190c: **llm-shared: ModelSelector collapsed to ref-exact only; permission classifier gains thinkingLevel**

  - **pi-llm-shared**: `ModelSelector` now supports `ref` (exact `provider/model-id`) only — the `fallback` / `available` / `scoped` forms and the `settings.json` `enabledModels` glob machinery are removed. Auto model choice belongs to consumers via `ctx.modelRegistry`; unresolvable refs resolve to `null` (callers skip silently). `CallLLMOptions.reasoning` is now typed `ModelThinkingLevel` including `"off"`, which maps to omitting the reasoning field (provider default).
  - **pi-permission**: classifier config gains a `thinkingLevel` field (`"off" | minimal | low | medium | high | xhigh | max`), validated on load (invalid values fall back to `"off"`) and forwarded to the classifier LLM call. `classifier.model = "auto"` is now resolved locally from `ctx.modelRegistry.getAvailable()[0]` instead of the removed scoped selector; exact `provider/model-id` refs go through llm-shared's ref selector (fail-closed when unresolvable).

## 1.1.0

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

## 1.0.0

### Minor Changes

- 83e97ab: Integrate xyz-pi-extensions into xyz-agent monorepo

  - Migrate 17 @zhushanwen/pi-\* extension packages from standalone repository
  - Unify typebox imports to @sinclair/typebox across all extensions
  - Add unit tests for vision, quota-providers/cache, model-switch/advisor+setup
  - Fix type safety issues (PiAPI=any, TUnsafe compatibility)
  - Clean up migration residue (dead aliases, dangling symlinks, stale comments)

### Patch Changes

- Updated dependencies [83e97ab]
  - @zhushanwen/pi-statusline@0.6.0

## 0.1.0

### Minor Changes

- 66a42a4: Permission footer migration + onboarding widget

  - permission: removed self-managed footer, now registers footer line via globalThis Symbol handshake to statusline (solves footer single-slot conflict)
  - permission: added status widget showing rule count + classifier model (auto mode, since removed — see hotfix below)
  - statusline: upgraded to footer canonical owner (footer-handshake-access.ts), buildLines aggregates external lines
  - statusline: simplified line2 (speed/cache show current only, removed day marker, since restored — see hotfix below)

  # Hotfix — restore speed/cache day metrics + merge widget info into footer

  Two regressions from W1/W2 fixed in patch (0.4.8 → 0.4.9):

  - statusline: restore dual-value display for speed/cache (was oversimplified to current-only in W1):
    `speed 58t/s · day 70t/s` / `cache 96% · day 91%`. current=0/null hides whole segment.
  - permission: delete the standalone widget (classifier model moved to a widget in W2, leaving footer
    with only mode + enabled); merge all info into the footer line:
    `[permission] auto · enabled · N user rule(s) · classifier: <model>`
    classifier shown only in auto mode with non-empty model.
  - permission: replace `refreshWidget(ctx)` calls with `requestFooterRender()`.

  BREAKING CHANGE for permission-only users (no statusline installed): footer mode label is no longer displayed. Install @zhushanwen/pi-statusline to restore, or use /permission status.

### Patch Changes

- Updated dependencies [66a42a4]
  - @zhushanwen/pi-statusline@0.4.9

## 0.1.0 (unreleased)

### Breaking Changes

- **白名单扩张**：内置安全白名单从 24+5 扩至 50+9（新增 diff/jq/ps/du/file/sort/iconv 等）。auto/approve 模式下，这些命令从「需审批/AI 判」变为「静默放行」。已有用户若依赖这些命令触发审批，需自行添加 user rule。
- **approval 键位**：TUI 审批对话框移除 y/n 快捷键，仅保留 Enter（approve）/ Esc（deny）。
- **classifier prompt 改写**：auto 模式 AI 判定标准变化——写项目/cwd 目录的操作倾向 allow，写系统目录（~/.ssh、/etc）倾向 ask。

### Features

- 四档权限模式（yolo/auto/approve/strict）
- 三层管道（AST + 规则 + AI Classifier）
- rule editor（/permission rule overlay CRUD）
- model picker（/permission model）
- statusline footer 集成
