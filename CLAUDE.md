# xyz-agent CLAUDE.md

## 项目概述

xyz-agent 是基于 Electron + Vue 3 + Node.js Sidecar 的 AI Agent 桌面工作台。架构：

- **Electron 主进程** (`src-electron/main/`): 窗口管理、sidecar 进程生命周期、快捷键
- **Preload** (`src-electron/preload/`): 安全桥接，暴露 `electronAPI` 给渲染进程
- **前端渲染进程** (`src-electron/renderer/src/`): Vue 3 + TypeScript + Pinia + Tailwind CSS v3 + xyz-ui 组件库
- **Sidecar** (`src-electron/sidecar/src/`): Node.js WebSocket 服务，通过子进程 RPC 与 pi 通信
- **共享类型** (`src-electron/shared/src/`): 前端与 sidecar 之间的 TypeScript 类型定义

**完整编码规范**: [docs/standards.md](docs/standards.md)

**功能开发地图**: [docs/feature-map/](docs/feature-map/) — 长期功能规划、现状盘点、待开发阶段、关键决策点、完整资料链接
  - 每次启动新 Phase 前更新地图，确认当前阶段和优先级
  - 构建能力地图和架构图时，从该目录获取全貌
  - 最新版本: [2026-05-19.md](docs/feature-map/2026-05-19.md)

**规范与设计文档**:
- [完整编码规范](docs/standards.md) — 组件使用、样式规则、TypeScript 约束
- [设计系统](docs/design-system.md) — CSS 变量、颜色体系、排版规则
- [设计系统详细参考](docs/designs/docs_DESIGN-SYSTEM.md) — 完整的设计 token、组件规范
- [竞品 UI 分析](docs/templates/competitor-ui-analysis.md) — Claude Code / Codex 逐图拆解，7 条设计原则
- [UI/UX 设计原则与参考](docs/templates/ui-design-principles-and-references.md) — 设计方法论 + 竞品案例 + 行动清单
- [设计方向](docs/templates/design-direction.md) — 产品定位、主题策略、窗口架构、实施优先级
- [暗色主题选项 demo](docs/templates/dark-theme-options.html) — 5 种彩色 accent 方案对比
- [朴素锐利主题 demo](docs/templates/muted-sharp-themes.html) — 5 种低饱和/无彩色方案对比

**UI Demo 目录**: `docs/designs/` — 所有 UI 设计 demo（HTML 文件），按 `views_<模块>.html` 命名
  - 聊天界面: [views_chat.html](docs/designs/views_chat.html) — 含 SlashMenu、skill 标签、消息气泡三种状态
  - Settings Skills: [views_settings-skills.html](docs/designs/views_settings-skills.html)

