# xyz-agent AGENTS.md

Electron + Vue 3 + Node.js Runtime 的 AI Agent 桌面工作台。架构分层：

- **Electron 主进程** (`apps/electron/main/`)：窗口管理、runtime 子进程生命周期、快捷键
- **Preload** (`apps/electron/preload/`)：安全桥接，暴露 `electronAPI`
- **渲染进程** (`packages/renderer/src/`)：Vue 3 + TS + Pinia + Tailwind v3 + xyz-ui（太极纯灰设计系统）
- **Runtime** (`packages/runtime/src/`)：Node.js WebSocket 服务（transport/services/infra 三层），子进程 RPC 与 pi 通信
- **共享类型** (`packages/shared/src/`)

## 文档索引

| 主题 | 文档 |
|------|------|
| 完整编码规范 / UI 设计演变 / 术语表 | [docs/standards.md](docs/standards.md) · [design-evolution.md](docs/design-evolution.md) · [architecture/context.md](docs/architecture/context.md) |
| 设计系统（tokens / 原语层 / v6 SSOT / 视觉规格） | [docs/page-design/](docs/page-design/)（design-tokens.md · design-system.md · v6-master-spec.md · v6-spec-*.html；能力设计 spec 在 `archive/v3/`。禁止创建 `demos/`、`impeccable/` 目录） |
| 窗口顶部 traffic light 布局数值 SSOT | [traffic-light-layout.md](docs/page-design/traffic-light-layout.md)（v3 刻意调整形态，不遵循 v6 demo） |
| Renderer 终态包拓扑（现行 SSOT）/ 七层目标概念与 v6 重构（历史） | [architecture/renderer-rebuild-architecture.md](docs/architecture/renderer-rebuild-architecture.md)（现行 SSOT：§3 包拓扑 / §4 core 分层）· 历史：[renderer-target-architecture.md](docs/architecture/renderer-target-architecture.md)（七层目标概念，已 supersede）· [v6-architecture-refactor.md](docs/architecture/v6-architecture-refactor.md)（已 supersede） |
| 功能开发地图（启动新 Phase 前更新） | [docs/feature-map/](docs/feature-map/)（最新 2026-06-20.md） |
| 测试策略 SSOT | [TEST-STRATEGY.md](TEST-STRATEGY.md) + [docs/testing/](docs/testing/)（00 总览入口；testid 清单/调用链/已知坑） |
| 问题排查（日志/诊断/常见问题/历史排查规则） | [docs/troubleshooting.md](docs/troubleshooting.md) |
| Pi Extension 开发 | [docs/extensions/development-guide.md](docs/extensions/development-guide.md)（指南）· [extension-conventions.md](docs/extensions/extension-conventions.md)（强约束）· [glossary.md](docs/extensions/glossary.md) · [local-dev-guide.md](docs/extensions/local-dev-guide.md) |
| 待执行架构任务 | [docs/todo/remote-use-merge-architecture.md](docs/todo/remote-use-merge-architecture.md)（合并 remote-use 后删除） |

