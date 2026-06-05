---
verdict: pass
complexity: L1
---

# Chat Area 第一轮优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为聊天区域实现 9 项高价值改进（消息操作菜单、批量选择、分支指示、Utility Rail、侧边栏折叠、macOS 全屏布局、发送模式状态栏、Fork/Clone 命名），覆盖 12 条验收标准，不涉及架构重构。

**Architecture:** 以前端 Vue 组件 + Pinia store 改动为主（8/9 项），辅以 1 项 WS 协议扩展（`message.steer` / `message.follow_up`）和 1 项后端 session 命名修改（fork/clone 后缀）。`PanelBody` 引入 flex row 布局以容纳新增的 `utility-rail` 列。

**Tech Stack:**
- 前端: Vue 3 + TypeScript + Pinia + Tailwind CSS v3 + lucide-vue-next
- 后端: Node.js + WebSocket (sidecar) + pi-coding-agent RPC
- 共享类型: TypeScript protocol types in `src-electron/shared/src/protocol.ts`

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `src-electron/renderer/src/components/chat/MessageActionMenu.vue` | create | FG1 | 消息操作菜单（FR1） |
| `src-electron/renderer/src/components/chat/MessageBubble.vue` | modify | FG1 | 添加 `⋯` 按钮 + 分支 pill (FR1, FR4) |
| `src-electron/renderer/src/lib/collectMessageContent.ts` | create | FG1 | 消息内容收集工具 (FR2, FR3) |
| `src-electron/renderer/src/lib/clipboard.ts` | create | FG1 | 剪贴板写入 + Toast 反馈封装 (FR2, FR3) |
| `src-electron/renderer/src/components/chat/BatchSelectBar.vue` | create | FG1 | 批量选择浮动栏 (FR3) |
| `src-electron/renderer/src/components/panel/PanelBar.vue` | modify | FG1 | 添加 `≡` 批量选择入口 (FR3) |
| `src-electron/renderer/src/components/chat/BranchIndicator.vue` | create | FG1 | 分支 pill + dropdown (FR4) |
| `src-electron/renderer/src/components/chat/UtilityRail.vue` | create | FG2 | 36px 滚动导航列 (FR5) |
| `src-electron/renderer/src/components/panel/ChatPanel.vue` | modify | FG2 | 引入 utility-rail + PanelBody flex 改造 (FR5, FR12) |
| `src-electron/renderer/src/components/panel/PanelBody.vue` | modify | FG2 | 改为 flex row 容纳 rail (FR5) |
| `src-electron/renderer/src/components/sidebar/index.ts` | modify | FG3 | 折叠状态 store + 宽度过渡 (FR6) |
| `src-electron/renderer/src/components/sidebar/SidebarCollapseHandle.vue` | create | FG3 | 右边缘手柄 + 左边缘 ▸ 按钮 (FR6) |
| `src-electron/renderer/src/components/sidebar/SidebarHeader.vue` | create | FG3 | header 右上角 `◀` 按钮 (FR6) |
| `src-electron/renderer/src/stores/sidebar.ts` | create | FG3 | sidebar 折叠状态 (FR6) |
| `src-electron/renderer/src/style.css` | modify | FG4 | macOS fullscreen layout 样式 (FR7) |
| `src-electron/renderer/src/App.vue` | modify | FG4 | fullscreen class 切换逻辑 (FR7) |
| `src-electron/main/window-manager.ts` | modify | FG4 | 注册 fullscreen 事件，IPC 通知 renderer (FR7) |
| `src-electron/preload/index.ts` | modify | FG4 | 暴露 fullscreen 状态 API (FR7) |
| `src-electron/renderer/src/components/chat/SendModeStatusBar.vue` | create | FG5 | 20px 发送模式状态栏 (FR8) |
| `src-electron/renderer/src/components/chat/ChatInput.vue` | modify | FG5 | Alt 键检测 + 模式切换 + 状态栏集成 (FR8) |
| `src-electron/shared/src/protocol.ts` | modify | FG5 | 新增 `message.steer` / `message.follow_up` 类型 (FR8) |
| `src-electron/runtime/src/server.ts` | modify | FG5 | 处理 `message.steer` / `message.follow_up` (FR8) |
| `src-electron/runtime/src/services/session-service.ts` | modify | FG6 | `rebindAfterFork` 接收 label 参数 (FR9) |
| `src-electron/runtime/src/services/tree-service.ts` | modify | FG6 | `forkFromEntry` / `cloneSession` 传递 label (FR9) |
| `src-electron/runtime/src/tree-message-handler.ts` | modify | FG6 | fork 路径传 label；clone 路径 rename (FR9, AC10 关键编排层) |
| `src-electron/renderer/src/components/chat/MessageActionMenu.vue` | modify | FG1 | Fork/Clone 菜单项 (FR1, FR9) |
| `tests/components/chat/MessageActionMenu.spec.ts` | create | FG1 | 菜单交互测试 |
| `tests/components/chat/UtilityRail.spec.ts` | create | FG2 | rail 滚动逻辑测试 |
| `tests/lib/collectMessageContent.spec.ts` | create | FG1 | 内容收集测试 |
| `tests/lib/clipboard.spec.ts` | create | FG1 | 剪贴板写入测试 |
| `tests/services/session-service.spec.ts` | create | FG6 | fork/clone label 测试 |

