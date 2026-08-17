# xyz-agent AGENTS.md

## 项目概述

xyz-agent 是基于 Electron + Vue 3 + Node.js Runtime 的 AI Agent 桌面工作台。架构：

- **Electron 主进程** (`apps/electron/main/`): 窗口管理、runtime 子进程生命周期、快捷键
- **Preload** (`apps/electron/preload/`): 安全桥接，暴露 `electronAPI` 给渲染进程
- **前端渲染进程** (`packages/renderer/src/`): Vue 3 + TypeScript + Pinia + Tailwind CSS v3 + xyz-ui 组件库（v3 冷蓝暗色设计系统）
- **Runtime** (`packages/runtime/src/`): Node.js WebSocket 服务（三层架构 transport/services/infra），通过子进程 RPC 与 pi 通信
- **共享类型** (`packages/shared/src/`): 前端与 runtime 之间的 TypeScript 类型定义

**完整编码规范**: [docs/standards.md](docs/standards.md)

**功能开发地图**: [docs/feature-map/](docs/feature-map/) — 长期功能规划、现状盘点、待开发阶段、关键决策点、完整资料链接
  - 每次启动新 Phase 前更新地图，确认当前阶段和优先级
  - 构建能力地图和架构图时，从该目录获取全貌
  - 最新版本: [2026-06-20.md](docs/feature-map/2026-06-20.md)（v3 重建后）；旧版 [2026-05-19.md](docs/feature-map/2026-05-19.md) 保留作重构前状态快照

**规范与设计文档**:
- [完整编码规范](docs/standards.md) — 组件使用、样式规则、TypeScript 约束
- [UI 设计演变史](docs/design-evolution.md) — Warm&Soft → v3 → v6 → 太极纯灰的完整演变叙事
- [设计 Tokens（太极 V3 SSOT）](docs/page-design/design-tokens.md) — 纯灰暗色原子值（色/字/距/影/动效），ADR-0019 确立
- [设计系统原语层](docs/page-design/design-system.md) — 组件原语如何使用 tokens
- [v6 单一权威源](docs/page-design/v6-master-spec.md) — 决策与范式（整合自 28 份过程文档 + demo，D1-D14 裁决）
- [v6 视觉规格](docs/page-design/v6-spec-shell.html) — 逐组件验收基准（15 个 v6-spec-*.html）
- [领域术语表](docs/architecture/context.md) — Session/Panel/Runtime/v3 UI 结构术语
- [UI/UX 设计原则与参考](docs/page-design/ui-design-principles.md) — 设计方法论 + 竞品案例 + 行动清单

**前端架构文档**:
- [Renderer 目标架构（七层）](docs/architecture/renderer-target-architecture.md) — Shell/Workspace/Feature/ExtensionHost/RenderingProtocol/Transport&Coordination/Foundation 七层 + 层归属规则表 + 依赖铁律
- [v6 架构重构](docs/architecture/v6-architecture-refactor.md) — 现状审查 + 落地改动（阶段 0/A/B/C，B1-B9）

**待执行架构任务**（`docs/todo/`）:
- [远程化合并架构指引](docs/todo/remote-use-merge-architecture.md) — `feat-remote-use`（86 commits）合并进 main 时的 T&C 层归位清单 + routeInbound 合并设计 + sync 兼容纪律。**合并 remote-use 之后删除此文档**

**页面设计目录**: `docs/page-design/` — 前端设计 SSOT 与设计稿。结构：`design-tokens.md`（原子 SSOT）+ `design-system.md`（原语层）+ `v6-master-spec.md`（v6 单一权威源）+ `v6-spec-*.html`（视觉规格）+ `archive/v3/`（能力设计 spec：fast-*/flow-*/coding-plan-quota 等活跃功能设计）。禁止在项目根目录或其他位置创建 `demos/`、`impeccable/` 等目录

