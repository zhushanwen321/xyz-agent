# @zhushanwen/pi-unified-hooks

## 0.2.7

### Patch Changes

- 23d8fe3cc: **Deprecated: superseded by `@zhushanwen/pi-base-tool-enhance`**

  - This package is no longer maintained and is marked `deprecated` on npm
  - Test-command guarding, tool-error audit and hang protection (now via configurable timeouts) are all covered by `pi-base-tool-enhance`
  - Migration: uninstall this package (`pi uninstall npm:@zhushanwen/pi-unified-hooks`), then install `pi-base-tool-enhance`. Keeping both installed causes double interception of `bash` calls — always remove this one first

## 0.2.6

### Patch Changes

- b3a8cf77b: **Deprecated: superseded by `@zhushanwen/pi-base-tool-enhance`**

  - This package is no longer maintained and is marked `deprecated` on npm
  - Test-command guarding, tool-error audit and hang protection (now via configurable timeouts) are all covered by `pi-base-tool-enhance`
  - Migration: uninstall this package (`pi uninstall npm:@zhushanwen/pi-unified-hooks`), then install `pi-base-tool-enhance`. Keeping both installed causes double interception of `bash` calls — always remove this one first

## 0.2.5

### Patch Changes

- d4f466667: Migrate bare console calls to the shared extension logger (pi-extension-logger) so diagnostic logs flow through the unified logging channel with structured fields instead of raw stdout, and drop the redundant generalized log entry emitted on tool errors

## 0.2.4

### Patch Changes

- 63aa77435: Repo reorganization and dependency convergence for the 0.9.5 cycle

  - Extension packages are grouped into `extensions/taiji/` (xyz-agent integrated) and `extensions/universal/` (standalone); install targets and READMEs updated accordingly
  - earendil family dependencies converged to 0.84.1 (peer/dependency ranges updated)
  - llm-shared: export shared `getCurrentModelId` helper for model consumers
  - model-switch: consume the shared helper, internal simplification

## 0.2.3

### Patch Changes

- 8e52cb3ba: Align extension behavior with installed pi 0.84.1 semantics (pi-assumption remediation)

  - Tool/command errors are now thrown instead of returned with `isError: true` — pi only honors thrown errors; `isError` in return values is discarded by agent-loop (ask-user, scheduler)
  - ask-user: guard undefined custom-dialog result in json/print mode (noOpUIContext returns undefined); drop ineffective `isError` field from execute result type
  - model-switch: actually switches by calling `ctx.api.setModel` — previous path silently no-op'd; pi clamps unsupported thinking levels silently, effective level returned in reply
  - pending-notifications: correct stale-listener rationale — pi tracks event-bus subscriptions and auto-unsubscribes on invalidate/session replace
  - permission / unified-hooks: correct ctx.ui theme/undefined assumptions per pi 0.84.1 type authority
  - goal: remove stale-context pattern matching no longer reachable under pi 0.84.1 lifecycle

## 0.2.2

### Patch Changes

- 2a724190c: chore: refresh dependency range (triggered by @zhushanwen/pi-extension-logger@0.2.0 → @zhushanwen/pi-extension-logger@0.2.1)

## 0.2.1

### Patch Changes

- e33b3a6: Migrate bare console.\* to shared extension-logger (three-channel routing via appendEntry/file-log). Eliminates TUI raw stderr pollution and redundant tool-error notify.

  <!-- TODO(monorepo-impact): 三个包不在同一 linked 组。pi-extension-logger 作为 -->
  <!-- 静态强依赖出现在 subagent-workflow/unified-hooks 的 dependencies，值为 -->
  <!-- `workspace:*`，发布时会被 workspace 工具替换为精确版本号（无 `^`/`>=` 范围保护）。 -->
  <!-- logger 未来若发 breaking，已装 consumer 不感知。logger 语义稳定前可接受。 -->
  <!-- 如需加固：发布后人工核对 consumer package.json 产物是否带 caret，必要时 -->
  <!-- 改 `publishConfig` 或发布后手动改成 `^0.1.0`。提示非阻塞。 -->

- Updated dependencies [1e33329]
  - @zhushanwen/pi-extension-logger@0.2.0

## 0.2.0

### Minor Changes

