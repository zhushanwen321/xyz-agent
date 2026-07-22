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
- [设计 Tokens（v3 SSOT）](docs/page-design/design-tokens.md) — 冷蓝暗色原子值（色/字/距/影/动效），ADR-0018 确立
- [设计系统原语层（v3）](docs/page-design/design-system.md) — 组件原语如何使用 tokens
- [v3 UI 设计稿](docs/page-design/v3/README.md) — L0-L4 递归骨架 spec + draft（shell/sidebar/workspace/panel/overview/settings/overlays/flow-2/flow-3）
- [领域术语表](docs/architecture/context.md) — Session/Panel/Runtime/v3 UI 结构术语
- [竞品 UI 分析](docs/templates/competitor-ui-analysis.md) — Claude Code / Codex 逐图拆解，7 条设计原则
- [UI/UX 设计原则与参考](docs/templates/ui-design-principles-and-references.md) — 设计方法论 + 竞品案例 + 行动清单
- [设计方向](docs/templates/design-direction.md) — 产品定位、主题策略、窗口架构、实施优先级
- [暗色主题选项 demo](docs/templates/dark-theme-options.html) — 5 种彩色 accent 方案对比
- [朴素锐利主题 demo](docs/templates/muted-sharp-themes.html) — 5 种低饱和/无彩色方案对比

**页面设计目录**: `docs/page-design/` — v3 设计 SSOT 与设计稿。结构：`design-tokens.md`（原子）+ `design-system.md`（原语）+ `v3/`（正式设计区，L0-L4 骨架）+ `zcode-demo/`（视觉原型）+ `archive/`（pre-v3 历史稿）。禁止在项目根目录或其他位置创建 `demos/`、`impeccable/` 等目录