**外部依赖 pi**：[badlogic/pi-mono](https://github.com/badlogic/pi-mono) 上游（npm `@earendil-works/pi-coding-agent@0.84.1`，曾用 fork xyz-pi 已切回）。**[MANDATORY] 不修改 pi 源码、不提 PR、不 fork**——pi 没有的能力由 xyz-agent 自实现。**pi 语义断言的权威源 = node_modules 实装版**（断言前 `npm ls @earendil-works/pi-coding-agent` 核对版本，以 dist 编译 JS 为准）；clone `~/Code/git-fork/pi-mono-workspace/main/packages/`（coding-agent/src 核心逻辑、ai/src/providers provider 层）仅作可读 TS 参照，引用前须核对 clone 版本与实装一致（clone 领先/落后实装均属常态——曾因按 0.80.3 clone 断言 0.84.1 行为连产 4 条漂移 bug，审计 C #6）。不靠网络搜索。

**Pi Extension 源码（本项目维护）**：`extensions/` 下 14 个 `@zhushanwen/pi-*` 包 + `extensions/shared/` 共享库（quota-providers / llm-shared / extension-logger / file-lock），统一在本仓开发发布（旧仓 xyz-pi-extensions-workspace 已废弃，以本仓为准）。全集：ask-user / cw-tool / goal / model-switch / pending-notifications / permission / plan / rename-session / session-reader / scheduler / structured-output / subagent-workflow / todo / unified-hooks（新增/删包时更新此列举）。校验：`pnpm extensions:typecheck` / `extensions:lint` / `extensions:test`。

- **[MANDATORY] extension 改动优先在本地 pi CLI 实测**（不是 xyz-agent 桌面）：`pi --mode rpc --session-dir <dir> --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve --extension <path>` + stdin JSONL 发 prompt；`XYZ_AGENT_DEBUG=1` 看 `~/.pi/agent/logs/` 扩展日志。xyz-agent 的 builtin 打包/数据隔离/runtime 中转层会掩盖版本差异
- **structured-output 方案 A [HISTORICAL]**：workflow 模式 `PI_WORKFLOW_SCHEMA` 注入的权威 schema 是唯一校验权威，LLM 自报 schema 不参与校验（曾因校验自报 schema 致修复静默丢失）
- 本地开发调试（live edit ↔ npm 版切换）：`.agents/skills/dev-link/`
- **Review 工作流**：`pr-cr-fix` skill 是 PR 完整生命周期入口（开 PR → 8 维 review → 修 must-fix → pre-merge → push；review agent 内化在 `pr-cr-fix/agents/`，不全局暴露）

## 常用命令

```bash
pnpm run dev          # 开发模式 (Electron + Vite HMR)
pnpm run build        # 生产构建 (electron-builder)
pnpm run lint         # ESLint 检查
pnpm install          # workspace 单步安装（根 + packages/* + apps/*，ELECTRON_SKIP_BINARY_DOWNLOAD=1）
pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test   # extensions/ 三连
bash scripts/validate-runtime-bundle.sh    # runtime bundle 深度验证
```

## 前端调试（Playwright 连 dev app）

`pnpm dev` 后 Electron 开 `--remote-debugging-port=9222`，用 browser-automation skill 连 `http://localhost:9222`（截图/DOM/执行 JS，不抢焦点）。

- 多实例坑：打包版太极.app 可能同跑（占 3210）；dev renderer 在 9222、runtime 在 3310。连错看到旧代码——先确认 `list-pages` URL 是 `localhost:1420`
- runtime 改动不热重载（tsx 非 watch）：改 runtime 源码必须重启 `pnpm dev`；renderer 走 vite HMR

## 关键规则（违反必出 bug）

**runtime ↔ 前端编码核心**：

1. **emit 只传单个 payload 对象**：`emit('event', { arg1, arg2 })`，禁止多参数
2. **Event bus listener 防重复注册**：组件可能多实例（split mode），listener 用模块级 refCount 保护
3. **错误必须重置 isGenerating + streamingMessage**：错误作为 assistant 消息插入聊天流，不用顶部 banner
4. **外部系统对接先验证再编码**：对接 pi RPC 等先写独立验证脚本确认字段格式，用完归档移除
5. **pi 适配层不信任外部格式**：EventAdapter / session-pool 是 pi 协议唯一适配点；`sendCommand` 必须检查 `success`
6. **pi session 文件延迟写入**：首条 assistant 消息前文件可能不存在，读取代码必须处理；**[HISTORICAL] 禁止任何代码在 pi 首次 flush 前创建/触碰 session 文件**（EEXIST → session 永久卡死；活跃 session 靠 `SessionScanner.listAll()` 合并内存 Map 显示）
7. **Session 隔离：所有 runtime → 前端消息必须带 `sessionId`**，缺失的消息应被前端忽略（三层：ChatStore Map 分区 / useChat 路由 / PaneSessionView 过滤；`sendError` 必须传 sessionId）
8. **per-session 状态隔离范式 [ADR-0049]**：持有 per-session 状态的 composable 必须用 `useSessionScopedState` 工厂（Map 分区范式），禁止实例级状态 / watch(sessionId) 手动清空。**WS handler 必须用 `updateFor(capturedSid)` 不用 `update`**（结构性消除切 session 竞态）；cleanup 由 `useSidebar.deleteSession` 统一编排。新增/修改 composable 时 reviewer 按 [ADR-0049 Checklist](docs/adr/0049-session-isolation-map-partition.md#code-review-checklist范式守护替代-eslint-规则) 逐条确认
9. **对话流状态必须实时可见 + 重开 session 仍可见 [HISTORICAL]**：实时链路（message.* 广播 + chat-message-effects）与持久化链路（RPC 路径 converter 不丢弃任何 pi entry 类型 / 文件路径 JSONL filter 不只留 message）两条通路必须同时实现。命令副作用归 `message-dispatcher.ts` 编排，不散落 event-adapter。检测：操作后关闭重开 session，对话流应一致

**workspace / git**：

10. **Worktree 创建必须走 `git-cwt`**（自动 pnpm install + Electron dist 缓存 symlink）；Vite `strictPort: true`，1420 被占则静默失败加载旧代码——`lsof -i :1420 -P` 确认端口归属
11. **Bare repo 模式**：`origin` = 本地 `.bare`，GitHub remote 叫 `github`（push 用 `git push github HEAD:fix-xxx`）；workspace root 不是 git repo，`gh` 命令带 `--repo zhushanwen321/xyz-agent`；merge 脚本无 main worktree 时用 `git --git-dir` 指向 `.bare`，版本 bump push 用 `HEAD:refs/heads/main`

**架构机制**：

12. **Electron 打包约束（事故最高发）**：① runtime 源码禁止 `import.meta.url` / `globalThis.__dirname`（CJS bundle 下失效），路径用 `typeof __dirname !== 'undefined' ? __dirname : undefined`；② 新增 runtime 依赖必须同步加 `tsup.config.ts` 的 `noExternal`；③ 打包子系统改动逐个 commit 逐个验证。细节核对见 `pr-cr-fix/agents/review-electron-build.md`；验证三阶段（preflight → build → postbuild）+ validate-runtime-bundle 由脚本自动化
13. **目录规范**：禁止 `demos/` / `impeccable/` 目录；禁止外部绝对路径 symlink（pre-commit 检查）；`.xyz-harness/` 必须提交不可删除（决策追溯）；`DESIGN.md` 保留作历史参考（已 DEPRECATED by ADR-0019）
14. **项目 skill 必须自包含 [HISTORICAL]**：`.agents/skills/` 引用的脚本复制到 skill 目录内随 git 跟踪（`merge/scripts/` 已自包含），禁止依赖 `~/.agents/skills/` 全局脚本或 symlink
15. **排查规则（untracked 展开 `-uall` / 禁止写死绝对路径用 `getDataDir()` 等动态推导 / 跨层机制穷尽 pi extension 层）**：详见 [docs/troubleshooting.md](docs/troubleshooting.md) 的「历史排查规则」

**Plugin / Builtin extensions**：

16. **Plugin System**：PluginService 是唯一适配层（WS → server.ts → PluginService）；trusted 插件跑 Worker Thread、sandbox 跑独立 fork 子进程；hook 按 priority 串行（单 handler 5s 超时放行）；sessionData 写入 debounce 缓存 + shutdown flushAll；WS 命名 Client→Server 点号（`plugin.xxx`）/ Server→Client 冒号 camelCase（`plugin:statusBarUpdate`）
17. **Builtin pi-extensions 打包内置（现行）**：10 个 `@zhushanwen/pi-*` 包 esbuild bundle 后 staged 到 `apps/electron/resources/extensions/` 随应用打包（不走 npm 安装）。清单 SSOT = `packages/shared/src/mandatory-extensions.json`（infrastructure 3 包不可禁、feature 7 包可禁、都不可卸；守卫抛 `builtin_cannot_*`）。[HISTORICAL] 演化：builtin 依赖 → 推荐安装 → mandatory npm → 打包内置（2026-08-12）；「删除打包所需依赖致产物缺失」教训始终适用（pi binary、xyz-system-prompt-extension.js 同理）

## 测试

**先读 [TEST-STRATEGY.md](TEST-STRATEGY.md)（分层/mock/回归基线 SSOT）+ [docs/testing/](docs/testing/) 对应功能文档**，复用已有 testid/调用链/踩坑经验。红线：vitest（禁 `node:test` / `tsx --test`，配置在子包 vitest.config.ts，从子包目录运行）；timer 测试用 fake timers；派编码 subagent 时 task 写明测试框架。**三视角缺一不可 [HISTORICAL]**（构建者白盒 + 使用者黑盒 + 观察者形态；每条用例至少一个用户可见 DOM 断言；spec 结构条目 = 渲染断言清单）——细则见 TEST-STRATEGY.md §3。

## 前端编码规范

权威标准：`~/Code/xyz-ui/CONVENTIONS.md`。核心：

1. 禁止原生 HTML 表单元素（用 xyz-ui 组件）；禁止 Emoji（inline `<svg>` / @lucide/vue）
2. 样式三层：tokens（`style.css` 只放 CSS 变量 + reset）/ Tailwind 工具类（组件样式统一在此）/ `<style scoped>` 仅 escape hatch（伪元素、后代选择器、Transition 类）。禁止 `@apply`
3. `<template>` ≤ 400 行，`<script setup>` ≤ 300 行；禁止 `any`（断言须有运行时 guard，extensions/ 由 taste/no-unsafe-cast 强制）
4. `v-model`（禁 `:value` + `@input`）；独立数据源用 `Promise.allSettled`
5. 禁止硬编码颜色 / 魔数间距（用 CSS 变量与标准 Tailwind scale）
6. border-radius 遵循 v3 tokens（`--radius-sm:3px` 默认 / `--radius:8px` / `--radius-lg:12px`，ADR-0019）
7. **窗口顶部 traffic light 布局**：v3 刻意调整形态（非 v6 demo），全部数值（AppShell p-1 / pt-11 / {x:8,y:8} / h-[22px] 共线等）见 [traffic-light-layout.md](docs/page-design/traffic-light-layout.md)——改窗口顶部 UI 前必读
8. **reka ScrollAreaViewport 默认 `overflow-x: hidden` [HISTORICAL]**：横向滚动需给 `ScrollArea` 传 `horizontal` prop（`!overflow-x-auto` 覆盖内联；`:deep()` 会破坏 reka Root 渲染顺序）

自动化检查：taste-lint（no-native-html / no-emoji / prefer-v-model 等，`pnpm run lint` + pre-commit）· vue_rules_checker.py（行数/选择器/Tab/原生元素，pre-commit）。

**Lint / Hooks 原则 [MANDATORY]**：按全局 AGENTS.md「Pre-commit Hook 问题处理」执行——检出问题全部正面修复（含存量、含 warning），禁 `--no-verify` / `SKIP_*`（仅限线上热修复并说明）；规则误报修正规则本体并加 `[HISTORICAL]` 注释，禁 `eslint-disable-next-line` 静默。

**完成即提交 [MANDATORY]**：按全局「提交策略 → 完成即提交」；「检查未过」不构成不提交理由（先修复）。

## Git 规范

分支 `feat:`/`fix:`/`refactor:`/`chore:` 前缀；commit 英文 conventional 风格；粒度见全局提交策略（优先本次会话改动，文件级）。

## pi 资源放置

agent.md / workflow.js 归位：与 extension 强相关（tools 受限某 extension / 离开该 extension 不可用）→ `extensions/<pkg>/agents|workflows/` + package.json `pi.agents`/`pi.workflows`；项目自用 → `.agents/agents|workflows/`；跨项目通用 → `~/.agents/`。发现机制：resource-discovery 扫 7 源同名 last-writer-wins（project-agents 最高）；extension 内置 agent 须装到 npm 扫描目录才被发现（dev-link 不发现 agent）；skill 走 `pi.skills` 独立通路（first-writer-wins）。SSOT：`extensions/subagent-workflow/src/shared/resource-discovery.ts`。

## 架构约定

- 视图切换状态驱动（settingsStore.currentView），不用 vue-router；Mock 用 `VITE_MOCK=true` 在 ws-client 层拦截
- 共享类型经 `packages/shared/` workspace 共享；Runtime 通信走 WebSocket（ws-client.ts + event-bus.ts）；Electron IPC 经 preload 暴露 `electronAPI`
- **Runtime broadcast 时序竞争 [HISTORICAL]**：session 激活/创建流程内部发出的 session 级 broadcast 早于 renderer 订阅 → 消息丢失。renderer 切换/创建 session 后需立即消费的 session 级状态必须主动拉取（`session.getCommands` RPC），不可依赖 broadcast
- **数据目录隔离**：`~/.xyz-agent/` 与 `~/.pi/agent/` 完全隔离；路径白名单禁止硬编码，从 `getConfigDir()` / `getPiAgentDir()` 动态推导（pre-commit 检查）
- **ENV_WHITELIST_PREFIXES SSOT**：只许定义在 `packages/shared/src/constants.ts`，main/runtime 只 import（pre-commit 检查）
- **Runtime/pi 日志必须落盘 + 轮转**（`<getDataDir>/logs/`，date + size 双策略，dev debug / prod info）；pi stdout tee 到 `pi-<date>-<sessionId>.jsonl`（pi 卡死时唯一证据）；新增日志库必须加 tsup `noExternal`
- **包管理器纪律 [HISTORICAL]**：pnpm workspace 单一管理器，`pnpm-lock.yaml` 唯一权威，通用纪律按全局 lock 规则。npm 例外（不要"统一"）：外部消费者安装指引 / `npm publish` / runtime 安装用户 extension / 规则正文描述被禁命令 / `npx`。标准：执行者是本项目开发者/CI/AI → pnpm；外部消费者/终端用户 → npm

## 发布与 CI 验证 [HISTORICAL]

两条独立管线：Electron 打包（`v*` tag → release.yml → `verify-ci-release.sh` 验证）与 npm 发布（`npm-*` tag → release-npm.yml）。npm 两条机制：main 稳定发布（人工定 type + `check-version-changes.sh` + `apply-version.sh`，merge skill 阶段 4N 封装，**禁止本地 `changeset publish`**，曾因 registry 最终一致性 E403）与 dev-npm 预发布（changeset pre，`scripts/npm-prerelease.sh`）。

- changeset 准则（PR 阶段）：type 是初判最终人工定；body 认真写（进 CHANGELOG）；dep 传播不在 PR 声明（merge 时自动闭包）
- **[MANDATORY] push tag 后必须验证 CI 产物**：push 发布 tag 后禁直接宣布完成，轮询 CI 验证产物直到脚本 exit 0（预发布 `prerelease-test.sh` 内置 / 正式 `bash scripts/verify-ci-release.sh v<version>`）。exit 非 0 修到 0，禁说「应该没问题」
- **[MANDATORY] Release Notes 中英双语**：`<!-- LANG:en -->` 在前 `<!-- LANG:zh -->` 在后，标记独占一行，无标记旧 release 向后兼容

## 跳过检查

cw testRunner 的 monorepo 坑已修复（wave design 填 `plan.testCwd: "<子包目录>"`，gate 数字与本地一致）[HISTORICAL]。默认禁止跳过检查；`SKIP_*` 变量（SKIP_ALL_CHECKS / SKIP_FRONTEND_LINT / SKIP_EXTENSION_LINT / SKIP_CODE_RULES_CHECK / SKIP_ENV_WHITELIST_CHECK / SKIP_PATH_WHITELIST_CHECK / SKIP_DIRECTORY_RULES_CHECK / SKIP_TOOL_SCHEMA_CHECK）仅限线上热修复且须 commit message 说明原因。