**外部项目源码**:
- **pi**: [badlogic/pi-mono](https://github.com/badlogic/pi-mono) — AI coding agent CLI，xyz-agent 通过子进程 RPC 调用。session tree / fork / clone 核心能力为 pi 原生，xyz-agent 不依赖任何 fork 特有改动
  - npm 包: `@earendil-works/pi-coding-agent`
  - 当前版本: `0.84.1`（devDependency 提供 extensions 开发期类型；打包的 pi binary 见 `resources/pi/`）
  - 历史背景：此前使用 fork `zhushanwen321/pi`（包名 `xyz-pi`），fork 唯一改动是在 `get_state` RPC 响应中透出 `leafId` 字段。该字段在 xyz-agent 前端从未消费，2026-07 已切回上游；leafId 现直接取自上游 `get_entries` RPC 响应的 `data.leafId` 字段（runtime 历史增量缓存用作 since 基准，见 `session-service.ts` getHistory），无 JSONL session 文件解析代码（旧说法「从 JSONL 解析近似值」与代码不符，已勘误）
  - Skill 加载: `packages/coding-agent/src/core/skills.ts`
  - Skill 展开: `packages/coding-agent/src/core/agent-session.ts` — `_expandSkillCommand()`
  - Slash 命令: `packages/coding-agent/src/core/slash-commands.ts`
  - RPC 协议: `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
  - TUI 交互: `packages/coding-agent/src/modes/interactive/interactive-mode.ts`

**Pi Extension 源码（本项目维护）**:
- `extensions/` 目录下 14 个 `@zhushanwen/pi-*` extension 包 + `extensions/shared/` 下共享库（quota-providers / llm-shared / extension-logger），由本项目继续发布到 npm（main 线走 `npm-*` tag 人工版本判定，dev-npm 预发布走 changeset version）。完整清单见下方「Pi Extension 全集」
- **[HISTORICAL] xyz-pi-extensions-workspace 已废弃**：原独立仓库 `~/Code/xyz-pi-extensions-workspace` 已停止维护，本仓 `extensions/` 是 `@zhushanwen/pi-*` 的**统一开发仓库**。所有 extension 的源码改动、bug 修复、版本发布都在本仓进行，不再回写到旧仓。旧仓的 `main` 分支可能滞后于本仓，排查问题时以本仓为准
- **structured-output 方案 A（权威 schema 校验）[HISTORICAL]**：workflow 模式下 `PI_WORKFLOW_SCHEMA` env 注入的权威 schema 是唯一校验权威，LLM 传入的 `schema` 参数不参与校验（仅错误回显）。2026-08-01 事故：ds-flash 重写 `add_channels.items` schema 后自洽通过，4 条 channel 修复静默丢失。根因是旧实现校验 LLM 自报 schema 而非权威 schema。修复见 `extensions/structured-output/src/index.ts` 的 `executeStructuredOutput` authoritativeSchema 分支
- **Extension 开发规范**: [docs/extensions/development-guide.md](docs/extensions/development-guide.md)（完整指南）、[docs/extensions/extension-conventions.md](docs/extensions/extension-conventions.md)（强约束）、[docs/extensions/glossary.md](docs/extensions/glossary.md)（术语表）
- 类型检查: `pnpm extensions:typecheck`；Lint: `pnpm extensions:lint`；测试: `pnpm extensions:test`
- **本地开发调试**: `.agents/skills/dev-link/` 管理 `XYZ_EXTENSION_PATHS` 环境变量，在本地源码（live edit）和 npm 版本间切换 extension。`link-local.sh <pkg>` 添加 link → `set -a && source .env.dev-extensions && set +a && pnpm dev` 启动 → 改源码后新建 session 即生效。详见 [本地开发指南](docs/extensions/local-dev-guide.md)
- **[MANDATORY] pi extension 测试优先在本地 pi 实测，不优先在 xyz-agent 验证**：`extensions/` 下 `@zhushanwen/pi-*` 扩展的改动，功能验证优先在**本地 pi CLI 环境**实测（RPC mode + 真实模型跑最小场景，检查 session 文件 / `XYZ_AGENT_DEBUG=1` 扩展日志），而不是优先在 xyz-agent 桌面应用中验证。原因：xyz-agent 有 mandatory 打包内置机制、数据目录隔离、runtime 中转等额外层，会掩盖或引入版本差异（2026-08-10 事故：嵌套 subagent keep-alive 拦截在本地 pi 7.0.1 实测正常，但用户 xyz-agent 环境滞留 dev 旧版 5.0.0-dev.1 导致拦截缺失）；pi CLI 是最接近扩展真实运行环境的验证场，子进程扩展加载（`mirrorMainProcessFlags` 镜像主进程 `--extension`）行为与 xyz-agent 一致。实测方法：`pi --mode rpc --session-dir <dir> --model <m> --approve --extension <ext-path>` + stdin JSONL 发 `prompt` 命令，配合 `XYZ_AGENT_DEBUG=1` 看 `~/.pi/agent/logs/` 扩展日志、检查子进程 session 文件（`~/.pi/agent/subagents/<enc>/sessions/`）的 `pending:register`/`pending:unregister` 差集。测试模型用 `xiaomi-token-plan-cn/mimo-v2.5-pro`（禁止用 kimi 模型做测试）
- **Review 工作流**: `.agents/skills/pr-cr-fix/` 是 PR 完整生命周期 skill（开 PR → 多维 review → 修 must-fix → pre-merge → push，内化原 pull-request / code-review / pre-push-checks / trim-cot-leakage 四个 skill）。review agent 定义内化在 `.agents/skills/pr-cr-fix/agents/` 下（7 维审查 + 1 聚合器，不全局暴露）。维度覆盖：arch-boundary / business-logic / electron-build / extension-api / monorepo-impact / test-coverage / type-safety。触发词："review 完开 PR"、"pr-cr-fix"、"review"、"提交 PR"、"push 前检查"。仅用于 xyz-agent worktree 的 PR 场景

**Pi Extension 全集**（`extensions/` 下 14 个 `@zhushanwen/pi-*` 包 + `extensions/shared/` 下共享库；新增/删包时同步更新此表）：

| npm 包名 | 目录 | 用途 |
|---|---|---|
| `@zhushanwen/pi-ask-user` | `ask-user` | 结构化多问题输入工具（单/多问，分栏预览 + 内联编辑） |
| `@zhushanwen/pi-cw-tool` | `cw-tool` | cw CLI 的 role 工具封装（cw_planning/wave/dev/review）+ 5 个编排 agent + pi-cw skill，硬约束层主不自审 |
| `@zhushanwen/pi-goal` | `goal` | Codex 风格 /goal 命令（持久目标驱动自治循环，证据验收） |
| `@zhushanwen/pi-model-switch` | `model-switch` | 智能模型推荐与切换 |
| `@zhushanwen/pi-pending-notifications` | `pending-notifications` | 跨扩展异步操作注册/查询（长任务期间防消息注入） |
| `@zhushanwen/pi-permission` | `permission` | 四档权限模式（yolo/auto/approve/strict）+ 三层管道（AST + 规则 + AI 分类） |
| `@zhushanwen/pi-plan` | `plan` | 轻量 plan 模式 |
| `@zhushanwen/pi-rename-session` | `rename-session` | session 自动/手动重命名 |
| `@zhushanwen/pi-session-reader` | `session-reader` | 读取/查询 pi session 历史（find/family/outline/expand/detail/search/export/extract/workflow 动作） |
| `@zhushanwen/pi-scheduler` | `scheduler` | 定时任务调度（cron / interval，once / recurring） |
| `@zhushanwen/pi-structured-output` | `structured-output` | 结构化输出（JSON Schema + Ajv 校验的 tool call 机制） |
| `@zhushanwen/pi-subagent-workflow` | `subagent-workflow` | 统一 subagent 执行 + 多 agent workflow 编排（有状态工作流管理） |
| `@zhushanwen/pi-todo` | `todo` | AI 驱动的 todo 列表（会话持久化 + /todos） |
| `@zhushanwen/pi-unified-hooks` | `unified-hooks` | 统一 hooks 收集（散落 hook 集中维护） |

**Settings 模块设计文档**:
- [Settings spec](.xyz-harness/2026-05-12-settings-redesign/spec.md) — 需求规格（WS 协议、数据流、组件结构）
- [Settings plan](.xyz-harness/2026-05-12-settings-redesign/plan.md) — 实现计划（12 个 Task）

## 常用命令

```bash
pnpm run dev          # 开发模式 (Electron + Vite HMR)
pnpm run build        # 生产构建 (electron-builder)
pnpm run lint         # ESLint 检查
pnpm run prepare      # 安装 git hooks

# 打包流程（pnpm workspace 单步安装，无需 cd 子目录）
pnpm install          # 安装所有依赖（根 + packages/* + apps/*，ELECTRON_SKIP_BINARY_DOWNLOAD=1 跳过二进制下载）
bash scripts/preflight-check.sh   # 打包前检查
pnpm build                             # 构建 DMG/ZIP/EXE
bash scripts/postbuild-validate.sh         # 打包后验证

# 单独验证 runtime bundle
bash scripts/validate-runtime-bundle.sh

# Pi Extension 开发（extensions/ 目录）
pnpm extensions:typecheck   # 全量 tsc 类型检查
pnpm extensions:lint        # ESLint（extensions/ override 规则）
pnpm extensions:test        # 全部 extension 包 vitest 测试
```

## 前端调试（Playwright 连 dev app）

`pnpm dev` 启动后，Electron 开 `--remote-debugging-port=9222`。用 browser-automation skill 的 Playwright 脚本连接，可截图/DOM 快照/点击/填表/执行 JS，**不抢焦点**（连接已有进程，非新开）。

```bash
PW="/Users/zhushanwen/.agents/skills/browser-automation/scripts/pw.js"
EP="http://localhost:9222"

# 确认 dev app 在 9222（dev Electron 的 renderer）
lsof -i :9222 2>/dev/null
node $PW $EP list-pages

# 截图
node $PW $EP screenshot -o /tmp/debug.png

# DOM 快照（可交互元素）
node $PW $EP snapshot

# 执行 JS（查状态/读 DOM）
node $PW $EP evaluate "document.querySelector('[data-testid=chip-branch]')?.textContent"

# 点击/填表
node $PW $EP click "[data-testid=chip-branch]"
node $PW $EP fill "input[name=x]" "value"
```

**注意多个 xyz-agent 实例**：打包版 `/Applications/太极.app` 也可能同时在跑（占 3210 端口）。dev 实例的 renderer 在 9222、runtime 在 3310（tsx 跑 `packages/runtime/src/index.ts`）。连错实例会看到旧代码——先确认 `list-pages` 的 URL 是 `localhost:1420`（vite dev server）。

**runtime 代码改动不热重载**：dev runtime 用 `tsx`（非 `tsx watch`）运行，改 runtime 源码后**必须重启 dev**（`pnpm dev` 重跑）才生效。renderer 走 vite HMR 自动热重载。

完整命令参考：[browser-automation skill](file:///Users/zhushanwen/.agents/skills/browser-automation/SKILL.md)

## 关键规则（违反必出 bug）

### 1. emit 只传单个 payload 对象
禁止 `emit('event', arg1, arg2)` — handler 极易混淆参数顺序。必须 `emit('event', { arg1, arg2 })`。

### 2. Event bus listener 防重复注册
组件可能多实例（split mode），listener 必须用模块级 refCount 保护，否则事件处理翻倍。

### 3. 错误必须重置 isGenerating + streamingMessage
任何错误路径都必须重置状态，否则 UI 卡死在「思考中」。错误作为 assistant 消息插入聊天流，不用顶部 banner。

### 4. 外部系统对接先验证再编码
对接 pi RPC 等外部系统时，先写独立验证脚本（如 `verify-<system>.cjs`，放项目根或临时位置），确认字段名和格式后再写业务代码。验证使命完成后脚本即归档/移除，不长期保留。

### 5. pi 适配层不信任外部格式
EventAdapter 和 session-pool 是 pi 协议的唯一适配点。业务代码不直接处理 pi 格式。`sendCommand` 必须检查 `success` 字段。

### 6. pi session 文件延迟写入

pi 的 `SessionManager._persist()` 在收到第一个 **assistant** 消息之前不会写入 session 文件（延迟写入策略：所有 entry 缓存在内存，等 assistant 到达才 flush）。这意味着 `get_state` 返回的 `sessionFile` 路径对应的文件在首次 assistant 回复前**可能不存在**。

所有读取 session 文件的代码必须处理文件不存在的场景：
- `session-tree-reader.buildTreeFromFile()` → 文件不存在时返回空树
- `getHistoryFromFile()` → 文件不存在时返回空消息列表
- **禁止**假设 `get_state` 返回 `sessionFile` 后文件就已存在

**[HISTORICAL] 禁止提前创建 session 文件**：曾在 session 创建后立即 `openSync(filePath, 'wx')` 创建最小文件，与 pi 首次 flush 的 `openSync` 冲突（EEXIST）→ session 永久卡死。活跃 session 靠 `SessionScanner.listAll()` 合并内存 active session（`this.sessions` Map）显示，无需磁盘文件。**禁止任何代码在 pi 首次 flush 前创建/触碰 session 文件**。

### 7. Session 隔离：所有消息必须带 sessionId

所有 runtime → 前端的消息，如果涉及特定 session，`payload` 必须包含 `sessionId`。前端靠 `payload.sessionId` 路由到正确的 panel/store 分区。**缺失 `sessionId` 的消息应被忽略**，否则会广播到所有 panel。

三层隔离机制：

| 层 | 职责 | 位置 |
|---|---|---|
| ChatStore 分区 | `chatSessions: Map<sessionId, ChatSessionState>`，所有操作要求显式 sessionId | `stores/chat.ts` |
| useChat 全局路由 | 事件处理器从 `msg.payload.sessionId` 提取 sid，路由到 store 分区 | `composables/useChat.ts` |
| PaneSessionView 过滤 | 组件级事件监听（error、compacted 等）严格按 `props.sessionId` 过滤 | `PaneSessionView.vue` |

Runtime 侧：`server.ts` 的 `sendError` 必须传入 `sessionId`（外层 catch 从原始消息 `msg.payload.sessionId` 提取）。不带 `sessionId` 的 error 会被前端所有 panel 忽略。

### 7.6 per-session 状态隔离范式 [ADR-0049]

**所有持有 per-session 状态的 composable 必须用 `useSessionScopedState` 工厂（`composables/useSessionScopedState.ts`），统一采用 Map 分区派范式。** 禁止实例级状态 + watch(sessionId) 手动清空（脆弱模式）。

#### 范式定义

| 范式 | 含义 | 评价 |
|------|------|------|
| **Map 分区派（SSOT）** | 单例 composable 内部 `Map<sessionId, T>`，按 sid 查分区，切 sid 切分区 | ✅ 正确范式。天然隔离，切回恢复，不依赖人记得清空 |
| **实例级隔离（反模式）** | 每组件实例各自状态，靠组件树天然多实例隔离 | ❌ 脆弱。切 sid 时同一实例的状态没清就泄漏（useExtensionUI bug 即此模式失效） |
| **watch 清理派（反模式）** | 单实例状态 + `watch(sessionId)` 切换时手动清空 | ❌ 脆弱。依赖开发者记得清空**所有**字段，新加字段忘了清就泄漏 |

#### 三个术语区分

- **Map 分区**：单例 composable 内 `Map<sessionId, T>`，本次统一目标范式
- **实例级隔离**：每组件实例各自状态（靠组件树多实例）。useExtensionUI 旧实现
- **watch 清理派**：单实例状态 + watch(sessionId) 手动清空。SideDrawer/useComposerHistory 旧实现

#### useSessionScopedState 工厂用法

```ts
import { reactive } from 'vue'
import { useSessionScopedState } from '@/composables/useSessionScopedState'

// init 工厂必须返回 **reactive** 容器（plain object mutate 不触发下游 computed）
const state = useSessionScopedState(
  sessionIdRef,  // Ref<string|null>
  () => reactive({ count: 0, items: [] as string[] }),
)

state.current.value  // 当前 sid 分区（null sid 返回默认实例不写 Map）
state.update(s => { s.count++ })  // 操作当前 sid 分区（null sid no-op）。用于 UI 操作（用户主动操作当前 session）
state.updateFor(sid, s => { s.count++ })  // 显式指定分区，不读 sid.value 实时值。用于 WS handler（消息属于固定 sid）
state.cleanup(sid)  // 移除指定 sid 分区（手动调用，正常由 deleteSession 编排）
```

**WS handler 必须用 `updateFor` 不用 `update`**：WS handler 闭包捕获订阅时 sid，调 `updateFor(capturedSid, ...)`。即使 session 切换的退订是异步的（watch flush:pre），旧 sid 的迟到消息也只写旧 sid 分区，不污染新 sid（结构性消除竞态，M1 修复）。UI handler（用户主动操作）用 `update`（读实时 sid 正确）。useExtensionUI / SideDrawer 已遵守此契约。

#### session 销毁 → cleanup 自动触发

`useSidebar.deleteSession(id)` 是 session 销毁的唯一编排点（所有真正释放 per-session 分区的路径都经过它）。其内部调 `triggerSessionCleanups(id)`（与 `invalidateStatusCache(id)` 并列），遍历所有 `useSessionScopedState` 实例注册的 cleanup 函数，移除该 sid 的 Map 分区。**新 composable 用工厂后，无需手动挂钩 cleanup**——工厂在 setup 时自动注册，scope dispose 时反注册。

#### 例外（不需迁移）

- `useSessionEvents.ts`：订阅编排层，不持有 per-session 业务状态（registrations 是 handler 路由表，随实例销毁清）。不套 Map 分区。
- `useDetailPane` / `useFileTree` 等：已正确隔离（loadToken / 现有 Map 分区），不在本次重构范围。

详见 [ADR-0049](docs/adr/0049-session-isolation-map-partition.md)。

**Code Review 强制检查项**：新增/修改 composable 时，reviewer 必须按 ADR-0049 的 [Code Review Checklist](docs/adr/0049-session-isolation-map-partition.md#code-review-checklist范式守护替代-eslint-规则) 逐条确认（是否持有 per-session 状态 / 是否用工厂 / WS handler 是否 updateFor / cleanup 是否挂钩）。例外须在 ADR 例外清单登记审批。

### 7.5 对话流状态必须可重开恢复 [HISTORICAL]

**所有进入对话流的状态（消息、系统通知、压缩记录、工具结果等），必须同时满足两条：实时可见 + 重开 session 后仍可见。** 只做到实时可见、重开后消失的，视为未完成。

事故背景：compact 只打通实时链路，重开 session 后压缩记录消失。「实时链路」和「持久化链路」是两条独立通路，只打通一条 = 用户以为数据丢失。

两条通路必须同时维护：

| 通路 | 职责 | 关键检查点 |
|---|---|---|
| **实时链路**（事件/RPC 响应 → 前端消息流） | 操作发生时立即在对话流显示反馈 | runtime 广播 `message.*` 事件携带完整 payload；前端 `chat-message-effects.ts` 有对应 effect 处理 |
| **持久化链路**（session JSONL → 重开加载） | 重开 session 后历史完整呈现 | pi 写入 JSONL 的 entry 类型，runtime 读取时（`session-history.ts` 文件路径 / `message-converter.ts` RPC 路径）**都不能过滤掉**；前端 hydrate 能还原 |

持久化链路的两条读取路径都要覆盖（缺一会导致「在线重开能看到、离线重开看不到」或反之）：

1. **RPC 路径**（session 在线，有 pi 子进程）：`session-service.getHistory` → `client.getEntries()` → pi `get_entries` → `mapSessionEntries`（entry 树 → 伪消息，session-entry-mapper.ts）→ `convertPiHistory`（message-converter.ts，converter M1-M4 已改走 entry 树重建）。converter 必须处理所有 pi 返回的 message role（`user`/`assistant`/`toolResult`/`compactionSummary`/`branchSummary` 等），不能静默丢弃未知 role。
2. **文件路径**（session 离线，无 pi 子进程）：`session-history.ts` 的 `getHistoryFromFile` → 解析 JSONL。filter 不能只留 `type === 'message'`，pi 的顶层 entry 类型（`compaction`/`branch`/`bashExecution` 等）需按需放开并转换。

**新增任何进入对话流的状态时，必须同时实现两条通路**。只补实时广播、不改 converter/文件读取的，会在重开时丢失。检测方法：操作后关闭 session 再重开，对话流应与关闭前一致。

命令编排层（`message-dispatcher.ts`）是实时链路的归位点——主动发起的命令（如 compact）的副作用（生命周期广播 + summary 消息 + 关联状态刷新如 context 用量）都在 dispatcher 编排，不要分散到 event-adapter（event-adapter 只翻译 pi 推送的事件流，不编排命令副作用）。

### 8. Worktree 创建必须走 `git-cwt`

创建新 worktree **必须使用 `git-cwt`**（`~/.shell/07-git-ws.sh`），不要手动 `git worktree add`。

- `git-cwt` 调用 `.bare/custom-hooks/setup-worktree.sh`，该脚本执行：`pnpm install`（workspace 单步装完根 + packages/* + apps/*，`ELECTRON_SKIP_BINARY_DOWNLOAD=1`）+ Electron dist 缓存复用
- 项目使用 pnpm workspace（`pnpm-workspace.yaml` 声明 `packages/*` + `apps/*`），手动创建的 worktree 缺少依赖时必须跑 `pnpm install`
- Electron dist 缓存在 `<workspace>/.electron-dist-cache/`，新 worktree 通过 symlink 复用
- 删除 worktree 不影响缓存，后续 `git-cwt` 新建时自动从缓存链接

### 9. 多 Worktree 端口冲突排查

Vite 使用 `strictPort: true`（端口 1420 被占则静默失败）。同一机器上另一个进程（main worktree 或其他项目）占 1420 端口时，当前 worktree 的 Vite 不会启动，Electron 加载的是旧代码。现象：代码改了但浏览器不更新，DOM 出现已删除的旧元素。

```bash
# 确认 1420 端口属于当前 worktree
lsof -i :1420 -P | grep node
# 检查进程 cwd 是否指向当前 worktree 的 renderer 目录
```

### 10. Bare Repo Workspace 模式下的 Git/gh 注意事项

本项目使用 bare repo + worktree 模式（`xyz-agent-workspace/.bare/`），以下是此模式特有的问题：

#### Remote 命名
- `origin` 指向本地 bare repo（`xyz-agent-workspace/.bare`），不是 GitHub
- GitHub 的 remote 叫 `github`（`git@github.com:zhushanwen321/xyz-agent.git`）
- push 到 GitHub：`git push github HEAD:fix-xxx`，不是 `git push origin`

#### `gh` CLI 在 workspace root 不可用
- workspace root（`xyz-agent-workspace/`）不是 git repo，`gh` 无法自动发现 repo
- 所有 `gh` 命令必须带 `--repo zhushanwen321/xyz-agent`
- 或在 worktree 目录内运行（此时 `gh` 能从 `.git` 文件追溯到 bare repo）

#### worktree 的 upstream tracking
- `git-cwt` 创建 worktree 时不自动设置分支 tracking
- 默认 `@{upstream}` 可能指向 `origin/main`，导致 `git log @{upstream}..HEAD` 显示所有 feature commits
- 修复：`git branch --set-upstream-to=origin/<branch-name>`

#### pnpm workspace 单步安装
- `.npmrc` 配置 `node-linker=hoisted` 保证 Electron 兼容性（详见 ADR-0036）；手动创建 worktree 后跑一次 `pnpm install` 即可（root + packages/* + apps/* 一次装完）

#### merge-worktree 脚本的 bare repo 兼容
- 脚本已修复：自动检测 `GH_REPO` 并给所有 `gh` 调用加 `--repo`
- 没有 main worktree 时，用 bare repo（`.bare/`）做 `git --git-dir`
- 版本 bump push 用 `HEAD:refs/heads/main` 而不是 `main`（worktree 中本地没有 main 分支）

### 11. Plugin System 架构约束

- **Plugin Service 是唯一的适配层**: 所有前端 ↔ 插件系统通信必须通过 WS → server.ts → PluginService 路径。前端不直接与 Worker 通信
- **执行隔离（两层）**: trusted 插件运行在 Worker Thread 中；sandbox 插件运行在独立 fork 子进程中（`XYZ_PLUGIN_SANDBOX_DIR` + ESM loader 路径边界，plugin-host-process.ts）。插件崩溃不影响其他插件或主进程
- **Hook 串行执行**: executeHooks 按 priority 排序串行 invoke 每个 handler。单个 handler 超时 5s 视为放行。blocked 终止链
- **Tool RPC 路由**: handleBridgeToolExecute 通过 toolRegistry 查找 → Worker RPC invoke（超时 30s）→ 返回结果。不是 stub
- **sessionData 缓存**: 读取走内存缓存，写入先缓存（per-write 500ms debounce + 5s 周期 flush），runtime shutdown 时先 flushAll 再停 timer（正常关停零丢失）。容量上限 10MB/plugin
- **Hot Reload**: 外部插件通过 fs.watch 监听（300ms debounce）。built-in 插件不监听
- **WS 命名约定**: Client→Server 用点号（`plugin.xxx`），Server→Client 用冒号+camelCase（`plugin:statusBarUpdate`）
- **Plugin Store**: 前端使用 `stores/plugin.ts` + `composables/usePlugin.ts` 管理 plugin 状态和 WS 事件
- **数据目录隔离**: `~/.xyz-agent/` 与 `~/.pi/agent/` 完全隔离（已有规则 #10）
- **Builtin pi-extensions 打包内置（现行机制）**：10 个 `@zhushanwen/pi-*` 包随应用打包内置，不走 npm 安装。esbuild 把每个包 bundle 成自包含 `index.js`（JS 依赖 inline，仅 pi virtualModules external）→ staged 到 `apps/electron/resources/extensions/@zhushanwen/<pkg>/` → electron-builder extraResources 拷进 `Resources/extensions/` → resolver `bundled` 源扫描；dev 与 build 同源。清单 SSOT = `packages/shared/src/mandatory-extensions.json`（`tier: infrastructure | feature` 两级，`prepare-builtin-extensions.sh` 读它生成 staged 产物，新增包自动生效）；产物校验在 `postbuild-validate.sh`（`verify-staged-extensions.mjs`）
  - 守卫：`installExtension` 抛 `builtin_already_installed`（禁止对 builtin 包 npm 安装）；`uninstallExtension` 抛 `builtin_cannot_uninstall`（UI 无卸载按钮）。infrastructure 3 包（`pi-pending-notifications`/`pi-session-reader`/`pi-structured-output`）不可禁（`toggleExtension` 抛 `infrastructure_cannot_disable`，UI 无启用开关）；feature 7 包可禁。判定函数 `isBuiltinExtension` / `isInfrastructureBuiltin`（`packages/shared/src/extension.ts`）。非 builtin 扩展（第三方 npm/local-dir/git）正常装卸
  - **[HISTORICAL] 演化史**：builtin 依赖 → Settings 推荐安装（2026-07-04）→ boot npm install mandatory（2026-07-30）→ 打包内置（2026-08-12，现行）。中间机制的结论不再适用；「删除打包所需依赖导致产物缺失」的事故教训始终适用（pi binary、xyz-system-prompt-extension.js 等 builtin 资源同理）
  - **xyz-system-prompt-extension.js**（repo root）：builtin 文件型 pi 扩展，before_agent_start hook 实现系统提示词追加注入。走 `--extension` CLI 注入（extension-service.getExtensionPaths 在 xyz-agent-extension.js 之后追加）。打包走 electron-builder.yml extraResources（`../../xyz-system-prompt-extension.js`），postbuild-validate.sh 校验产物存在性。「删除打包所需依赖」事故教训同样适用
  - extension/skill 都不走 vendor submodule（2026-07-04 移除了 `vendor/xyz-pi-extensions` + `vendor/xyz-harness` 两个 submodule，`prepare-pi-resources.sh` 现只负责下载 pi binary，extensions 走 npm 源、skills 走用户/project 级目录 `~/.agents/skills` / `<cwd>/.pi/agent/skills`）

### 12. Electron 打包约束（违反必出 bug）

事故最高发领域。开发时三条硬规则（写代码 / 加依赖 / 提交那一刻就要遵守，其余由 review + 脚本自动把关）：

1. runtime 源码禁止 `import.meta.url` / `fileURLToPath(import.meta.url)` / `globalThis.__dirname`（CJS bundle 下全部失效）；路径用 `typeof __dirname !== 'undefined' ? __dirname : undefined`
2. 新增 runtime npm 依赖必须同步追加 `packages/runtime/tsup.config.ts` 的 `noExternal`（否则打包后 `Cannot find module`）
3. 打包子系统改动（tsup / electron-builder / plugin-host / runtime）必须逐个 commit、逐个验证——混在一个 commit 出 bug 无法定位是哪个改动引入

打包配置细节（electron-builder files/asarUnpack 交互、symlink、子进程启动、tsup target 匹配等）的逐项核对方法见 pr-cr-fix 的 `agents/review-electron-build.md`（PR review 强制核对）；打包验证三阶段（preflight-check.sh → `pnpm build` → postbuild-validate.sh）+ `validate-runtime-bundle.sh`（pre-commit 在 `packages/runtime/src/` 变更时自动触发，含 CJS 兼容检查与 smoke test）由脚本自动化，发布流程见 merge skill。

### 13. 目录规范（违反必出 bug）

- **禁止创建 `demos/` 或 `impeccable/` 目录** — 页面设计稿统一放 `docs/page-design/`：视觉规格在 `v6-spec-*.html`，能力设计 spec 在 `archive/v3/`。pre-commit hook 自动检查
- **禁止 symlink 指向外部绝对路径** — 项目内 symlink 白名单仅允许 `../` 相对路径（指向同 workspace 内的兄弟 worktree）。外部绝对路径 symlink 打包后目标不存在，导致运行时资源缺失。pre-commit hook 自动检查
- **`.xyz-harness/` 目录必须提交且不能删除** — 该目录存放所有 spec/plan 的历史设计文档（按 `YYYY-MM-DD-<slug>/` 命名），是项目决策追溯的重要依据。禁止 `git rm -r .xyz-harness/` 或将其加入 `.gitignore`
- **`DESIGN.md` 必须保留在项目根目录** — ~~产品设计系统的核心定义文件~~（已 DEPRECATED by ADR-0019，Warm & Soft 被推翻）。真身设计系统见 `docs/page-design/design-tokens.md` + `docs/page-design/design-system.md`（v3 冷蓝暗色）。文件保留作历史参考，不作为当前规范

### 14. 项目 skill 必须自包含 [HISTORICAL]

**项目维度 skill（`.agents/skills/`）引用的所有脚本必须复制到项目 skill 目录内，禁止依赖全局脚本目录（`~/.agents/skills/`）或 symlink。**

- **根因**：全局脚本不随项目 git 跟踪、变更会悄悄影响项目行为；且 bare repo workspace 的 remote 语义（`origin`=bare repo，`github`=真远程）与通用脚本不一致，曾导致 pre-merge-check 误报「有未推送 commits」
- **规则**：脚本复制到 `.agents/skills/<skill-name>/scripts/` 随 git 跟踪；路径用项目内相对路径；禁止 symlink 指向全局脚本（违反 §13）；项目内副本有问题直接改副本
- **当前自包含脚本**：`.agents/skills/merge/scripts/` 含 init.sh / pr-merge.sh / pre-merge-check.sh / release.sh / remove-worktree.sh / wait-for-ci.sh

### 15. git status untracked 目录展开 [HISTORICAL]

`GitService.getStatus` 执行 `git status --porcelain=v1 -z -b` **必须带 `--untracked-files=all`**。

- **根因**：默认 git 把整个 untracked 目录折叠成一行 `?? dir/`（**带尾斜杠**）。文件树 `FileNode.path` 无尾斜杠，两者失配 → overlay key 查不到 → 目录徽章误显（前缀匹配命中自身那条带斜杠记录）、展开后子文件无角标无行数（git 根本没报告这些文件）。
- **修复**：`--untracked-files=all`（`-uall`）强制展开每个 untracked 文件到文件级（`dir/file.py`，无尾斜杠），与 `FileNode.path` 格式一致。`.gitignore` 仍生效，只展开未忽略的 untracked 文件，不会因 node_modules 等爆量。
- **修改位置**：`packages/runtime/src/services/git-service.ts` getStatus 的 status 命令。commit 用 `git diff --numstat HEAD`（不受此约束，numstat 只管 tracked 改动）。
- **测试基线**：`git-service.test.ts` 的 `status 命令带 --untracked-files=all 展开未跟踪目录到单文件` 用例断言了命令参数。

### 16. 禁止写死项目绝对路径（必须动态推导）[HISTORICAL]

**runtime 代码禁止出现特定项目的绝对路径（如 `/Users/.../xyz-agent-workspace`）或对特定项目的硬编码假设。所有 workspace / bare repo / 数据目录路径必须从运行时上下文动态推导。**

- **根因**：xyz-agent 是通用工具，用户会在任意 bare repo + worktree 结构的项目中使用，写死路径导致其他项目功能失效
- **正确做法**：workspace 根 / bare repo 路径用 `WorkspaceDetector.detect(currentCwd)` 向上查找 `.bare`（`workspace-detector.ts`）；数据目录用 `getDataDir()` / `getConfigDir()`（`packages/shared/src/paths.ts`），禁止硬编码 `~/.xyz-agent`；路径白名单动态推导（架构约定 #2）
- **关联教训**（spawn 权限）：git 跟踪的脚本默认 644 无 x 位，直接 `spawn(scriptPath)` 会 EACCES；执行外部脚本用 `spawn('bash', [scriptPath, ...args])` 包装，不依赖权限位
- **检查方法**：`grep -rn "xyz-agent-workspace\|/Users/zhushanwen" packages/runtime/src/` 不得在逻辑代码中出现硬编码绝对路径

### 17. 跨层机制排查必须穷尽所有层（pi extension ↔ xyz-agent runtime）[HISTORICAL]

**分层架构里，每层只看自己视角，「我这层没做」≠「没发生」。涉及 pi extension ↔ xyz-agent runtime 的跨层机制排查，必须穷尽所有可能发起方，不能只看 xyz-agent runtime 侧就下结论。**

**事故背景**：排查「background subagent 完成后主 agent 是否续跑」，explorer 只看 xyz-agent runtime 就断言「不续跑」，差点据此设计出「永不响」的错方案。真相：续跑由 pi 进程内的 extension 发起（pi-subagent-workflow notifier 调 `pi.sendMessage(..., {triggerTurn:true, deliverAs:'steer'})`，pi 核心收到后开新 turn），xyz-agent runtime 只是旁观转发，与用户手动发消息触发的 turn 无法区分。跨层机制的发起方/执行方分布在不同进程/扩展中，单一层视角必然遗漏。

**排查跨层机制的强制步骤**：
1. xyz-agent runtime 侧（event-interpreter / session-service / message-dispatcher / session-message-handler）：只是「旁观 + 转发 + UI 同步」，不主动编排 pi 行为
2. pi extension 机制（pi 进程内）：`@zhushanwen/pi-*` 扩展的 notifier / hook 才是续跑/编排的发起方。开发期源码在本项目 `extensions/`，用户机器运行时安装在 `~/.xyz-agent/pi/agent/npm/node_modules/@zhushanwen/pi-*/src/`（排查用户环境问题看这个）
3. pi 私有协议（`triggerTurn`/`deliverAs`/`before_agent_start`）：语义见 `packages/shared/src/message.ts` 注释，xyz-agent 不实现它们
4. 设计文档：`docs/page-design/archive/v3/` 的 extension adaptation 文档；extension 的 `ctx.mode`、运行环境、SDK 契约见 [docs/extensions/extension-conventions.md](docs/extensions/extension-conventions.md)

**判断依据**：涉及 pi 的 session loop / turn 调度 / LLM 调用的行为，发起方几乎一定在 pi 进程内；xyz-agent 的职责是 UI 状态同步 + 用户命令转发，不是 pi 行为编排。

**教训**：当用户的领域知识与 explorer 结论冲突时，**优先怀疑 explorer 排查范围不全**，而非怀疑用户。

## 测试规范 [HISTORICAL]

> **执行测试或设计测试计划前，先读 [TEST-STRATEGY.md](TEST-STRATEGY.md)（分层策略/mock 策略/回归基线 SSOT）+ [docs/testing/](docs/testing/) 对应功能文档**（各页面组件的 MOCK/非MOCK 测试步骤 + Playwright E2E 调用链 + 每步期望输入输出 + 已知坑）。docs/testing/ 00 总览是入口篇。复用已有 testid 清单/调用链/fixture 数据/历史踩坑经验，不从零重新探索——这些文档记录了 mock 回显双匹配、thinking 收起态 v-if 时序、initApp 预填 cwd 等仅靠读组件代码无法发现的运行时行为。

1. **测试框架用 vitest，禁止 `node:test`**：`packages/runtime/` 子项目使用 vitest（配置在 `packages/runtime/vitest.config.ts`，依赖 `vitest@^4.1.6`，test script 为 `vitest run`）。所有测试文件必须从 `vitest` 导入 `describe/it/expect/vi/beforeEach` 等，禁止从 `node:test` 导入。vitest 不识别 `node:test` 格式的测试，会导致 "No test suite found" 错误。

2. **运行测试命令**: `npx vitest run <test-file>`，不是 `tsx --test`。虽然 `tsx --test` 能正常运行（不会卡住），但它跑的是 node:test 原生 runner，不支持 vitest 的 mock（`vi.fn()`/`vi.useFakeTimers()`）和配置（vitest.config.ts）。项目 CI 和开发流程都用 vitest。

3. **测试超时**: vitest 单个测试默认 5s 超时。涉及 setTimeout/timer 的测试必须使用 `vi.useFakeTimers()` + `vi.advanceTimersByTime()` 而不是真实等待，避免超时失败。

4. **subagent task prompt 必须明确测试框架**: 派遣编码 subagent 时，task prompt 中必须写明 "测试框架使用 vitest（从 vitest 导入 describe/it/expect/vi），运行命令 npx vitest run，禁止 node:test 和 tsx --test"。

### 测试视角与覆盖质量 [HISTORICAL — 2026-06-27「新建任务」事故]

> 事故背景：「新建任务」功能测试全绿 + tsc EXIT 0，用户手动打开却发现 Landing 态根本没有 composer 输入区——测试只有构建者（白盒）视角，缺使用者（黑盒：能否完成目标）与观察者（形态：渲染长什么样）视角。

5. **每条集成/E2E 用例至少一个用户可见断言** [MANDATORY]：每条 `it` 至少含一个 `wrapper.find(...).exists()` / `wrapper.text()` / `wrapper.html()` 断言（DOM 元素存在、文案渲染、可见状态）。纯内部断言（`state.value`、`expect(apiMock).toHaveBeenCalled`）不计入 DoD 覆盖。反模式：39 用例全断言 state/testid，零个断言「用户能否看到输入框」。

6. **集成/E2E 测试必须 mount 文档指定入口** [MANDATORY]：必须 mount test-strategy.md 集成章节指定的组件树入口（如 `Panel`），断言渲染结果。禁止悄悄用更小被测对象替换（文档写 `mount(Panel)`，代码却只调 `useNewTaskFlow()` 断言 `state.value`）。入口确无法 mount 时必须显式说明并降级入口，不得擅改。

7. **用户旅程步骤不可降级** [MANDATORY]：E2E 场景表里每个用户操作步骤必须有对应 DOM 断言。不得因某步「难 mock」跳过整步或降级成内部状态断言。某步确实无法自动化（OS 原生 dialog 等），标注 `[需手工]` 并保留该步占位断言，**不得删除该步骤**。

8. **测试验收 DoD 增加「渲染 gate」** [MANDATORY]：DoD 第三项——mount 功能顶层容器，断言 spec 结构章节（§3.x 等）列出的每个「结构元素」对应 DOM 节点存在。**spec 结构条目 = 渲染断言清单**（spec 写了 composer，测试就验证 composer 在 DOM 里）。只数用例编号 + 测试全绿不构成 DoD。

**首屏冒烟模板**（每功能必含 1 条）：mount 顶层容器，断言关键交互元素**存在于 DOM**。本次 bug 回归防护：

```typescript
it('首屏渲染：Landing 态 DOM 含 composer 输入区 + chip 行', () => {
  const wrapper = mount(Panel, { props: { sessionId: null } })
  expect(wrapper.find('[data-testid="composer-input"]').exists()).toBe(true)
  expect(wrapper.find('[data-testid="chip-directory"]').exists()).toBe(true)
})
```

> 三视角缺一不可：构建者（白盒）+ 使用者（黑盒）+ 观察者（形态）。任一缺失即重蹈「测试全绿但功能不可用」。

## 前端编码规范

**权威标准文档**: `~/Code/xyz-ui/CONVENTIONS.md`

### 核心规则

1. **禁止原生 HTML 表单元素** — 必须使用 xyz-ui 组件（Button/Input/Select/Dialog 等）
2. **禁止 Emoji** — 使用 inline `<svg>` 或 @lucide/vue 图标
3. **样式统一 Tailwind 类（三层结构）**
   - **Design tokens**（`style.css`）：只放 `:root` / `[data-theme]` 的 CSS 变量和 base reset，不放组件样式
   - **Template class**（组件模板）：组件样式统一使用 Tailwind 工具类（`class="flex items-center gap-2 ..."`），不在 `style.css` 或 `<style scoped>` 中写组件样式
   - **Escape hatch**（`<style scoped>`）：只用于 Tailwind 无法表达的场景：伪元素（`::placeholder`）、后代选择器（`.msg__body p`）、Vue Transition 类（`.xxx-enter-from`）
   - 禁止 `@apply`，禁止在 `style.css` 中新增组件级样式规则
4. **行数上限** — `<template>` ≤ 400 行, `<script setup>` ≤ 300 行
5. **禁止 `any`** — 用 `unknown` 或具体类型。`as never` / `as any` / `as unknown as T` 会绕过类型检查：不可替代的断言必须有运行时 guard 兜底；`(x as any).field` 改为类型守卫函数。extensions/ 代码由 `taste/no-unsafe-cast` 规则强制（warn），前端代码作为原则遵守
6. **v-model 绑定** — 禁止 `:value` + `@input`，用 `v-model`
7. **Promise.allSettled** — 独立数据源用 `allSettled`，不用 `all`
8. **禁止硬编码颜色** — 用 CSS 变量（`var(--accent)`）或语义 Tailwind 类
9. **禁止魔数间距** — 用标准 Tailwind scale，不用 `p-[17px]`
10. **border-radius 遵循 v3 design-tokens**（`--radius-sm:3px` / `--radius:8px` / `--radius-lg:12px`）— `rounded-sm`(3px) 默认，`rounded-md`/`rounded-lg`(8/12px) 特殊场景。SSOT 见 [docs/page-design/design-tokens.md](docs/page-design/design-tokens.md)，裁决依据 ADR-0019（旧 Warm 时期的 1px/2px 规则已推翻）。详见 docs/standards.md §7.1
11. **窗口顶部 traffic light 安全区（v3 shell 拓扑 + 刻意调整形态）** — v3 重建采用 zcode-demo 拓扑：base 平铺全屏 → sidebar 透明融合 → main 是唯一 float-panel 浮起。traffic light 靠 **aside-region 顶部留白**兼容，而非旧版 padding-left 避让。**2026-08 二次裁决：本拓扑是刻意调整，不遵循 v6 demo**（PanelHeader 调小至 22px 与 trafficlight 行共线对齐、main-panel 与窗口边框间距收紧至 4px、折叠态 chrome 落入 header 等，出自 8c62f64bc/0251b6d40/860ee6007 等 commit）。此前一次裁决曾按「以 v6 demo 为准」回填 v6 拓扑（38px header / trafficLight {16,26} / p-3 / 52px 安全区），后经用户确认刻意调整被误改，已整体恢复。具体要求：
    - AppShell `p-1`(4px) 四周统一：上下左右各 4px（紧凑但有呼吸，对称）。注意：左右 4 使 aside 左缘 x=4，与红黄绿 x=8 有 4px 差（红黄绿保持原生位置不动，用户明确不移动 trafficLightPosition）；折叠态 `!gap-0`（aside 归零，padding 保持 p-1 四周 4px，与展开态一致）
    - `.aside-region` 恒定 `padding-top: 44px`(pt-11)（安全区 + 拉开 trafficlight 行与 LOGO 行间距），**三平台统一，全屏也保留**（mac 全屏 hover 时系统下拉覆盖层会落进这块留白）。AppShell py-1 使 aside 顶在窗口 y=4，红黄绿 y=8~20，安全区让出，与 trafficlight 行（nav 按钮 bottom y27）视觉间距约 12px
    - mac 红黄绿位置由主进程 `titleBarStyle:'hidden'` + `trafficLightPosition:{x:8,y:8}` 放到 macOS 原生左上角（**不用 hiddenInset**——inset 模式强制水平内缩，`trafficLightPosition.x` 被系统忽略）；win/linux 自绘圆点 `left:0 top:[4px]`（TrafficLight.vue 挂载于 AsideRegion 内，aside 顶在窗口 y=4，故 top-4 = 窗口 y8，与 mac 同位）。圆点 12px，顶理论 y=8 / **实测中线 y≈15.75**（macOS 渲染亚像素偏置，比理论 y14 低 ~2pt）/ 右缘 x=60
    - app-nav-controls（收起侧栏/←/→）浮在 AppShell 层（aside 外，避免折叠态 overflow-hidden 裁剪），**非折叠态** `left:72px top:5px`（按钮中线 y=5+11=16，对齐红黄绿**实测**中线 ~15.75；红黄绿右缘 60 + 12 呼吸），全屏 `left:8px`（320ms 平移与 traffic-light opacity 同步）。**PanelHeader `h-[22px]` 与 trafficlight 行共线对齐**：main-panel 顶=AppShell p-1(4)+border(1)=y5，h-22 → header bottom y27 = nav 按钮 bottom，内容中线 y16 ≈ 红黄绿实测中线 y15.75（三者顶/底/中线全对齐）。右侧 drawer/git 按钮 `size-[22px]` 适配 22 高 header
    - **折叠态** chrome 迁入 P1 PanelHeader 内（header `pl-[88px]` 让位红黄绿右缘 60），chrome 按钮在 header 中线（header h-22 中线 y16 = 红黄绿中线，无高度差）；AppShell 折叠态 `!gap-0`（强制覆盖 gap-3，padding 保持 p-1）
    - 全屏两态：非全屏（traffic light opacity 1，按钮 left:72px）/ 全屏（opacity 0，按钮左移 left:8px）。**无第三态**，mac 全屏 hover 红黄绿由系统提供，应用不渲染。全屏态 TrafficLight 圆点 `opacity-0 pointer-events-none` 成对（review MF-1：隐形圆点仍可命中会劫持 header chrome 点击）
    - win/linux 走 mimic_mac：自绘彩色圆点放左侧模拟 mac，三平台左上视觉统一
    - 唤回侧栏：⌘B + header chrome 按钮（**rail-restore 左缘细条已移除**）
    - 新增或修改任何窗口顶部区域 UI 时，先对照本条目数值，再读 [v6 shell spec](docs/page-design/v6-spec-shell.html) 了解设计稿差异（v6 demo/spec 的 38px/16,26/52px 拓扑不适用本实现，属刻意偏离）
    - 设计决策记录：[ADR 0017](docs/adr/0017-macos-traffic-light-safe-zone.md)（旧版 padding-left 方案，**已 Superseded**）；8c62f64bc/0251b6d40/860ee6007（刻意调整序列，现版形态来源）
12. **reka ScrollAreaViewport 默认 `overflow-x: hidden` [HISTORICAL]** — reka-ui 的 `ScrollAreaViewport` 内联注入 `overflow-x: hidden`，横向溢出的内容被**裁掉不滚动**（非 `scroll` 也非 `auto`）。文件树等需横向滚动看长文件名的场景，必须给 `ScrollArea` 传 `horizontal` prop（`src/components/ui/scroll-area/ScrollArea.vue`，渲染额外横向 ScrollBar + 用 `!overflow-x-auto` 覆盖内联 style）。覆盖用 Tailwind `!` 前缀（`!important` 压过 inline）；scoped `<style>` 的 `:deep()` 不行——会注入 `<style>` 元素破坏 reka Root 的子组件渲染顺序，导致 ScrollBar/Corner 不挂载

### 自动化检查

| 检查工具 | 覆盖范围 | 触发时机 |
|---------|---------|---------|
| taste-lint (ESLint) | no-native-html / no-emoji / prefer-v-model / no-hardcoded-colors / no-magic-spacing / no-silent-catch / prefer-allsettled / no-multi-arg-emit | `pnpm run lint` + pre-commit |
| vue_rules_checker.py | 行数上限 / CSS 选择器 / Tab 缩进 / 原生元素 / Emoji / v-model | pre-commit |

### Lint / Git Hooks 问题处理原则 [MANDATORY]

**按全局 AGENTS.md「Pre-commit Hook 问题处理」执行**：lint / githooks（含 vue_rules_checker、pre-commit 的 `check_*.py`）检出的任何等级问题（含预存存量）必须全部正面修复——禁止 `--no-verify` / 项目专属 `SKIP_*` 变量（`SKIP_FRONTEND_LINT` / `SKIP_CODE_RULES_CHECK` / `SKIP_ALL_CHECKS` 等）绕过，仅限线上故障热修复且须在 commit message 说明原因。规则误报的唯一正当处理：修正规则本身使其准确（如 reka-ui `SelectItem :value` 是选项值语义，应排除），并在规则文件加 `[HISTORICAL]` 注释记录原因；禁止 `// eslint-disable-next-line` 局部静默。

### 完成即提交 [MANDATORY]

按全局 AGENTS.md「提交策略 → 完成即提交」执行，禁止留脏工作区结束，无法提交必须说明原因。项目补充：pre-commit 检出的问题先按上文「Lint / Git Hooks 问题处理原则」修复，「检查未过」不构成不提交的理由；提交范围用全局策略（优先本次会话改动，文件级颗粒度）。


## Git 规范

- **分支命名**：`feat/`、`fix/`、`refactor/`、`chore/` 前缀（如 `feat/merge-extensions`、`fix/app-start-error`）
- **Commit 信息**：英文，遵循 conventional commits 风格（`feat:`/`fix:`/`refactor:`/`docs:`/`chore:`/`ci:` 前缀）
- **提交粒度**：见全局 AGENTS.md「提交策略」——优先提交自己的改动，认知外的改动不碰

## pi 资源放置规范

本项目既开发 pi extension（`extensions/`）又有自己的项目资源（`.agents/`），agent.md / workflow.js 放错地方会不被发现或不可移植。以下约束强制资源归位。

### 资源该放哪

| 资源性质 | 放置位置 | 声明 |
|---|---|---|
| 与某个 extension **强相关**的 agent.md / workflow.js | `extensions/<pkg>/agents/`、`extensions/<pkg>/workflows/` | package.json `pi.agents` / `pi.workflows` |
| 项目本身开发要用的 subagent | `.agents/agents/` | 自动发现（project-agents 源） |
| 项目本身开发要用的 workflow | `.agents/workflows/` | 自动发现（project 源） |
| 当前开发环境要用的 agent / workflow（跨项目通用） | 全局 `~/.agents/agents/`、`~/.agents/workflows/` | 自动发现（user-agents 源） |

### 「与 extension 强相关」判据

满足任一即强相关，必须进 extension 目录：
- agent 的 `tools` frontmatter 受限到某 extension 提供的工具（如 cw review-agent `tools: cw_review` 强相关 cw-tool）
- 移除该 extension 后 agent / workflow 无法正常工作

反例：`review-arch-boundary`（tools: 通用 read/bash）不强相关 → 留 `.agents/agents/`。

### 发现机制

- agent / workflow：pi-subagent-workflow `resource-discovery` 扫 7 源，同名 last-writer-wins（project-agents 优先级最高）。extension 内置 agent 必须在 package.json 声明 `pi.agents`，且**安装到 npm / npm-dev 扫描目录**才被发现——dev-link（`XYZ_EXTENSION_PATHS`）**不发现 agent**（只发现 skill + 工具）。
- skill：pi core 经扩展 `pi.skills` 声明发现（first-writer-wins），独立通路。
- SSOT：`extensions/subagent-workflow/src/shared/resource-discovery.ts`。

## 架构约定

- **视图切换**: 状态驱动（settingsStore.currentView），不用 vue-router
- **Mock 模式**: `VITE_MOCK=true` 环境变量控制，在 ws-client 层拦截
- **共享类型**: `packages/shared/src/` 通过 npm workspace 在前端和 runtime 间共享
- **Runtime 通信**: WebSocket，前端通过 `ws-client.ts` + `event-bus.ts` 消息分发
- **Electron IPC**: 主进程通过 preload 暴露 `window.electronAPI`，渲染进程不直接使用 `ipcRenderer`
- **Runtime broadcast 时序竞争 [HISTORICAL]**: session 级 broadcast（如 `session.commands`）若在 session 激活/创建流程内部发出（`ensureActive`/`lifecycle.create` 内的 `fetchAndBroadcastCommands`），会**早于** renderer 订阅该 sessionId 通道——订阅依赖 `switchSession`/`create` 的 RPC resolve → `activeId`/`currentSessionId` 更新 → `CommandPopover` 的 `watch(sessionId)` 重订，而 broadcast 已在此之前发出 → 消息丢失，renderer transport 只收到同流程的 `reply`（RPC 响应，走 pending map，不依赖订阅）。**约束：renderer 切换/创建 session 后需立即消费的 session 级状态，必须主动拉取**（新增 `session.getCommands` RPC，`useSidebar.selectSession` / `useNewTaskFlow.precreateSessionAndLoadCommands` 在 session 建立后调它 + `events.dispatchSession` 本地投递），不可依赖 broadcast 到达。新增任何 session 级 broadcast 必须对照本条评估。
- **pi 源码不可改约束 [MANDATORY]**: xyz-agent 作为 pi 的封装消费者，**不修改 pi 源码、不向 pi 上游提 PR、不 fork pi**。所有 pi 没提供但 xyz-agent 需要的能力（如 OAuth login 的 device/callback flow、auth.json 写入器），由 xyz-agent 自己实现。与「项目概述」的「不依赖 fork 特有改动」一致——保持 pi 升级路径畅通。

## 发布与 CI 验证 [HISTORICAL]

本项目有**两条独立的发布管线**，通过不同 tag 前缀解耦：

| 管线 | 产物 | 触发 tag | Workflow | 验证 |
|------|------|----------|----------|------|
| **Electron 打包** | DMG/EXE/AppImage 桌面应用 | `v*` | `release.yml` | `scripts/verify-ci-release.sh` |
| **npm 包发布** | `@xyz-agent/extension-protocol` + `@zhushanwen/pi-*` extensions | `npm-*` | `release-npm.yml` | changeset publish 输出 + npm registry 核对 |

**npm 发布有两条独立机制**（设计详见 docs「版本号人工判定机制」）：

| 机制 | 适用 | 版本判定 | tag |
|------|------|----------|-----|
| **main 稳定发布** | merge 后正式发布 | **人工定 type**（不再用 `changeset version` 自动推算，避免 shouldBumpMajor/applyLinks 把声明的 minor 误放大成 major）+ `scripts/check-version-changes.sh` + `scripts/apply-version.sh` | `npm-<slug>-<date>-<time>` |
| **dev-npm 预发布** | 预发布测试 | 保留 `changeset version` + `changeset pre`（生成 `-dev.*` 版本） | `dev-npm-*` 分支 push |

main 稳定发布流程（merge skill 阶段 4N 封装）：
1. 开发者在 PR 写 `.changeset/<slug>.md`（声明包 + 描述，type 初判）
2. merge 时跑 `check-version-changes.sh` 列出待处理包（CHANGED + DEPENDENTS 传递闭包）
3. 人工对 CHANGED_PACKAGES 定 type，`apply-version.sh` 自动 patch DEPENDENTS 刷新范围
4. commit + 打 `npm-<slug>-<stamp>` tag + push
5. tag 触发 `release-npm.yml` → 验证非 prerelease 模式 → `pnpm changeset publish`（预查 registry 只发未发布版本）
6. **禁止本地 `pnpm changeset publish` 或 `npm publish`**（曾因 npm registry 最终一致性导致 E403）；预发布走 `scripts/npm-prerelease.sh`（指定包名如 `bash scripts/npm-prerelease.sh @zhushanwen/pi-goal`）

**changeset 写作准则**（PR 阶段，写入贡献文档）：
- changeset 的 type 字段是**初判**，最终由 merge 时人工定（不绑死）
- changeset 的 **body 要认真写**（会进 CHANGELOG，消费者可见），不只写「fix bug」
- **dep 传播不在 PR 声明**：linked/peerDep 的连带包不用在 PR 写 changeset，merge 时由 `check-version-changes.sh` 传递闭包 + `apply-version.sh` 自动 patch

> **merge skill 集成**：merge skill 阶段 4N 封装了上述 main 稳定发布流程。仅当 PR 含 `extensions/` 改动时执行，与 Electron 发布线（阶段 4，`v*` tag）独立。dev-npm 预发布不走阶段 4N。详见 `.agents/skills/merge/SKILL.md`

### [MANDATORY] push tag 后必须验证 CI 产物

push 任何发布 tag 后禁止直接宣布完成（多次事故：push 后说"CI 会构建"就结束，实际 CI 构建失败或产物缺失无人察觉）。必须轮询 CI 并验证产物存在，直到验证脚本 exit 0：

| 操作 | 验证命令 |
|------|---------|
| 预发布测试 | `scripts/prerelease-test.sh` 内置自动验证 |
| 正式发布（merge） | `bash scripts/verify-ci-release.sh v<version>` |
| 手动 push tag | `bash scripts/verify-ci-release.sh <tagname>` |

脚本 exit 非 0 时：CI workflow 未完成或失败 → 打开 CI 链接排查；Release 未创建 → 检查 release.yml 是否触发；产物缺失 → 查对应平台构建日志。禁止说"CI 可能还在跑"或"应该没问题"后结束，必须修复直到 exit 0。

### [MANDATORY] Release Notes 必须中英双语

Release Notes 需要同时包含中文和英文版本，使用 `<!-- LANG:zh -->` 和 `<!-- LANG:en -->` 标记分隔。前端会根据用户语言偏好自动提取对应部分。

格式示例：
```markdown
<!-- LANG:en -->
## What's New
- Fix bug X
- Add feature Y

<!-- LANG:zh -->
## 更新内容
- 修复 bug X
- 添加功能 Y
```

注意事项：英文在前中文在后；标记必须独占一行；无标记的旧 release 仍正常显示完整内容（向后兼容）。



详细的问题排查指南（日志获取、诊断路径、常见问题清单、环境变量速查）见 [docs/troubleshooting.md](docs/troubleshooting.md)。

### 1. xyz-agent 数据目录与 pi 数据目录完全隔离

xyz-agent 的数据目录（`~/.xyz-agent/`）与 pi 的数据目录（`~/.pi/agent/`）必须完全隔离。不得读写 pi 的 extension/skill/config 目录，不得复用 pi 的包管理命令管理 xyz-agent 的 extension。两边的 extension 列表、配置、安装状态互不影响。Extension 通过 `--extension` CLI 参数在 pi 启动时注入路径，pi 原生 loader 加载。

### 2. 路径安全白名单必须动态化

所有涉及路径匹配的访问控制（`allowedPrefixes`、白名单校验、沙箱边界），禁止硬编码 `~/.xyz-agent` 或 `~/.pi` 路径。必须从 `getConfigDir()` / `getPiAgentDir()` 动态推导。

原因：实例隔离机制允许通过 `XYZ_AGENT_DATA_DIR` 环境变量改变数据目录（dev 模式为 `~/.xyz-agent-dev`），硬编码路径会导致白名单失效。

**Pre-commit 自动检查**：`check_path_whitelist.py` 会扫描含 `allowedPrefixes` 的文件，验证是否使用了动态路径函数。

### 3. ENV_WHITELIST_PREFIXES SSOT 单一性

`ENV_WHITELIST_PREFIXES` 的定义只允许在 `packages/shared/src/constants.ts`（单一权威源）。main/ 和 runtime/ 层禁止本地定义，只能 `import` 自 shared：
- `main/supervisor/safe-env.ts`：`[...ENV_WHITELIST_PREFIXES, 'ELECTRON_']`（主进程特权，可扩展）
- `runtime/src/infra/pi/rpc-client.ts`：`= ENV_WHITELIST_PREFIXES`（子进程用全集，不加额外）

[历史] 旧规则曾要求 runtime-manager.ts 和 rpc-client.ts 「各有一份常量并 diff 同步」。commit 863f0704 收敛到 shared SSOT 后，「两处不同步」物理不可能，检查改为 SSOT 单一性防护。

**Pre-commit 自动检查**：`check_env_whitelist_sync.py` 验证 `const ENV_WHITELIST_PREFIXES` 定义只出现在 shared/constants.ts，检测 SSOT 退化（未来有人在 main/runtime 本地重新定义）。

### 4. Runtime/pi 日志必须落盘 + 轮转 + 动态数据目录

runtime 子进程（`packages/runtime/src/`）与 pi 子进程的所有日志输出，**禁止只走 `console.*` → 终端**（关终端即丢，无法事后诊断 pi 静默卡死类问题）。必须持久化到文件。

**强制要求**：

- **数据目录动态推导**：日志目录必须 `<getDataDir()/logs/`（dev=`~/.xyz-agent-dev/logs/`，prod=`~/.xyz-agent/logs/`），由 `getDataDir()`（`shared/src/paths.ts`）推导。**禁止硬编码 `~/.xyz-agent`**（违反架构约定 #2，`check_path_whitelist.py` 会拦，且实例隔离后 dev/prod 路径不同会导致串台）
- **必须轮转**：单文件无限增长会撑爆磁盘。采用 date（按天文件 `runtime-YYYY-MM-DD.log`）+ size（单文件上限 ~50MB 触发 `.1` 滚动）双策略，保留期默认 7 天（`XYZ_LOG_KEEP_DAYS` 可调）。优先用 `node:fs` 自实现（当前实现：`runtime/src/infra/logger.ts`），**新增第三方日志库（pino/winston/rfs）必须同步追加到 `runtime/tsup.config.ts` 的 `noExternal`**（规则 #12），否则打包后 `Cannot find module`
- **dev vs prod 级别差异**：dev 默认 debug（含 `XYZ_DEBUG_PI_EVENTS=1` 的 pi 原始事件流），prod 默认 info（屏蔽 pi 原始事件，避免 PII/性能/磁盘问题）。级别由 `XYZ_LOG_LEVEL` 控制（`XYZ_` 前缀自动过 `ENV_WHITELIST_PREFIXES`，无需改白名单，符合架构约定 #3）
- **pi 子进程输出落盘**：pi 卡死时其 stdout JSONL 事件流是**唯一决定性证据**。pi stdout（`rpc-client.ts` 的 `createInterface` 消费点，`rl.on('line')`）必须 tee 一份原始行到 `<dataDir>/logs/pi-<date>-<sessionId>.jsonl`；pi stderr 进主 runtime 日志（经 `[rpc:stderr]` 前缀随 console 落盘）
- **实现位置**：logger 模块在 `runtime/src/infra/logger.ts`，在 `index.ts` 组合根最早期初始化（`initLogger(getDataDir())`），console 作为 logger 语法糖（monkey-patch 全局 console 覆盖 runtime 内既有的裸 console，tee 到终端 + 文件）。supervisor 层（`main/supervisor/process-control.ts`）仍捕获 runtime stdout 打终端，日志落盘责任在 runtime 自身

**[HISTORICAL] 背景**：「pi 静默卡死」事故中 pi 子进程 0% CPU 不退出、session JSONL 仅 2 行零 message，日志只在终端关掉即丢，无法事后追溯发了什么事件。此条目固化「日志必须落盘」。实现：`runtime/src/infra/logger.ts` + `index.ts` initLogger + `rpc-client.ts` pi stdout tee。

### 5. 包管理器与 lock 文件纪律 [HISTORICAL]

本项目是 **pnpm workspace 单一包管理器**项目（`pnpm-workspace.yaml` 声明 `packages/*` + `apps/*`），`pnpm-lock.yaml` 是唯一权威 lock 文件，**禁止跟踪任何 npm 产物**（`package-lock.json`）。通用纪律（`packageManager` 字段声明、`.gitignore` 忽略、`git rm --cached` 停止跟踪、安装命令与包管理器一致、禁 `npm version`）按全局 AGENTS.md「包管理器与 lock 文件纪律」执行。子包确需独立用 npm 时（罕见），在该子包自己的 `.gitignore` 放开规则并声明对应 `packageManager`。

[历史] 事故：`package-lock.json` 双轨跟踪导致版本三处各跑各的，且 npm 与 pnpm 解析算法不同（flat hoisting vs 严格隔离 + symlink），产生幽灵依赖与解析不一致 bug。

**保留 npm 的例外（不要"统一"成 pnpm）**：以下场景的 npm 命令是**刻意保留**的，未来 agent 做统一审查时**不要改**：
- **第三方消费者安装指引**：`docs/extensions/local-dev-guide.md` 的 `npm install -g @earendil-works/pi-coding-agent`、`prerelease/SKILL.md`（npm target）与 `release-npm-dev.yml` 的 `npm install @xyz-agent/extension-protocol@dev` 等。这些是发给 npm registry 的外部消费者的指引，他们环境未必装了 pnpm，npm 是最通用的兜底
- **`npm publish`**：发包命令。`pnpm changeset publish` 内部最终也调 `npm publish`，文档里描述发包用 npm 是准确的
- **runtime 安装用户 extension 的机制**：`extension-service.ts`/`installer.ts` 等代码里对用户 extension 执行 `npm install` 到数据目录——这是面向终端用户的 extension 安装机制，用户环境不可控，必须用 npm
- **规则正文描述被禁命令**：本节禁止 `npm install` 的条文里必须保留 npm 字样（描述被禁的命令名）
- **`npx` 命令**：中立包执行器，不算 npm 风格违纪，保留

**判断标准一句话**：命令执行者若是「本项目的开发者/CI/AI」→ 用 pnpm；若是「外部消费者/终端用户」或「描述被禁行为」→ 保留 npm。

## 跳过检查

### cw v1 testRunner cwd 对 monorepo 失效 [HISTORICAL]

[历史] cw v1 testRunner 硬编码 `cwd: workspacePath`（仓库根）跑 `npx vitest run`，而本项目 vitest 配置在子包（如 `packages/renderer/vitest.config.ts` 含 `@/` alias），根目录跑出大量假失败（200+ failed），test gate 永远不过——即使本次改动零回归。

**已修复（2026-08 验证）**：当前 cw 版本（@zhushanwen/coding-workflow）支持 `plan.testCwd` 字段——wave design/replan 阶段填 `testCwd: "<子包目录>"`（相对仓库根，如 `packages/runtime`），testRunner 即在该子包目录跑 testCommand，gate 数字与本地 `npx vitest run` 一致。monorepo 项目在 wave design 填 testCwd 即生效。

> **默认禁止跳过**（见上文「Lint / Git Hooks 问题处理原则 [MANDATORY]」）。以下变量仅供线上热修复等紧急场景，使用时必须在 commit message 说明原因。

```bash
SKIP_ALL_CHECKS=1 git commit       # 跳过所有（仅紧急情况）
SKIP_FRONTEND_LINT=1 git commit    # 跳过 ESLint
SKIP_EXTENSION_LINT=1 git commit   # 跳过 extensions ESLint + tsc + manifest/convention 检查
SKIP_CODE_RULES_CHECK=1 git commit # 跳过 vue_rules_checker
SKIP_ENV_WHITELIST_CHECK=1 git commit   # 跳过 ENV 白名单同步检查
SKIP_PATH_WHITELIST_CHECK=1 git commit   # 跳过路径白名单动态化检查
SKIP_DIRECTORY_RULES_CHECK=1 git commit  # 跳过目录规范检查（禁止 demos/impeccable + 外部 symlink）
SKIP_TOOL_SCHEMA_CHECK=1 git commit      # 跳过 Pi extension tool schema 顶层 Object 合规检查
```