---

## Interface Contracts

### Module: `@/lib/collectMessageContent`

#### Function: `collectMessageContent`

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| collectMessageContent | `(messageEl: HTMLElement, opts?: { format?: 'markdown' \| 'plain' }) => string` | string | 无 thinking/tool call 时只返回正文；plain 模式 strip markdown 符号 | AC2, AC4 |

### Module: `@/lib/clipboard`

#### Function: `copyWithToast`

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| copyWithToast | `(text: string, opts?: { format?: 'markdown' \| 'plain' }) => Promise<void>` | Promise<void> | clipboard 写入失败 → Toast 错误 | AC2, AC4 |

### Module: `runtime/services/session-service`

#### Class: `SessionService`

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| rebindAfterFork | `(oldSessionId: string, newSessionId: string, label: string, sessionFilePath?: string) => Promise<void>` | Promise<void> | label 已含 `-fork`/`-clone` 后缀 | AC10 |

### Module: `runtime/services/tree-service`

#### Class: `TreeService`

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| forkFromEntry | `(sessionId: string, entryId: string, labelSuffix?: string) => Promise<ForkResult>` | Promise<ForkResult> | 默认 suffix = `-fork` | AC10 |
| cloneSession | `(sessionId: string, labelSuffix?: string) => Promise<ForkResult>` | Promise<ForkResult> | 默认 suffix = `-clone` | AC10 |

### Module: `shared/protocol`

#### Type: `ClientMessageMap` (新增, FR8)

| Field | Type | Description | Spec Ref |
|-------|------|-------------|----------|
| 'message.steer' | `{ sessionId: string; content: string }` | 流式时中断并发送新消息 | FR8, AC11 |
| 'message.follow_up' | `{ sessionId: string; content: string }` | 排队新消息（不中断当前） | FR8, AC11 |

#### Type: `ClientMessageMap` (existing, 引用, FR9)

| Field | Type | Description | Spec Ref |
|-------|------|-------------|----------|
| 'session.tree-fork' | `{ sessionId: string; entryId: string }` | Fork 当前 entry（FR9 入口） | AC10 |
| 'session.tree-clone' | `{ sessionId: string }` | 克隆当前 session（FR9 入口） | AC10 |

### Module: `@/stores/sidebar`

#### Data: `SidebarState`

| Field | Type | Description |
|-------|------|-------------|
| collapsed | boolean | 侧边栏是否折叠 |

#### Actions

| Action | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| toggle | `() => void` | void | 状态取反 | AC8 |
| setCollapsed | `(value: boolean) => void` | void | 直接设置 | AC8 |

### Module: `@/components/chat/SendModeStatusBar`

#### Computed: `mode`

| Mode | Trigger | Display | Send Action |
|------|---------|---------|-------------|
| 'send' | 默认 | `Send · Enter 发送`（灰色） | message.send |
| 'steer' | 流式时 | `Steer · 将中断当前 AI 处理`（accent） | message.steer |
| 'queue' | Alt 键按下 | `Queue · Alt+Enter 排队`（warning） | message.follow_up |