- 83e97ab: Integrate xyz-pi-extensions into xyz-agent monorepo

  - Migrate 17 @zhushanwen/pi-\* extension packages from standalone repository
  - Unify typebox imports to @sinclair/typebox across all extensions
  - Add unit tests for vision, quota-providers/cache, model-switch/advisor+setup
  - Fix type safety issues (PiAPI=any, TUnsafe compatibility)
  - Clean up migration residue (dead aliases, dangling symlinks, stale comments)

## 0.1.3

### Patch Changes

- 9169119: Migrate all Pi SDK references from the deprecated `@mariozechner/pi-*` namespace to the active `@earendil-works/pi-*` namespace. This eliminates the five deprecation warnings emitted during `pnpm install` (`@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `@mariozechner/pi-ai`, transitive `@mariozechner/pi-agent-core`, and transitive `node-domexception`).

  **Changes:**

  - **package.json**: all `peerDependencies` / `peerDependenciesMeta` referencing `@mariozechner/pi-*` updated to `@earendil-works/pi-*` (versions unchanged: `*`)
  - **TypeScript sources**: all `import ... from "@mariozechner/pi-*"` updated to `import ... from "@earendil-works/pi-*"` across 98 files (438 import occurrences including `declare module` and dynamic `import()` types)
  - **`tsconfig.json` paths**: removed `@mariozechner/pi-*` dual-alias entries; kept only `@earendil-works/pi-*`
  - **`vitest.config.ts` aliases**: removed `@mariozechner/pi-*` entries; updated stub path targets to `./shared/types/earendil-works/index`
  - **`shared/types/mariozechner/` → `shared/types/earendil-works/`**: stub directory renamed, `declare module` names updated, `shared/types/package.json` `main` and `files` fields updated
  - **Monorepo cross-package references**: `extensions/ask-user` (`@zhushanwen/pi-subagent-workflow`) and `extensions/subagent-workflow` (`@zhushanwen/pi-structured-output`) switched from `*` to `workspace:*` so local development uses the just-edited sources instead of pulling deprecated versions from npm
  - **`pnpm.allowedDeprecatedVersions.node-domexception = "1.0.0"`**: silences the remaining unavoidable transitive deprecation (`@earendil-works/pi-ai` → `@google/genai` → `google-auth-library` → `gaxios@7` → `node-fetch@3` → `node-domexception`); `node-domexception` is a Node 22+ redundant polyfill, not a functional issue

  **No functional changes** to extension behavior, types, or APIs. `pnpm install`, `pnpm -r typecheck`, and `pnpm -r test` all pass cleanly with zero deprecation warnings.

  **Follow-up hardening (no functional impact):**

  - **`.githooks/validate-no-mariozechner-pi`** (new): standalone grep-based scanner that errors when `@mariozechner/pi-` appears in staged files or in workspace path checks. Can also be called manually for ad-hoc audits (`bash .githooks/validate-no-mariozechner-pi [<files>]`).
  - **`.githooks/pre-commit`** (`-0.` namespace check): wired `validate-no-mariozechner-pi` as a pre-manifest gate. Any staged file in `extensions/` or `shared/` (including `package.json`, `vitest.config.ts`, `.d.ts`) containing the deprecated namespace blocks the commit. `SKIP_NAMESPACE_CHECK=1` hotfix bypass must be justified in the PR description and tracked with an issue.
  - **`.githooks/pre-commit`** (`0b` peerDep check): the package.json deep check now requires `@earendil-works/pi-coding-agent` and explicitly rejects `@mariozechner/pi-coding-agent` (was incorrectly accepting the deprecated name as the success signal).
  - **AGENTS.md** new section "禁止使用已废弃的 Pi SDK namespace [MANDATORY]": documents the namespace rule, the gate script location, and what to do if Pi renames the namespace again.
  - **docs/standards.md / docs/monorepo-conventions.md / docs/quality-gates.md**: updated example `package.json`, import snippets, and `peerDependencies` descriptions to use `@earendil-works/pi-*`. Old historical docs (`docs/evolution/`, `docs/third-party-extensions/`, `docs/research/`) retain the deprecated references as factual record of past investigations.
  - **Bonus fix**: `pre-commit` had a latent bash bug `${#TEST_PKGS[@]:-}` (not a valid parameter expansion). Fixed to `${#TEST_PKGS[@]}` while validating the new gate.

## 0.1.2

### Patch Changes

- 7f72ac0: `tool_execution_end` error handler now extracts and persists the underlying
  error text.

  ## Behavior changes

  - **New `errorText` field** on the `unified-hooks:tool-error` session entry:
    `string | null`. Previously only `toolName` + `toolCallId` were stored; the
    real cause (e.g. `"hub disposed"`) was lost. Consumers reading the entry
    stream must tolerate the added field (it is additive — old readers ignore it).
  - **Notify message format change**: the warning shown via `ctx.ui.notify` now
    appends `: <errorText>` when extractable. Any consumer matching the exact
    notify string will no longer match. The `[unified-hooks] <toolName> error
(callId=...)` prefix is unchanged.

## 0.1.1

### Patch Changes

- 6cf4c58: 新增 `@zhushanwen/pi-subagents` 包（首次发布，v0.0.1）：进程内 subagent 执行运行时——agent 发现、5 级 fallback 模型解析、并发池（concurrency-pool）、background 任务、execution-record 状态机、turn-limiter、event-bridge（SDK 事件翻译）。提供 `subagent` tool + `/subagents` command。注意：`@zhushanwen/pi-workflow` 当前**不依赖**此包（workflow 仍用 spawn 子进程架构），两者独立——subagents 是独立可用的 subagent 执行运行时。

  ### `@zhushanwen/pi-workflow`（局部行为变更）

  workflow 仍为 spawn 子进程架构（`AgentPool` / `resolveAgentOpts` 不变），orchestrator.ts 做了内部重构（精简 ~200 行，行为等价，已由 orchestrator-stale 等测试覆盖）。两项局部行为变更：

  - **scene→model 解析移除**：`resolveModel` 不再经 `@zhushanwen/pi-model-switch` 的 `resolveModelForScene()` 解析 scene，改为直传调用方显式 `opts.model`。配套移除 peerDependency `@zhushanwen/pi-model-switch`。原依赖 model-switch scene 配置的用户升级后该解析静默失效——如需 scene→model 映射，请直接在 workflow 脚本的 `agent()` 调用中显式传 `model`，或在调用方自行解析。
  - **完成通知唤醒 parent**：workflow 完成时，`sendCompletionNotification` 现以 `{ triggerTurn: true, deliverAs: "steer" }` 注入消息流，唤醒 parent agent 处理结果（默认开启）。此前仅 `display:true` 只渲染不唤醒。无需安装 subagents。

  ### `@zhushanwen/pi-model-switch`（public API 未变，内部清理）

  - **public API unchanged; internal cleanup only**：包入口（顶层 `index.ts`）仍 re-export `resolveModelForScene`（直接从 `./src/advisor.ts`），`import { resolveModelForScene } from "@zhushanwen/pi-model-switch"` 行为不变，下游无需迁移。本次仅清理内部冗余/死代码：移除 `src/index.ts` 尾部那行重复 re-export（顶层已直接从 advisor.ts 导出）、将 `src/setup.ts` 的 `writePolicyConfig`、`src/types.ts` 的 `extractModelCapabilities`/`ModelCapability`、`src/advisor.ts` 的 `parseZaiResetTime` 由 `export` 改为模块内私有（均未从包入口导出，属 `src/*` 子路径非公开 API）。新增 vitest devDep + `test` script + `vitest.config.ts` 测试基础设施。

  ### `@zhushanwen/pi-unified-hooks`

  - `session_start` 钩子状态由 `console.warn` 改为 `ctx.ui.notify`（走通知区，不污染 TUI input 区）+ `appendEntry` 持久化。
  - 新增导出 `HookContext` 类型。

  ### `@zhushanwen/pi-taste-lint`

  - 新增 `no-unsafe-cast` 规则（检测 `as any` / `as unknown as T` / `as never`）。
  - `@typescript-eslint/no-explicit-any` 由 `warn` 收紧为 `error`。

## 0.1.0

### Minor Changes

- Add subagent-list-injector hook to inject available subagent list into system prompt

## 0.0.5

### Patch Changes

- 5c35364: fix: replace console.log/info with console.warn to prevent input area leak

  - model-switch/advisor.ts: replace console.info with silent fallback
  - unified-hooks/tool-error-handler.ts: replace console.log with console.warn
  - unified-hooks/index.ts: replace console.log with console.warn
  - Add §10 logging standard to pi-extension-standards.md
  - Add pre-commit hook to detect console.log/info violations

## 0.0.4

### Patch Changes

- Audit and fix all 11 extensions against project specifications

## 0.0.3

### Patch Changes

- 4de6d3a: i18n adaptation: replace all hardcoded Chinese strings with English across 7 extensions