**外部项目源码**:
- **xyz-pi（fork 版本）**: [zhushanwen321/pi](https://github.com/zhushanwen321/pi) — 基于 [pi](https://github.com/nicepkg/pi-coding-agent) 的 fork，增加了 session tree 透出（`leafId` in `get_state`）等定制功能
  - **重要**: xyz-agent **不能**使用原版 pi，必须使用 fork 版本。原版 pi 不支持 `leafId` 字段，会导致 session tree 功能失效
  - npm 包: `xyz-pi`（区别于原版 `@mariozechner/pi`）
  - 本地源码: `~/Code/pi-mono-workspace/`（bare repo + worktree 模式）
  - 当前版本: `0.75.5-xyz-0.1`
  - fork 关键改动: `get_state` RPC 响应中增加 `leafId` 字段，用于 session tree 导航
  - Skill 加载: `packages/coding-agent/src/core/skills.ts`
  - Skill 展开: `packages/coding-agent/src/core/agent-session.ts` — `_expandSkillCommand()`
  - Slash 命令: `packages/coding-agent/src/core/slash-commands.ts`
  - RPC 协议: `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
  - TUI 交互: `packages/coding-agent/src/modes/interactive/interactive-mode.ts`

**Settings 模块设计文档**:
- [Settings 视觉 demo](docs/designs/settings-final.html) — Section Groups 风格的最终 HTML demo
- [Settings spec](.xyz-harness/2026-05-12-settings-redesign/spec.md) — 需求规格（WS 协议、数据流、组件结构）
- [Settings plan](.xyz-harness/2026-05-12-settings-redesign/plan.md) — 实现计划（12 个 Task）

## 常用命令

```bash
npm run dev          # 开发模式 (Electron + Vite HMR)
npm run build        # 生产构建 (electron-builder)
npm run lint         # ESLint 检查
npm run prepare      # 安装 git hooks
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

### 7. Session 隔离：所有消息必须带 sessionId

所有 sidecar → 前端的消息，如果涉及特定 session，`payload` 必须包含 `sessionId`。前端靠 `payload.sessionId` 路由到正确的 panel/store 分区。**缺失 `sessionId` 的消息应被忽略**，否则会广播到所有 panel。

三层隔离机制：

| 层 | 职责 | 位置 |
|---|---|---|
| ChatStore 分区 | `chatSessions: Map<sessionId, ChatSessionState>`，所有操作要求显式 sessionId | `stores/chat.ts` |
| useChat 全局路由 | 事件处理器从 `msg.payload.sessionId` 提取 sid，路由到 store 分区 | `composables/useChat.ts` |
| PaneSessionView 过滤 | 组件级事件监听（error、compacted 等）严格按 `props.sessionId` 过滤 | `PaneSessionView.vue` |

Sidecar 侧：`server.ts` 的 `sendError` 必须传入 `sessionId`（外层 catch 从原始消息 `msg.payload.sessionId` 提取）。不带 `sessionId` 的 error 会被前端所有 panel 忽略。

### 8. Worktree 创建必须走 `git-cwt`

创建新 worktree **必须使用 `git-cwt`**（`~/.shell/07-git-ws.sh`），不要手动 `git worktree add`。

- `git-cwt` 调用 `.bare/custom-hooks/setup-worktree.sh`，该脚本执行：根目录 `npm install` + `src-electron/` 的 `npm install`（`ELECTRON_SKIP_BINARY_DOWNLOAD=1`）+ Electron dist 缓存复用
- `src-electron/` 是独立 npm project（不在根 workspaces 里），手动创建的 worktree 缺少 `concurrently`、`electron` 等依赖
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

#### `src-electron/` 依赖需要单独安装
- `src-electron/` 是独立 npm project（不在根 workspaces 里）
- `pre-merge-check.sh` 和 `npm ci` 只装根目录依赖
- 需要 `cd src-electron && ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install`
- `git-cwt` 的 `setup-worktree.sh` 会自动处理，但手动操作时容易遗漏

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
10. **border-radius 默认 1px，特殊场景 2px** — 用 `rounded-sm`(1px) 为默认。`rounded-md`/`rounded-lg`(2px) 仅特殊场景。禁止其他值。详见 docs/standards.md §7.1

### 自动化检查

| 检查工具 | 覆盖范围 | 触发时机 |
|---------|---------|---------|
| taste-lint (ESLint) | no-native-html / no-emoji / prefer-v-model / no-hardcoded-colors / no-magic-spacing / no-silent-catch / prefer-allsettled / no-multi-arg-emit | `npm run lint` + pre-commit |
| vue_rules_checker.py | 行数上限 / CSS 选择器 / Tab 缩进 / 原生元素 / Emoji / v-model | pre-commit |


## 架构约定

- **视图切换**: 状态驱动（settingsStore.currentView），不用 vue-router
- **Mock 模式**: `VITE_MOCK=true` 环境变量控制，在 ws-client 层拦截
- **共享类型**: `src-electron/shared/src/` 通过 npm workspace 在前端和 sidecar 间共享
- **Sidecar 通信**: WebSocket，前端通过 `ws-client.ts` + `event-bus.ts` 消息分发
- **Electron IPC**: 主进程通过 preload 暴露 `window.electronAPI`，渲染进程不直接使用 `ipcRenderer`

### 10. xyz-agent 数据目录与 pi 数据目录完全隔离

xyz-agent 的数据目录（`~/.xyz-agent/`）与 pi 的数据目录（`~/.pi/agent/`）必须完全隔离。不得读写 pi 的 extension/skill/config 目录，不得复用 pi 的包管理命令管理 xyz-agent 的 extension。两边的 extension 列表、配置、安装状态互不影响。Extension 通过 `--extension` CLI 参数在 pi 启动时注入路径，pi 原生 loader 加载。

## 跳过检查

```bash
SKIP_ALL_CHECKS=1 git commit       # 跳过所有（仅紧急情况）
SKIP_FRONTEND_LINT=1 git commit    # 跳过 ESLint
SKIP_CODE_RULES_CHECK=1 git commit # 跳过 vue_rules_checker
```