---

## Task List

| # | Task | Type | Depends on | Group |
|---|------|------|-----------|-------|
| 1 | 创建 `collectMessageContent` + `clipboard` 工具函数 | frontend | — | FG1 |
| 2 | 创建 `MessageActionMenu` 组件 | frontend | 1 | FG1 |
| 3 | 修改 `MessageBubble` 集成 `⋯` 按钮 | frontend | 2 | FG1 |
| 4 | 创建 `BatchSelectBar` 组件 | frontend | 1, 3 | FG1 |
| 5 | 修改 `PanelBar` 添加 `≡` 入口 | frontend | 4 | FG1 |
| 6 | 创建 `BranchIndicator` 组件 | frontend | 3 | FG1 |
| 7 | 创建 `UtilityRail` 组件 | frontend | — | FG2 |
| 8 | 修改 `PanelBody` 引入 flex row 布局 | frontend | 7 | FG2 |
| 9 | 修改 `ChatPanel` 集成 utility-rail | frontend | 8 | FG2 |
| 10 | 创建 `stores/sidebar.ts` | frontend | — | FG3 |
| 11 | 创建 `SidebarCollapseHandle` 组件 | frontend | 10 | FG3 |
| 12 | 创建 `SidebarHeader` 组件 | frontend | 10 | FG3 |
| 13 | 修改 `style.css` 添加 `.is-fullscreen` 布局规则 | frontend | — | FG4 |
| 14 | 修改 `App.vue` 监听 fullscreen class 切换 | frontend | 13 | FG4 |
| 15 | 修改 `main/window-manager.ts` 注册 fullscreen 事件 | backend | — | FG4 |
| 16 | 修改 `preload/index.ts` 暴露 fullscreen API | backend | 15 | FG4 |
| 17 | 修改 `shared/protocol.ts` 新增 `message.steer` / `message.follow_up` | shared | — | FG5 |
| 18 | 修改 `runtime/src/server.ts` 处理新消息类型 | backend | 17 | FG5 |
| 19 | 创建 `SendModeStatusBar` 组件 | frontend | — | FG5 |
| 20 | 修改 `ChatInput` 集成状态栏 + Alt 键检测 | frontend | 19, 18 | FG5 |
| 21 | 修改 `session-service.ts` `rebindAfterFork` | backend | — | FG6 |
| 22 | 修改 `tree-service.ts` `forkFromEntry` / `cloneSession` | backend | 21 | FG6 |
| 24 | 修改 `tree-message-handler.ts` 编排 fork/clone label | backend | 21, 22 | FG6 |
| 23 | 在 `MessageActionMenu` 中接入 Fork/Clone | frontend | 24, 2 | FG1 |

---

## Execution Groups

#### FG1: 消息操作 & 批量选择 (Task 1, 2, 3, 4, 5, 6, 23)

**Description:** 消息级的操作能力（FR1-FR4），覆盖单条复制、批量选择复制、分支指示，以及 Fork/Clone 入口。涉及 `MessageBubble` / `PanelBar` 的最小改动 + 3 个新组件 + 2 个工具函数。

**Tasks:** Task 1, 2, 3, 4, 5, 6, 23

**Files (预估):** 11 个文件（7 create + 4 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（前端: medium） |
| 注入上下文 | Task 1-6, 23 描述 + spec FR1-FR4, FR9 UI 规格 + 前端编码规范 + `shared/src/protocol.ts` 中 `session.tree-fork` / `session.tree-clone` 协议类型 |
| 读取文件 | `MessageBubble.vue` / `PanelBar.vue` / `style.css` / `stores/tree.ts` / `shared/src/protocol.ts` |
| 修改/创建文件 | 见 File Structure 表 FG1 行 |