**外部项目源码**:
- **pi**: [badlogic/pi-mono](https://github.com/badlogic/pi-mono) — AI coding agent CLI，xyz-agent 通过子进程 RPC 调用。session tree / fork / clone 核心能力为 pi 原生，xyz-agent 不依赖任何 fork 特有改动
  - npm 包: `@earendil-works/pi-coding-agent`
  - 当前版本: `0.80.3`
  - 历史背景：此前使用 fork `zhushanwen321/pi`（包名 `xyz-pi`），fork 唯一改动是在 `get_state` RPC 响应中透出 `leafId` 字段。该字段在 xyz-agent 前端从未消费，2026-07 已切回上游，leafId 改为从 JSONL session 文件解析近似值
  - Skill 加载: `packages/coding-agent/src/core/skills.ts`
  - Skill 展开: `packages/coding-agent/src/core/agent-session.ts` — `_expandSkillCommand()`
  - Slash 命令: `packages/coding-agent/src/core/slash-commands.ts`
  - RPC 协议: `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
  - TUI 交互: `packages/coding-agent/src/modes/interactive/interactive-mode.ts`

**Settings 模块设计文档**:
- [Settings 视觉 demo](docs/page-design/archive/settings-final.html) — Section Groups 风格 HTML demo（pre-v3 历史稿）
- [Settings spec](.xyz-harness/2026-05-12-settings-redesign/spec.md) — 需求规格（WS 协议、数据流、组件结构）
- [Settings plan](.xyz-harness/2026-05-12-settings-redesign/plan.md) — 实现计划（12 个 Task）

## 常用命令

```bash
npm run dev          # 开发模式 (Electron + Vite HMR)
npm run build        # 生产构建 (electron-builder)
npm run lint         # ESLint 检查（或 pnpm run lint）
npm run prepare      # 安装 git hooks

# 打包流程（pnpm workspace 单步安装，无需 cd 子目录）
pnpm install          # 安装所有依赖（根 + packages/* + apps/*，ELECTRON_SKIP_BINARY_DOWNLOAD=1 跳过二进制下载）
bash scripts/preflight-check.sh   # 打包前检查
pnpm build                             # 构建 DMG/ZIP/EXE
bash scripts/postbuild-validate.sh         # 打包后验证

# 单独验证 runtime bundle
bash scripts/validate-runtime-bundle.sh
```

## 关键规则（违反必出 bug）

### 1. emit 只传单个 payload 对象
禁止 `emit('event', arg1, arg2)` — handler 极易混淆参数顺序。必须 `emit('event', { arg1, arg2 })`。

### 2. Event bus listener 防重复注册
组件可能多实例（split mode），listener 必须用模块级 refCount 保护，否则事件处理翻倍。

### 3. 错误必须重置 isGenerating + streamingMessage
任何错误路径都必须重置状态，否则 UI 卡死在「思考中」。错误作为 assistant 消息插入聊天流，不用顶部 banner。

### 4. 外部系统对接先验证再编码
对接 pi RPC 等外部系统时，先写独立验证脚本（`tools/verify-*.cjs`），确认字段名和格式后再写业务代码。

### 5. pi 适配层不信任外部格式
EventAdapter 和 session-pool 是 pi 协议的唯一适配点。业务代码不直接处理 pi 格式。`sendCommand` 必须检查 `success` 字段。

### 6. pi session 文件延迟写入

pi 的 `SessionManager._persist()` 在收到第一个 **assistant** 消息之前不会写入 session 文件（延迟写入策略：所有 entry 缓存在内存，等 assistant 到达才 flush）。这意味着 `get_state` 返回的 `sessionFile` 路径对应的文件在首次 assistant 回复前**可能不存在**。

所有读取 session 文件的代码必须处理文件不存在的场景：
- `session-tree-reader.buildTreeFromFile()` → 文件不存在时返回空树
- `getHistoryFromFile()` → 文件不存在时返回空消息列表
- **禁止**假设 `get_state` 返回 `sessionFile` 后文件就已存在

**[HISTORICAL] 禁止提前创建 session 文件**：曾经有 `ensureSessionFile()` 在 session 创建后立即用 `openSync(filePath, 'wx')` 创建含 session+session_info 两行的最小文件，理由是「确保 scanPiSessions 能找到该 session」。但这与 pi 0.80.3 `SessionManager._persist` 首次 flush 的 `openSync(sessionFile, "wx")` 冲突 → **EEXIST** → pi 抛 `message_start{stopReason:"error"}` → 整个 session 永久卡死（坏 session 文件只有 2 行，pi 自己的内容从未写入）。正确做法是依赖 `SessionScanner.listAll()` 合并内存 active session（`this.sessions` Map）：活跃 session 即使磁盘无文件也显示在列表里。**禁止任何代码在 pi 首次 flush 前创建/触碰 session 文件**。

### 7. Session 隔离：所有消息必须带 sessionId

所有 runtime → 前端的消息，如果涉及特定 session，`payload` 必须包含 `sessionId`。前端靠 `payload.sessionId` 路由到正确的 panel/store 分区。**缺失 `sessionId` 的消息应被忽略**，否则会广播到所有 panel。

三层隔离机制：

| 层 | 职责 | 位置 |
|---|---|---|
| ChatStore 分区 | `chatSessions: Map<sessionId, ChatSessionState>`，所有操作要求显式 sessionId | `stores/chat.ts` |
| useChat 全局路由 | 事件处理器从 `msg.payload.sessionId` 提取 sid，路由到 store 分区 | `composables/useChat.ts` |
| PaneSessionView 过滤 | 组件级事件监听（error、compacted 等）严格按 `props.sessionId` 过滤 | `PaneSessionView.vue` |

Runtime 侧：`server.ts` 的 `sendError` 必须传入 `sessionId`（外层 catch 从原始消息 `msg.payload.sessionId` 提取）。不带 `sessionId` 的 error 会被前端所有 panel 忽略。

### 7.6 per-session 状态隔离范式 [ADR-0036]

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

详见 [ADR-0036](docs/adr/0036-session-isolation-map-partition.md)。

### 7.5 对话流状态必须可重开恢复 [HISTORICAL]

**所有进入对话流的状态（消息、系统通知、压缩记录、工具结果等），必须同时满足两条：实时可见 + 重开 session 后仍可见。** 只做到实时可见、重开后消失的，视为未完成。

事故背景：compact 执行后实时反馈缺失 + 重开 session 看不到压缩记录。根因是「实时链路」和「持久化链路」是两条独立的通路，只打通一条会导致：关掉 session 重开后，对话流回到压缩前的状态，用户以为压缩没发生或丢失了数据。

两条通路必须同时维护：

| 通路 | 职责 | 关键检查点 |
|---|---|---|
| **实时链路**（事件/RPC 响应 → 前端消息流） | 操作发生时立即在对话流显示反馈 | runtime 广播 `message.*` 事件携带完整 payload；前端 `chat-message-effects.ts` 有对应 effect 处理 |
| **持久化链路**（session JSONL → 重开加载） | 重开 session 后历史完整呈现 | pi 写入 JSONL 的 entry 类型，runtime 读取时（`session-history.ts` 文件路径 / `message-converter.ts` RPC 路径）**都不能过滤掉**；前端 hydrate 能还原 |

持久化链路的两条读取路径都要覆盖（缺一会导致「在线重开能看到、离线重开看不到」或反之）：

1. **RPC 路径**（session 在线，有 pi 子进程）：`session-service.getHistory` → `client.getHistory()` → pi `get_messages` → `message-converter.ts` 的 `convertPiHistory`。converter 必须处理所有 pi 返回的 message role（`user`/`assistant`/`toolResult`/`compactionSummary`/`branchSummary` 等），不能静默丢弃未知 role。
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

#### pnpm workspace 单步安装（2026-07-04 重构后）
- 项目使用 pnpm workspace（`pnpm-workspace.yaml`），`pnpm install` 一次装完根 + `packages/*` + `apps/*`
- `.npmrc` 配置 `node-linker=hoisted` 保证 Electron 兼容性（详见 ADR-0032）
- `git-cwt` 的 `setup-worktree.sh` 会自动跑 `pnpm install`，手动操作时跑一次即可

#### merge-worktree 脚本的 bare repo 兼容
- 脚本已修复：自动检测 `GH_REPO` 并给所有 `gh` 调用加 `--repo`
- 没有 main worktree 时，用 bare repo（`.bare/`）做 `git --git-dir`
- 版本 bump push 用 `HEAD:refs/heads/main` 而不是 `main`（worktree 中本地没有 main 分支）

Vite 使用 `strictPort: true`（端口 1420 被占则静默失败）。同一机器上另一个进程（main worktree 或其他项目）占 1420 端口时，当前 worktree 的 Vite 不会启动，Electron 加载的是旧代码。现象：代码改了但浏览器不更新，DOM 出现已删除的旧元素。

```bash
# 确认 1420 端口属于当前 worktree
lsof -i :1420 -P | grep node
# 检查进程 cwd 是否指向当前 worktree 的 renderer 目录
```

### 11. Plugin System 架构约束

- **Plugin Service 是唯一的适配层**: 所有前端 ↔ 插件系统通信必须通过 WS → server.ts → PluginService 路径。前端不直接与 Worker 通信
- **Worker Thread 隔离**: 每个插件运行在独立的 Worker Thread 中。插件崩溃不影响其他插件或主进程
- **Hook 串行执行**: executeHooks 按 priority 排序串行 invoke 每个 handler。单个 handler 超时 5s 视为放行。blocked 终止链
- **Tool RPC 路由**: handleBridgeToolExecute 通过 toolRegistry 查找 → Worker RPC invoke（超时 30s）→ 返回结果。不是 stub
- **sessionData 缓存**: 读取走内存缓存，写入先缓存再 5s 定时 flush。Plugin deactivate 时强制 flush。容量上限 10MB/plugin
- **Hot Reload**: 外部插件通过 fs.watch 监听（300ms debounce）。built-in 插件不监听
- **WS 命名约定**: Client→Server 用点号（`plugin.xxx`），Server→Client 用冒号+camelCase（`plugin:statusBarUpdate`）
- **Plugin Store**: 前端使用 `stores/plugin.ts` + `composables/usePlugin.ts` 管理 plugin 状态和 WS 事件
- **数据目录隔离**: `~/.xyz-agent/` 与 `~/.pi/agent/` 完全隔离（已有规则 #10）
- **[HISTORICAL] Builtin pi-extensions 改为 Settings 推荐安装**（2026-07-04 推翻旧规则）：5 个 `@zhushanwen/pi-*` 包（`pi-goal`/`pi-todo`/`pi-subagents`/`pi-workflow`/`pi-structured-output`）**不再作为根 `package.json` dependencies 集成进打包产物**。改为 Settings → Extensions 页面的「推荐扩展」快捷按钮，用户点击从 npm 安装到 `~/.xyz-agent/pi/agent/npm/node_modules/`。
  - 推荐列表 SSOT：`packages/shared/src/recommended-extensions.json`（runtime import，前端经 `extension.recommended` WS 拉取）
  - runtime `ExtensionService.getRecommendedExtensions()` 计算已安装状态（按 npm 包名精确匹配 `ExtensionInfo.name`，不经 normalizeExtName 转换）
  - electron-builder.yml 不再 `extraResources` 拷贝 `@zhushanwen/`，preflight-check.sh 移除了原 npm packages / 传递依赖检查（步骤 7、8）
  - **代价**：新用户首次启动无这些 extension，需到 Settings 手动安装；离线环境无法安装（npm-installer 需联网）
  - 旧规则背景：曾经发生过误删 builtin 依赖导致打包产物缺失的事故，故设禁止删除规则。现改为推荐安装机制后该约束不再适用，但「删除打包所需依赖」的事故教训仍适用于其他 builtin 资源（如 pi binary、xyz-agent-extension.js）
  - **xyz-system-prompt-extension.js**（repo root）：builtin 文件型 pi 扩展，before_agent_start hook 实现系统提示词追加注入。走 `--extension` CLI 注入（extension-service.getExtensionPaths 在 xyz-agent-extension.js 之后追加）。打包走 electron-builder.yml extraResources（`../../xyz-system-prompt-extension.js`），postbuild-validate.sh 校验产物存在性。「删除打包所需依赖」事故教训同样适用
  - extension/skill 都不走 vendor submodule（2026-07-04 移除了 `vendor/xyz-pi-extensions` + `vendor/xyz-harness` 两个 submodule，`prepare-pi-resources.sh` 现只负责下载 pi binary，extensions 走 npm 源、skills 走用户/project 级目录 `~/.agents/skills` / `<cwd>/.pi/agent/skills`）

### 12. Electron 打包约束（违反必出 bug）

#### tsup 配置 (`packages/runtime/tsup.config.ts`)
- `platform: 'node'` + `target` 匹配当前 Electron 内置 Node 版本（见 `packages/runtime/tsup.config.ts`，Electron 42 → Node 24）— 自动处理所有 Node 内置模块 external
- `noExternal` 必须覆盖 **所有** runtime `dependencies` — 新增 npm 依赖时必须同步追加，否则 `asar.unpacked` 运行时 `Cannot find module`
- **Worker 入口必须独立打包**：`plugin-bootstrap.ts` 是 Worker Thread 入口，tsup `entry` 必须包含它，输出为 `plugin-bootstrap.cjs`，与 `index.cjs` 同目录。禁止只打包 `index.ts` 一个 entry
- 禁止在 runtime 源码中使用 `import.meta.url` 或 `fileURLToPath(import.meta.url)` — tsup CJS bundle 将 `import.meta` 替换为 `var import_meta = {}`，`import_meta.url` 始终为 `undefined`。禁止用 `globalThis.__dirname` — CJS 中 `__dirname` 是模块局部变量，不在 `globalThis` 上。正确做法：用 `typeof __dirname !== 'undefined' ? __dirname : undefined` 直接检查 CJS 模块变量，tsup/esbuild 会原样保留到 CJS 输出

#### electron-builder 配置 (`apps/electron/electron-builder.yml`)
- `asarUnpack: dist/runtime/**/*` — runtime 必须在 unpacked 目录，子进程无法读取 asar 内的 JS 文件
- **`files` 与 `asarUnpack` 的致命交互**：`asarUnpack` 只作用于**已被 `files` 包含的文件**。如果 `files` 中用了 `!dist/runtime/**/*` 排除 runtime，asarUnpack 将无文件可解压，导致打包产物中**缺失整个 runtime**。必须确保 `files` 包含 `dist/runtime/**/*`
- `files` 只包含主进程直接 `require` 的 `node_modules`（其余已被 tsup 打包进 runtime bundle）

#### extraResources 与 symlink
- `resources/pi/` 中**禁止存在指向外部绝对路径的 symlink**。electron-builder 的 `extraResources` 复制时保留 symlink，用户机器上目标路径不存在会导致 pi 运行时资源缺失
- 构建前必须 dereference：`cp -RL` 替代 `cp -R`，或脚本中显式将 symlink 替换为真实目录拷贝

#### 子进程启动 (`apps/electron/main/supervisor/runtime-supervisor.ts`)
- 必须用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 启动 runtime，不能用 `node` 路径
- 打包后路径必须用 `process.resourcesPath/app.asar.unpacked/...`，不能用 `app.getAppPath()`（返回 asar 虚拟路径）

#### 打包验证流程（三阶段，缺一不可）
1. **Preflight** (`scripts/preflight-check.sh`)：
   - 产物存在性（dist/main, dist/preload, dist/runtime/index.cjs, dist/runtime/plugin-bootstrap.cjs, renderer/dist）
   - tsup noExternal 与 runtime dependencies 一致性
   - `files` 显式包含 `dist/runtime/**/*`（不只是"未排除"）
   - `files` 未排除 `dist/runtime`（正则扫描 `!dist/runtime` 模式）
   - `resources/pi` 无 symlink
2. **Build** (`npm run build`)：electron-builder 执行打包，产出 dmg/zip/exe
3. **Postbuild** (`scripts/postbuild-validate.sh`)：
   - asar 内容正确性（dist/main/main.cjs, dist/preload/preload.cjs）
   - `app.asar.unpacked/dist/runtime/` 存在且包含 `index.cjs` + `plugin-bootstrap.cjs`
   - `Resources/pi` 无 symlink
   - 产物大小合理性
4. **CI Runtime Smoke Test**（release workflow）：
   - macOS: `ELECTRON_RUN_AS_NODE=1 <electron> <runtime> --port=<random>` → `/health` 返回 ok
   - Windows/Linux: 验证 `app.asar.unpacked/dist/runtime/index.cjs` 存在

#### 打包相关改动规范（违反必出 bug）

**tsup.config.ts、electron-builder.yml、plugin-host.ts、runtime 相关文件的改动必须逐个 commit、逐个验证。** 禁止在一个 commit 中同时修改多个打包子系统。

原因：v0.3.8 的 PR #61 在一个 commit 中同时改了 tsup 配置、electron-builder files、plugin-host 路径解析、plugin-version-checker，引入了两个独立致命 bug，无法定位是哪个改动导致的问题。

正确流程：
1. 每个改动独立 commit
2. 每次 commit 后运行 `bash scripts/validate-runtime-bundle.sh`（含第 6 步 smoke test）
3. 打包配置变更（electron-builder.yml/tsup.config.ts）额外触发 pre-commit 的 runtime bundle 验证

#### 自动验证脚本
- `scripts/preflight-check.sh` — 打包前检查
- `scripts/postbuild-validate.sh` — 打包后验证 + CI 自动拦截
- `scripts/validate-runtime-bundle.sh` — runtime bundle 深度验证（依赖打包、CJS 兼容、Worker bootstrap 存在性、健康检查、plugin 初始化成功）
- pre-commit hook 自动触发 `validate-runtime-bundle.sh`（当 `packages/runtime/src/` 有变更时）

**跳过检查**:
```bash
SKIP_RUNTIME_BUNDLE_CHECK=1 git commit   # 跳过 runtime bundle 验证
SKIP_ALL_CHECKS=1 git commit            # 跳过所有（仅紧急情况）
```

### 13. 目录规范（违反必出 bug）

- **禁止创建 `demos/` 或 `impeccable/` 目录** — 页面设计稿统一放 `docs/page-design/`：v3 正式稿在 `v3/<模块>/draft-*.html`，历史探索稿在 `archive/`。pre-commit hook 自动检查
- **禁止 symlink 指向外部绝对路径** — 项目内 symlink 白名单仅允许 `../` 相对路径（指向同 workspace 内的兄弟 worktree）。外部绝对路径 symlink 打包后目标不存在，导致运行时资源缺失。pre-commit hook 自动检查
- **`.xyz-harness/` 目录必须提交且不能删除** — 该目录存放所有 spec/plan 的历史设计文档（按 `YYYY-MM-DD-<slug>/` 命名），是项目决策追溯的重要依据。禁止 `git rm -r .xyz-harness/` 或将其加入 `.gitignore`
- **`DESIGN.md` 必须保留在项目根目录** — ~~产品设计系统的核心定义文件~~（已 DEPRECATED by ADR-0018，Warm & Soft 被推翻）。真身设计系统见 `docs/page-design/design-tokens.md` + `docs/page-design/design-system.md`（v3 冷蓝暗色）。文件保留作历史参考，不作为当前规范

### 14. 项目 skill 必须自包含 [HISTORICAL]

**项目维度 skill（`.agents/skills/`）引用的所有脚本必须复制到项目 skill 目录内，禁止依赖全局脚本目录（`~/.agents/skills/`）或 symlink。**

- **根因**：项目 skill 依赖全局脚本时，全局脚本变更会悄悄影响项目行为（如 pre-merge-check.sh 改了 remote 检查逻辑），且 bare repo workspace 项目的 remote 语义（`origin`=本地 bare repo，`github`=真正远程）与通用脚本不一致，导致检查误报。全局脚本不随项目 git 跟踪，无法保证可复现。
- **规则**：
  1. 项目 skill 需要的脚本 → 复制到 `.agents/skills/<skill-name>/scripts/` 下，随 git 跟踪推送
  2. SKILL.md 里的路径引用 → 用项目内相对路径（`.agents/skills/merge/scripts/pre-merge-check.sh`），不用 `~/.agents/...`
  3. 禁止用 symlink 指向全局脚本（symlink 不随 git 跟踪，且违反 §13 外部 symlink 禁令）
  4. 如果复制的脚本有问题（如 remote 检查逻辑不适用本项目），直接改项目内副本，不影响全局
- **事故记录**：2026-07-22 merge 流程阶段 1 pre-merge-check.sh 报"有未推送 commits"误报。根因是全局脚本检查 `origin/$BRANCH`（bare repo），但实际推送到 `github/$BRANCH`。修复方式：复制脚本到项目内，改为优先检查 `github` remote（bare repo workspace），fallback `origin`（普通 repo）
- **当前项目内自包含脚本**：`.agents/skills/merge/scripts/` 含 init.sh / pr-merge.sh / pre-merge-check.sh / release.sh / remove-worktree.sh / wait-for-ci.sh（全部 git 跟踪）

### 15. git status untracked 目录展开 [HISTORICAL]

`GitService.getStatus` 执行 `git status --porcelain=v1 -z -b` **必须带 `--untracked-files=all`**。

- **根因**：默认 git 把整个 untracked 目录折叠成一行 `?? dir/`（**带尾斜杠**）。文件树 `FileNode.path` 无尾斜杠，两者失配 → overlay key 查不到 → 目录徽章误显（前缀匹配命中自身那条带斜杠记录）、展开后子文件无角标无行数（git 根本没报告这些文件）。
- **修复**：`--untracked-files=all`（`-uall`）强制展开每个 untracked 文件到文件级（`dir/file.py`，无尾斜杠），与 `FileNode.path` 格式一致。`.gitignore` 仍生效，只展开未忽略的 untracked 文件，不会因 node_modules 等爆量。
- **修改位置**：`packages/runtime/src/services/git-service.ts` getStatus 的 status 命令。commit 用 `git diff --numstat HEAD`（不受此约束，numstat 只管 tracked 改动）。
- **测试基线**：`git-service.test.ts` 的 `status 命令带 --untracked-files=all 展开未跟踪目录到单文件` 用例断言了命令参数。

## 测试规范 [HISTORICAL]

> **执行测试或设计测试计划前，先读 [TEST-STRATEGY.md](TEST-STRATEGY.md)（分层策略/mock 策略/回归基线 SSOT）+ [docs/testing/](docs/testing/) 对应功能文档**（各页面组件的 MOCK/非MOCK 测试步骤 + Playwright E2E 调用链 + 每步期望输入输出 + 已知坑）。docs/testing/ 00 总览是入口篇。复用已有 testid 清单/调用链/fixture 数据/历史踩坑经验，不从零重新探索——这些文档记录了 mock 回显双匹配、thinking 收起态 v-if 时序、initApp 预填 cwd 等仅靠读组件代码无法发现的运行时行为。

1. **测试框架用 vitest，禁止 `node:test`**：`packages/runtime/` 子项目使用 vitest（配置在 `packages/runtime/vitest.config.ts`，依赖 `vitest@^4.1.6`，test script 为 `vitest run`）。所有测试文件必须从 `vitest` 导入 `describe/it/expect/vi/beforeEach` 等，禁止从 `node:test` 导入。vitest 不识别 `node:test` 格式的测试，会导致 "No test suite found" 错误。

2. **运行测试命令**: `npx vitest run <test-file>`，不是 `tsx --test`。虽然 `tsx --test` 能正常运行（不会卡住），但它跑的是 node:test 原生 runner，不支持 vitest 的 mock（`vi.fn()`/`vi.useFakeTimers()`）和配置（vitest.config.ts）。项目 CI 和开发流程都用 vitest。

3. **测试超时**: vitest 单个测试默认 5s 超时。涉及 setTimeout/timer 的测试必须使用 `vi.useFakeTimers()` + `vi.advanceTimersByTime()` 而不是真实等待，避免超时失败。

4. **subagent task prompt 必须明确测试框架**: 派遣编码 subagent 时，task prompt 中必须写明 "测试框架使用 vitest（从 vitest 导入 describe/it/expect/vi），运行命令 npx vitest run，禁止 node:test 和 tsx --test"。

### 测试视角与覆盖质量 [HISTORICAL — 2026-06-27「新建任务」事故]

> 事故：「新建任务」功能 77 单测 + 24 集成全绿、vue-tsc/tsc EXIT 0、verdict pass，用户手动打开却发现 Landing 态根本没有 composer 输入区——阻塞级 bug。根因：测试只做了构建者（白盒）视角（验状态机/API 契约），缺使用者（黑盒：能否完成目标）与观察者（形态：渲染长什么样）两个视角。

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
2. **禁止 Emoji** — 使用 inline `<svg>` 或 lucide-vue-next 图标
3. **样式统一 Tailwind 类（三层结构）**
   - **Design tokens**（`style.css`）：只放 `:root` / `[data-theme]` 的 CSS 变量和 base reset，不放组件样式
   - **Template class**（组件模板）：组件样式统一使用 Tailwind 工具类（`class="flex items-center gap-2 ..."`），不在 `style.css` 或 `<style scoped>` 中写组件样式
   - **Escape hatch**（`<style scoped>`）：只用于 Tailwind 无法表达的场景：伪元素（`::placeholder`）、后代选择器（`.msg__body p`）、Vue Transition 类（`.xxx-enter-from`）
   - 禁止 `@apply`，禁止在 `style.css` 中新增组件级样式规则
4. **行数上限** — `<template>` ≤ 400 行, `<script setup>` ≤ 300 行
5. **禁止 `any`** — 用 `unknown` 或具体类型
6. **v-model 绑定** — 禁止 `:value` + `@input`，用 `v-model`
7. **Promise.allSettled** — 独立数据源用 `allSettled`，不用 `all`
8. **禁止硬编码颜色** — 用 CSS 变量（`var(--accent)`）或语义 Tailwind 类
9. **禁止魔数间距** — 用标准 Tailwind scale，不用 `p-[17px]`
10. **border-radius 遵循 v3 design-tokens**（`--radius-sm:3px` / `--radius:8px` / `--radius-lg:12px`）— `rounded-sm`(3px) 默认，`rounded-md`/`rounded-lg`(8/12px) 特殊场景。SSOT 见 [docs/page-design/design-tokens.md](docs/page-design/design-tokens.md)，裁决依据 ADR-0018（旧 Warm 时期的 1px/2px 规则已推翻）。详见 docs/standards.md §7.1
11. **窗口顶部 traffic light 安全区（v3 shell 拓扑）** — v3 重建采用 zcode-demo 拓扑：base 平铺全屏 → sidebar 透明融合 → main 是唯一 float-panel 浮起。traffic light 靠 **aside-region 顶部留白**兼容，而非旧版 padding-left 避让。具体要求：
    - `.aside-region` 恒定 `padding-top: 52px`（安全区），**三平台统一，全屏也保留**（mac 全屏 hover 时系统下拉覆盖层会落进这块留白）
    - mac 红黄绿位置由主进程 `titleBarStyle:'hidden'` + `trafficLightPosition:{x:16,y:26}` 精确控制（**不用 hiddenInset**——inset 模式强制水平内缩，`trafficLightPosition.x` 被系统忽略）；win/linux 自绘圆点 `left:16px top:26px`（TrafficLight.vue，与 mac 同位）
    - app-nav-controls（收起侧栏/←/→）浮在 aside 安全区，**非折叠态** `left:100px top:21px`，全屏 `left:16px`（320ms 平移与 traffic-light opacity 同步）。三处 chrome（红黄绿 / 浮层按钮 / PanelHeader 内按钮）统一对齐到 header 中线 y=32px
    - **折叠态** chrome 迁入 P1 PanelHeader 内（header `pl-[88px]` 让位），与浮层位置一致（按钮起 x=100），切换折叠无跳动；AppShell 折叠态 `!gap-0`（强制覆盖 gap-3，否则 MainPanel 左右不对称）
    - 全屏两态：非全屏（traffic light opacity 1，按钮 left:100px）/ 全屏（opacity 0，按钮左移）。**无第三态**，mac 全屏 hover 红黄绿由系统提供，应用不渲染
    - win/linux 走 mimic_mac：自绘彩色圆点放左侧模拟 mac，三平台左上视觉统一
    - 唤回侧栏：⌘B + header chrome 按钮（**rail-restore 左缘细条已移除**）
    - 新增或修改任何窗口顶部区域 UI 时，必须读 [shell spec](docs/page-design/v3/shell/spec.md) 确认拓扑一致
    - 设计决策记录：[ADR 0016](docs/architecture/adr/0016-macos-traffic-light-safe-zone.md)（旧版 padding-left 方案，**已 Superseded**）、[v3 shell spec](docs/page-design/v3/shell/spec.md)（现版 SSOT，2026-06-18 修正）
12. **reka ScrollAreaViewport 默认 `overflow-x: hidden` [HISTORICAL]** — reka-ui 的 `ScrollAreaViewport` 内联注入 `overflow-x: hidden`，横向溢出的内容被**裁掉不滚动**（非 `scroll` 也非 `auto`）。文件树等需横向滚动看长文件名的场景，必须给 `ScrollArea` 传 `horizontal` prop（`src/components/ui/scroll-area/ScrollArea.vue`，渲染额外横向 ScrollBar + 用 `!overflow-x-auto` 覆盖内联 style）。覆盖用 Tailwind `!` 前缀（`!important` 压过 inline）；scoped `<style>` 的 `:deep()` 不行——会注入 `<style>` 元素破坏 reka Root 的子组件渲染顺序，导致 ScrollBar/Corner 不挂载

### 自动化检查

| 检查工具 | 覆盖范围 | 触发时机 |
|---------|---------|---------|
| taste-lint (ESLint) | no-native-html / no-emoji / prefer-v-model / no-hardcoded-colors / no-magic-spacing / no-silent-catch / prefer-allsettled / no-multi-arg-emit | `npm run lint` + pre-commit |
| vue_rules_checker.py | 行数上限 / CSS 选择器 / Tab 缩进 / 原生元素 / Emoji / v-model | pre-commit |

### Lint / Git Hooks 问题处理原则 [MANDATORY]

**lint（ESLint / vue_rules_checker）或 githooks（pre-commit 的任何 check_*.py）检出的问题，必须全部正面修复，不得跳过。**

- **不得以“非本次改动引入”为由跳过**：存量问题同样要修。携改动的 commit 触发了检查，检查出的所有问题都是本次提交的责任范围。
- **不得用 `SKIP_*` 变量绕过**（`SKIP_FRONTEND_LINT` / `SKIP_CODE_RULES_CHECK` / `SKIP_ALL_CHECKS` 等）— 仅限线上故障热修复等紧急场景，且必须在 commit message 说明原因。
- **不得仅“消除报错”而不解决根因**：例如把原生 `<button>` 改成 `<Button>` 是正面修复；但把检测规则改成“放过该写法”只有在确认规则误报时才可（且须在规则中加注释说明）。
- **规则误报的唯一正当处理**：修正规则本身使其准确（如 reka-ui `SelectItem :value` 是选项值语义，应排除），并在规则文件加 `[HISTORICAL]` 注释记录原因。禁止用 `// eslint-disable-next-line` 局部静默。
- pre-commit 每个检查失败分支已内置提示：“无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过”。


## 架构约定

- **视图切换**: 状态驱动（settingsStore.currentView），不用 vue-router
- **Mock 模式**: `VITE_MOCK=true` 环境变量控制，在 ws-client 层拦截
- **共享类型**: `packages/shared/src/` 通过 npm workspace 在前端和 runtime 间共享
- **Runtime 通信**: WebSocket，前端通过 `ws-client.ts` + `event-bus.ts` 消息分发
- **Electron IPC**: 主进程通过 preload 暴露 `window.electronAPI`，渲染进程不直接使用 `ipcRenderer`
- **Runtime broadcast 时序竞争 [HISTORICAL]**: session 级 broadcast（如 `session.commands`）若在 session 激活/创建流程内部发出（`ensureActive`/`lifecycle.create` 内的 `fetchAndBroadcastCommands`），会**早于** renderer 订阅该 sessionId 通道——订阅依赖 `switchSession`/`create` 的 RPC resolve → `activeId`/`currentSessionId` 更新 → `CommandPopover` 的 `watch(sessionId)` 重订，而 broadcast 已在此之前发出 → 消息丢失，renderer transport 只收到同流程的 `reply`（RPC 响应，走 pending map，不依赖订阅）。**约束：renderer 切换/创建 session 后需立即消费的 session 级状态，必须主动拉取**（新增 `session.getCommands` RPC，`useSidebar.selectSession` / `useNewTaskFlow.precreateSessionAndLoadCommands` 在 session 建立后调它 + `events.dispatchSession` 本地投递），不可依赖 broadcast 到达。新增任何 session 级 broadcast 必须对照本条评估。

## 发布与 CI 验证 [HISTORICAL]

每次 push tag 触发 CI（release workflow）构建 Electron 产物后，**必须等待 CI 完成并验证产物存在**。多次发生 AI push 后直接宣布"已完成"，实际 CI 构建失败或产物缺失而无人察觉。

### [MANDATORY] 必须遵守的规则

**错误做法（禁止）：**
```
# 坏 — push 后直接结束
npm version patch && git push github HEAD --tags
echo "已推送，CI 会构建"
# ← AI 在此结束，不检查 CI 结果
```

**正确做法：**
```
# 好 — push 后必须验证
npm version patch && git push github HEAD --tags
bash scripts/verify-ci-release.sh "v$(node -p "require('./package.json').version")"
# ← 脚本会轮询 CI 直到完成，验证 dmg/exe/AppImage 存在
# ← exit 0 = 通过，exit 非 0 = 失败（AI 必须修复直到 exit 0）
```

### 适用场景

| 操作 | 验证命令 |
|------|---------|
| 预发布测试 | `scripts/prerelease-test.sh` 内置自动验证 |
| 正式发布（merge） | `bash scripts/verify-ci-release.sh v<version>` |
| 手动 push tag | `bash scripts/verify-ci-release.sh <tagname>` |

### 验证失败时的处理

脚本 exit 非 0 意味着：
1. CI workflow 未完成或失败 → 打开 CI 链接排查
2. Release 未创建 → 检查 release.yml 是否正常触发
3. 产物缺失 → 检查对应平台构建日志

**禁止行为**：说"CI 可能还在跑"或"应该没问题"后结束。必须等脚本 exit 0。



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

**[HISTORICAL] 背景**：handoff 2026-07-04 P1「pi 静默卡死」——坏 session 的 JSONL 只有 2 行、零 message，pi 子进程 0% CPU 不退出。runtime 发了 prompt 后 pi 发了什么事件（或什么都没发）无法事后追溯，因为日志只在 concurrently 终端，关掉即丢。此条目把「日志必须落盘」固化为规范，避免再次因证据丢失而无法定位。实现见 commit（logger.ts + index.ts initLogger + rpc-client.ts pi stdout tee）。

## 跳过检查

> **默认禁止跳过**（见上文「Lint / Git Hooks 问题处理原则 [MANDATORY]」）。以下变量仅供线上热修复等紧急场景，使用时必须在 commit message 说明原因。

```bash
SKIP_ALL_CHECKS=1 git commit       # 跳过所有（仅紧急情况）
SKIP_FRONTEND_LINT=1 git commit    # 跳过 ESLint
SKIP_CODE_RULES_CHECK=1 git commit # 跳过 vue_rules_checker
SKIP_ENV_WHITELIST_CHECK=1 git commit   # 跳过 ENV 白名单同步检查
SKIP_PATH_WHITELIST_CHECK=1 git commit   # 跳过路径白名单动态化检查
SKIP_DIRECTORY_RULES_CHECK=1 git commit  # 跳过目录规范检查（禁止 demos/impeccable + 外部 symlink）
```
