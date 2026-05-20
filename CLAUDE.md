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
- pi 源码: `~/GitApp/pi-mono/` — AI coding agent 引擎，xyz-agent 的 sidecar 通过 RPC 调用 pi
  - Skill 加载: `packages/coding-agent/src/core/skills.ts` — skill 发现、加载、格式化
  - Skill 展开: `packages/coding-agent/src/core/agent-session.ts` — `_expandSkillCommand()` 将 `/skill:name` 展开为 `<skill>` XML 块
  - Slash 命令: `packages/coding-agent/src/core/slash-commands.ts` — 内置命令定义
  - RPC 协议: `packages/coding-agent/src/modes/rpc/rpc-mode.ts` — RPC 模式命令处理
  - TUI 交互: `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — TUI 模式完整交互

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

### 6. Session 隔离：所有消息必须带 sessionId

所有 sidecar → 前端的消息，如果涉及特定 session，`payload` 必须包含 `sessionId`。前端靠 `payload.sessionId` 路由到正确的 panel/store 分区。**缺失 `sessionId` 的消息应被忽略**，否则会广播到所有 panel。

三层隔离机制：

| 层 | 职责 | 位置 |
|---|---|---|
| ChatStore 分区 | `chatSessions: Map<sessionId, ChatSessionState>`，所有操作要求显式 sessionId | `stores/chat.ts` |
| useChat 全局路由 | 事件处理器从 `msg.payload.sessionId` 提取 sid，路由到 store 分区 | `composables/useChat.ts` |
| PaneSessionView 过滤 | 组件级事件监听（error、compacted 等）严格按 `props.sessionId` 过滤 | `PaneSessionView.vue` |

Sidecar 侧：`server.ts` 的 `sendError` 必须传入 `sessionId`（外层 catch 从原始消息 `msg.payload.sessionId` 提取）。不带 `sessionId` 的 error 会被前端所有 panel 忽略。

### 7. Worktree 创建必须走 `git-cwt`

创建新 worktree **必须使用 `git-cwt`**（`~/.shell/07-git-ws.sh`），不要手动 `git worktree add`。

- `git-cwt` 调用 `.bare/custom-hooks/setup-worktree.sh`，该脚本执行：根目录 `npm install` + `src-electron/` 的 `npm install`（`ELECTRON_SKIP_BINARY_DOWNLOAD=1`）+ Electron dist 缓存复用
- `src-electron/` 是独立 npm project（不在根 workspaces 里），手动创建的 worktree 缺少 `concurrently`、`electron` 等依赖
- Electron dist 缓存在 `<workspace>/.electron-dist-cache/`，新 worktree 通过 symlink 复用
- 删除 worktree 不影响缓存，后续 `git-cwt` 新建时自动从缓存链接

### 8. 多 Worktree 端口冲突排查

Vite 使用 `strictPort: true`（端口 1420 被占则静默失败）。同一机器上另一个进程（main worktree 或其他项目）占 1420 端口时，当前 worktree 的 Vite 不会启动，Electron 加载的是旧代码。现象：代码改了但浏览器不更新，DOM 出现已删除的旧元素。

```bash
# 确认 1420 端口属于当前 worktree
lsof -i :1420 -P | grep node
# 检查进程 cwd 是否指向当前 worktree 的 renderer 目录
```

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

## 跳过检查

```bash
SKIP_ALL_CHECKS=1 git commit       # 跳过所有（仅紧急情况）
SKIP_FRONTEND_LINT=1 git commit    # 跳过 ESLint
SKIP_CODE_RULES_CHECK=1 git commit # 跳过 vue_rules_checker
```