**Execution Flow (FG1 内部):** 串行派遣，每个 Task 走前端 subagent 链。

  Task 1:
    1. general-purpose (read xyz-harness-test-driven-development + xyz-harness-frontend-dev) → 写工具函数
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 2 (depends on 1):
    1. general-purpose (read xyz-harness-frontend-dev) → MessageActionMenu 组件
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 3 (depends on 2):
    1. general-purpose (read xyz-harness-frontend-dev) → MessageBubble 集成
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 4 (depends on 1, 3):
    1. general-purpose (read xyz-harness-frontend-dev) → BatchSelectBar 组件
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 5 (depends on 4):
    1. general-purpose (read xyz-harness-frontend-dev) → PanelBar 集成
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 6 (depends on 3):
    1. general-purpose (read xyz-harness-frontend-dev) → BranchIndicator 组件
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 23 (depends on 22, 2):
    1. general-purpose (read xyz-harness-frontend-dev) → 接入 Fork/Clone
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

**Dependencies:** Task 23 依赖 FG6 后端 label 修改

**设计细节:** 直接写在 group 内部

#### FG2: Utility Rail & PanelBody 布局 (Task 7, 8, 9)

**Description:** FR5 - 在每个 panel 右侧添加 36px 的 utility-rail 滚动导航列。`PanelBody` 改为 flex row 布局以容纳 rail 和 chat-content。

**Tasks:** Task 7, 8, 9

**Files (预估):** 3 个文件（1 create + 2 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（前端: medium） |
| 注入上下文 | Task 7-9 描述 + spec FR5 布局图 + PanelBody 当前代码 |
| 读取文件 | `ChatPanel.vue` / `PanelBody.vue` / `style.css` / `stores/window.ts` |
| 修改/创建文件 | 见 File Structure 表 FG2 行 |

**Execution Flow (FG2 内部):** 串行派遣

  Task 7:
    1. general-purpose (read xyz-harness-frontend-dev) → UtilityRail 组件
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 8 (depends on 7):
    1. general-purpose (read xyz-harness-frontend-dev) → PanelBody flex 改造
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 9 (depends on 8):
    1. general-purpose (read xyz-harness-frontend-dev) → ChatPanel 集成
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

**Dependencies:** 无

**设计细节:** 直接写在 group 内部

#### FG3: 侧边栏折叠 (Task 10, 11, 12)

**Description:** FR6 - 侧边栏三种折叠/展开入口 + width transition 动画。涉及 `stores/sidebar.ts` 新建和 sidebar index.ts 改造。

**Tasks:** Task 10, 11, 12

**Files (预估):** 4 个文件（3 create + 1 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（前端: low） |
| 注入上下文 | Task 10-12 描述 + spec FR6 + 现有 sidebar 组件代码 |
| 读取文件 | `components/sidebar/index.ts` / `components/sidebar/SessionItem.vue` |
| 修改/创建文件 | 见 File Structure 表 FG3 行 |

**Execution Flow (FG3 内部):** 串行派遣

  Task 10:
    1. general-purpose (read xyz-harness-frontend-dev) → sidebar store
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 11 (depends on 10):
    1. general-purpose (read xyz-harness-frontend-dev) → SidebarCollapseHandle 组件 + 更新 `components/sidebar/index.ts` 导出
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 12 (depends on 10):
    1. general-purpose (read xyz-harness-frontend-dev) → SidebarHeader 组件（`◀` 按钮）+ 更新 `components/sidebar/index.ts` 导出
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

**Dependencies:** 无

**设计细节:** 直接写在 group 内部

#### FG4: macOS 全屏布局 (Task 13, 14, 15, 16)

**Description:** FR7 - Electron 主进程 + preload + 渲染层协同实现 macOS 全屏检测和布局切换。

> **混合类型说明（Review Issue #3）：** FG4 包含 backend Task（15-16）和 frontend Task（13-14），未拆分为独立 group。原因是这条 IPC 链路是紧密耦合的：main 进程注册 fullscreen 事件 → preload 暴露 API → renderer 的 CSS/App.vue 响应。如果拆分会让 subagent 跨组协调的成本超过组内混合的成本（main/preload 不能独立工作，必须端到端测试）。

**Tasks:** Task 13, 14, 15, 16

**Files (预估):** 4 个文件（0 create + 4 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（前端: low，后端: low） |
| 注入上下文 | Task 13-16 描述 + spec FR7 布局图 |
| 读取文件 | `main/window-manager.ts` / `preload/index.ts` / `App.vue` / `style.css` |
| 修改/创建文件 | 见 File Structure 表 FG4 行 |

**Execution Flow (FG4 内部):** 串行派遣

  Task 15:
    1. general-purpose (read xyz-harness-test-driven-development + xyz-harness-backend-dev) → main 进程 fullscreen 事件
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 16 (depends on 15):
    1. general-purpose (read xyz-harness-backend-dev) → preload 暴露 API
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 13 (建议在 16 之后执行：需要确认 preload 暴露的 class 名):
    1. general-purpose (read xyz-harness-frontend-dev) → style.css 全屏样式
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 14 (depends on 13):
    1. general-purpose (read xyz-harness-frontend-dev) → App.vue 切换 class
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

**Dependencies:** 无（与 FG1-FG3 可并行）

**设计细节:** 直接写在 group 内部

#### FG5: 发送模式状态栏 & WS 协议扩展 (Task 17, 18, 19, 20)

**Description:** FR8 - 发送模式状态栏 + WS 协议扩展。涉及 shared protocol、新组件、ChatInput 改造。

> **混合类型说明（Review Issue #3）：** FG5 包含 shared/backend Task（17-18）和 frontend Task（19-20），未拆分。原因是协议扩展与 UI 状态栏必须端到端联调：shared 协议类型是前后端的契约，单方先行会导致集成返工。

**Tasks:** Task 17, 18, 19, 20

**Files (预估):** 5 个文件（1 create + 4 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（shared: low，前端: medium） |
| 注入上下文 | Task 17-20 描述 + spec FR8 + pi rpc-types.ts 协议参考 |
| 读取文件 | `shared/src/protocol.ts` / `runtime/src/server.ts` / `components/chat/ChatInput.vue` |
| 修改/创建文件 | 见 File Structure 表 FG5 行 |

**Execution Flow (FG5 内部):** 串行派遣

  Task 17:
    1. general-purpose (read xyz-harness-test-driven-development + xyz-harness-backend-dev) → shared protocol
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 18 (depends on 17):
    1. general-purpose (read xyz-harness-backend-dev) → server handler
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 19 (建议在 18 之后执行：组件需要知道 server 已支持新类型):
    1. general-purpose (read xyz-harness-frontend-dev) → SendModeStatusBar 组件
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 20 (depends on 19, 18 + send button 视觉切换):
    1. general-purpose (read xyz-harness-frontend-dev) → ChatInput 集成：状态栏挂载 + Alt 键检测 + send button 状态视觉切换（idle ↑ accent / streaming ■ red, FR8 末尾要求）
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

**Dependencies:** Task 20 依赖 Task 18 (server handler 就绪才能测试发送)

**设计细节:** 直接写在 group 内部

#### FG6: Fork / Clone 命名 (Task 21, 22)

**Description:** FR9 - 后端 fork/clone 时追加 `-fork` / `-clone` 后缀到 session label。

**Tasks:** Task 21, 22, 24

**Files (预估):** 3 个文件（0 create + 3 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（后端: low） |
| 注入上下文 | Task 21-22 描述 + spec FR9 + session-service / tree-service 当前实现 |
| 读取文件 | `services/session-service.ts` (rebindAfterFork) / `services/tree-service.ts` (forkFromEntry, cloneSession) / `tree-message-handler.ts` (fork/clone case 分支) |
| 修改/创建文件 | 见 File Structure 表 FG6 行 |

**Execution Flow (FG6 内部):** 串行派遣

  Task 21:
    1. general-purpose (read xyz-harness-test-driven-development + xyz-harness-backend-dev) → rebindAfterFork 改签名
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 22 (depends on 21):
    1. general-purpose (read xyz-harness-backend-dev) → forkFromEntry / cloneSession 传 label
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 24 (depends on 21, 22):
    1. general-purpose (read xyz-harness-backend-dev) → tree-message-handler fork 路径传 label + clone 路径 rename
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

**Dependencies:** FG1 中 Task 23 依赖此 group

**设计细节:** 直接写在 group 内部

---

## Dependency Graph & Wave Schedule

```
FG1 (消息操作) ─────────────────────────────────┐
                                                ├──→ Task 23 (depends on FG6)
FG2 (Utility Rail) ─────────────────────────────┤
                                                │
FG3 (侧边栏折叠) ──────────────────────────────┤
                                                │
FG4 (macOS 全屏) ──────────────────────────────┤
                                                │
FG5 (发送模式) ─────────────────────────────────┤
                                                │
FG6 (Fork/Clone) ───────────────────────────────┘
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | FG1, FG2, FG3, FG4, FG5, FG6 | 所有 6 个 group 互不依赖（除 FG1.Task 23 依赖 FG6 之外），可并行执行。Task 23 串行在 FG1 主流程之后追加。 |
| Wave 2 | — | 本 plan 无 Wave 2 |

**并行约束:**
- 同一 Wave 内最多 3 个 subagent 并行（Semaphore 限制）。建议并发序列：FG1 + FG2 + FG3 → FG4 + FG5 + FG6
- FG1 内部 Task 23 必须在 FG6 完成后执行（label 修改在前）

---

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC1 (⋯按钮 + 菜单) | `MessageActionMenu.open()` | hover → click → menu | Task 2, 3 |
| AC2 (复制 + Toast) | `collectMessageContent` + `copyWithToast` | messageEl → markdown → clipboard | Task 1 |
| AC3 (批量选择模式) | `BatchSelectBar` state | click ≡ → toggle checkbox → count | Task 4, 5 |
| AC4 (批量复制格式) | `collectMessageContent` (批量) | selected[] → 拼接 → clipboard | Task 4, 1 |
| AC5 (分支 pill + 导航) | `BranchIndicator.showList()` | click → navigate | Task 6 |
| AC6 (Utility rail 全高) | `UtilityRail.mount()` | panel-body flex row | Task 7, 8, 9 |
| AC7 (滚动按钮显隐) | `UtilityRail.scrollListener` | scroll event → visibility | Task 7 |
| AC8 (侧边栏折叠三入口) | `stores/sidebar.toggle()` | click → collapsed state | Task 10, 11, 12 |
| AC9 (macOS 全屏布局) | `body.is-fullscreen` class | main IPC → renderer | Task 13, 14, 15, 16 |
| AC10 (Fork/Clone 命名) | `rebindAfterFork(label)` | `原名称-fork` / `-clone` | Task 21, 22, 24, 23 |
| AC11 (Steer/Queue 模式) | `SendModeStatusBar` + ChatInput | isGenerating + Alt → mode → RPC | Task 17, 18, 19, 20 |
| AC12 (分屏独立 rail) | `UtilityRail` per panel | PanelBody 嵌套实例化 | Task 7, 9 |

---

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| AC-1 消息操作菜单 | adopted | Task 2, 3 |
| AC-2 单条复制 + Toast | adopted | Task 1 |
| AC-3 批量选择模式 | adopted | Task 4, 5 |
| AC-4 批量复制含 thinking/tool call | adopted | Task 1, 4 |
| AC-5 分支 pill + 导航 | adopted | Task 6 |
| AC-6 Utility rail 全高贯穿 | adopted | Task 7, 8, 9 |
| AC-7 滚动按钮显隐 | adopted | Task 7 |
| AC-8 侧边栏折叠三入口 | adopted | Task 10, 11, 12 |
| AC-9 macOS 全屏布局 | adopted | Task 13, 14, 15, 16 |
| AC-10 Fork/Clone 命名 | adopted | Task 21, 22, 24, 23 |
| AC-11 Steer/Queue 模式 | adopted | Task 17, 18, 19, 20 |
| AC-12 分屏独立 rail | adopted | Task 7, 9 |
| 性能：滚动事件节流 | adopted | Task 7 (内部 rAF 节流) |
| 性能：批量复制 ≤ 100 条无提示 | rejected | — (无显式需求，spec 未提及) |
| 兼容性：WS 协议向后兼容 | adopted | Task 17 (新增类型，不修改已有) |
