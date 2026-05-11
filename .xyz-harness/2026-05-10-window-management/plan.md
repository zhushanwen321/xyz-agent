# 窗口管理系统 — 实现计划

## Phase 划分

按依赖关系排序，每个 Phase 可独立验证。

---

### Phase 0: ChatStore 重构 + Sidecar 多 WS

**目标：** 解决 C2/C3（ChatStore 单例问题）和 C1（Sidecar 单 WS 问题），为多 Pane/多窗口打基础。

#### Task 0.1: Sidecar 多 WS 支持

- 文件: `src-electron/sidecar/src/server.ts` + `src-electron/sidecar/src/session-pool.ts`
- 改动:
  - `SidecarServer.client: WsType | null` → `clients: Set<WsType>`
  - `handleConnection`: 不踢旧连接，`clients.add(ws)`
  - `send(ws, msg)` → `broadcast(msg)` 发到所有 client
  - `SessionPool.ws: WebSocket | null` → `clients: Set<WebSocket>`
  - `bindWebSocket(ws)` → `addClient(ws)`
  - `unbindWebSocket()` → `removeClient(ws)`
  - `send(msg)` 广播到所有 client
  - 每个 WS 独立 heartbeat

#### Task 0.2: ChatStore 按 sessionId 分区

- 文件: `src-electron/renderer/src/stores/chat.ts`
- 改动:
  - 新增 `ChatSessionState` 类型：`{ messages, streamingMessage, isGenerating, error, agentViews, pendingApprovals, ... }`
  - `chatSessions: Map<string, ChatSessionState>` 替代全局 `completedMessages` 等字段
  - `getSessionState(sessionId)` getter
  - `ensureSession(sessionId)` action：初始化分区
  - agentViews 和 pendingApprovals 纳入 ChatSessionState 按 session 隔离
  - 保持向后兼容：无 sessionId 时使用默认分区 `'__default__'`
  - 所有现有方法（addMessage, setStreaming, appendToStreaming 等）增加 sessionId 参数

#### Task 0.3: useChat composable 简化 + 全局 handler

- 文件: `src-electron/renderer/src/composables/useChat.ts` + `src-electron/renderer/src/App.vue`
- 改动:
  - `useChat(sessionId: Ref<string>)` 简化为操作层: `sendMessage`, `abort`, 加上分区数据的 computed
  - **移除** useChat 内的所有 event listener 注册（不再有 onMounted/onUnmounted）
  - **移除** 模块级 `listenerRefCount`
  - event handler 统一在 `App.vue` 的 `onMounted` 中注册（与现有 initConnection 并列）
  - **useProvider / useSession 内的 WS 事件监听器一并迁移到 App.vue 全局 handler**
  - handler 逻辑: 按 `msg.payload.sessionId` 路由到 `chatStore.getSessionState(sessionId)` 写入
  - 每个 ChatPanel 通过 `useChat(toRef(props, 'sessionId'))` 获取自己的操作接口和数据

**验证:** 现有功能不受影响（单 Pane + 单 session 回归测试），sidecar 不踢旧连接。

---

### Phase 1: 数据层 + PaneTree 渲染

**目标：** 将现有 `splitMode` boolean 替换为 PaneTree 二叉树。

#### Task 1.1: 共享类型定义

- 文件: `src-electron/shared/src/pane.ts` + `src-electron/shared/src/index.ts`
- 内容:
  ```typescript
  export interface PaneLeaf {
    type: 'pane'
    id: string
    sessionId: string | null
  }
  export interface SplitNode {
    type: 'split'
    direction: 'horizontal' | 'vertical'
    children: [PaneTree, PaneTree]
    ratio: number
  }
  export type PaneTree = PaneLeaf | SplitNode

  export interface WindowState {
    windowId: string
    paneTree: PaneTree
    focusedPaneId: string
    sessionIds: string[]
  }
  ```
- 同时导出 WindowState 类型用于 IPC 和 WindowManager

#### Task 1.2: PaneStore

- 文件: `src-electron/renderer/src/stores/pane.ts`（新建）
- 内容:
  - `state`: `tree: PaneTree`, `focusedPaneId: string`
  - `getters`: `panes`, `paneCount`, `focusedPane`, `findById`, `canSplit`
  - `actions`:
    - `splitPane(paneId, direction)` — 叶子节点替换为 SplitNode
    - `unbindSession(paneId)` — Cmd+W: 清空 session 绑定，Pane 变空面板，不删除 split 结构
    - `closeEmptyPane(paneId)` — 右键"关闭面板": 移除空 Pane，合并 split 结构
    - `bindSession(paneId, sessionId)`
    - `updateRatio(nodeId, ratio)` — 拖拽分隔条后更新 SplitNode 的 ratio
    - `navigateToPane(paneId)` — 聚焦指定 pane
    - `navigateNext()` / `navigatePrev()` — 键盘导航（扁平序）
    - `mergeToSingle()` — Cmd+1: 移除所有 split，恢复单 Pane
  - 辅助: `flattenTree`, `findParent`, `findSibling`, `replaceInTree`

#### Task 1.3: PaneTreeRenderer 递归组件

- 文件: `src-electron/renderer/src/components/panel/PaneTreeRenderer.vue`（新建）
- 行为:
  - 传入 `node: PaneTree`
  - PaneLeaf → `<ChatPanel :session-id="..." :focused="..." />` 或 `<EmptyPane />`
  - SplitNode → flex 容器 + 两个 `<PaneTreeRenderer />` + `<SplitDivider />`
  - direction 控制 flex-direction
  - SplitDivider 拖拽时调用 `paneStore.updateRatio(nodeId, newRatio)`

#### Task 1.4: EmptyPane 组件

- 文件: `src-electron/renderer/src/components/panel/EmptyPane.vue`（新建）
- 行为: 最近 session 列表 + "新建对话"按钮

#### Task 1.5: 迁移 App.vue

- 移除 `splitMode` 和两个硬编码 `<ChatView />`
- 替换为 `<PaneTreeRenderer :node="paneStore.tree" />`
- 移除 focusMode 相关逻辑

#### Task 1.6: 迁移 settingsStore

- 移除 `splitMode`, `focusMode`, `toggleSplit()`, `toggleFocus()`
- 快捷键 `split` 改为 `paneStore.splitPane(focusedPaneId, 'horizontal')`

#### Task 1.7: 全局键盘事件注册

- 文件: `src-electron/renderer/src/App.vue`
- 在 `onMounted` 中注册全局键盘监听（非 Electron shortcut 类型的局部快捷键）:
  - Cmd+D → `paneStore.splitPane(focusedPaneId, 'horizontal')`
  - Cmd+Shift+D → `paneStore.splitPane(focusedPaneId, 'vertical')`
  - Cmd+W → `paneStore.unbindSession(focusedPaneId)`（preventDefault 阻止浏览器"关闭标签"行为）
  - Cmd+方向键 → `paneStore.navigateNext()` / `navigatePrev()`
  - Cmd+1 → `paneStore.mergeToSingle()`
  - Cmd+B → toggle Drawer

#### Task 1.8: 移除 focus mode

- `App.vue`: 移除 `.focus-mode` CSS 和条件渲染
- `AppHeader.vue`: 移除 `cycleViewMode` 中的 focus 分支，`cycleViewMode` 简化为 `toggleSplit()`
- `settings.ts`: 移除 `focusMode` ref
- 快捷键 `Cmd+1` 已由 Task 1.7 接管

**验证:** Cmd+D 左右分栏，每个 Pane 独立绑定 session，Cmd+W 清空 session，拖拽分隔条可调整大小。

---

### Phase 2: Sidebar → Drawer

**目标：** Sidebar 改为左侧 Drawer，点击 session 智能分流。

#### Task 2.1: Sidebar Drawer 改造

- 文件: `src-electron/renderer/src/components/layout/AppSidebar.vue`
- 改动:
  - `<aside>` 改为 position: fixed Drawer
  - 添加 `visible` prop + translateX 动画（z-index: 60，高于通知 Drawer 的 50）
  - 点击外部关闭
  - 同一时间只允许一个 Drawer 打开（sidebar 与通知 drawer 互斥）

#### Task 2.2: 分流逻辑

- 文件: `src-electron/renderer/src/stores/pane.ts`（扩展）
- 新增 action: `openSessionSmart(sessionId)`:
  - 已在某 Pane → 聚焦该 Pane
  - paneCount === 1 → splitRight + bindSession
  - paneCount >= 2 && < 4 → 创建新窗口（Phase 3 前先 toast 提示"多窗口功能开发中"，直接 split）
  - paneCount === 4 → toast 错误

#### Task 2.3: Header Drawer 按钮

- 文件: `src-electron/renderer/src/components/layout/AppHeader.vue`
- logo 旁添加 `[≡]` 按钮，toggle Drawer
- 新增 `drawerVisible` state（settingsStore 或独立 ref）

#### Task 2.4: Cmd+B 快捷键

- `shortcuts.ts`: 新增 `Cmd+B`
- `App.vue`: 处理 `drawer` shortcut type

**验证:** Cmd+B 打开/关闭 Drawer，点击 session 自动 split。

---

### Phase 3: 多窗口

**目标：** 支持多个 BrowserWindow，窗口间 IPC 通信。

#### Task 3.1: WindowManager

- 文件: `src-electron/main/window-manager.ts`（新建）
- 内容:
  - `windows: Map<string, BrowserWindow>`
  - `windowStates: Map<string, WindowState>`
  - `create(sessionId?)`, `close(windowId)`, `focus(windowId)`
  - `getAll(): WindowState[]`
  - `updateState(windowId, state)` — 渲染进程上报

#### Task 3.2: createWindow 工厂

- 文件: `src-electron/main/main.ts`
- 抽取 `createMainWindow()` 为通用 `createWindow(options?)`
- URL 携带 `?windowId=xxx&sessionId=yyy`
- 注册到 WindowManager

#### Task 3.3: IPC handler 注册（主进程）

- 文件: `src-electron/main/ipc-handlers.ts`
- 扩展 `IpcHandlerDeps` 增加 `windowManager: WindowManager`
- 新增 handler:
  - `create-window`: 调用 `windowManager.create(sessionId)`，返回 `{ windowId }`
  - `get-windows`: 返回 `windowManager.getAll()`
  - `focus-window`: 调用 `windowManager.focus(windowId)`
  - `update-window-state`: 更新 `windowManager.updateState(windowId, state)`
- 不将 settings 窗口注册到 WindowManager（settings 走 `open-settings-window` 独立 IPC）

#### Task 3.4: Preload IPC 扩展

- 文件: `src-electron/preload/preload.ts` + `index.d.ts`
- 新增: `createWindow(sessionId?)`, `getWindows()`, `focusWindow(windowId)`, `updateWindowState(state)`, `onWindowCreated(cb)`, `onWindowClosed(cb)`

#### Task 3.5: WindowStore

- 文件: `src-electron/renderer/src/stores/window.ts`（新建）
- 内容: `windows: WindowState[]`, `currentWindowId`, `refreshFromIPC()`, `createWindow()`, `focusWindow()`
- `onMounted` 读取 URL query 中的 sessionId 和 windowId

#### Task 3.6: "移动到新窗口"

- `PanelBar.vue` 右键菜单：`IPC createWindow(sessionId)` + `paneStore.closePane()`

#### Task 3.7: 分流逻辑对接

- `paneStore.openSessionSmart` 中 paneCount >= 2 的分支改为 `IPC createWindow(sessionId)`

**验证:** Cmd+N 创建新窗口，两个窗口各自显示不同 session，互不干扰。

---

### Phase 4: Overview 改造

**目标：** Overview 显示所有窗口缩略图。

#### Task 4.1: Overview 数据源

- `Overview.vue` 数据源改为 `windowStore.windows`（IPC 获取）
- 每张卡片 = 一个窗口

#### Task 4.2: WindowCard 组件

- `src-electron/renderer/src/components/overview/WindowCard.vue`（新建）
- CSS flex 模拟 PaneTree 布局
- 点击 → `focusWindow()` + 关闭 Overview

**验证:** Cmd+J 显示所有窗口缩略图。

---

### Phase 5: 垂直 Split + 完善

#### Task 5.1: 垂直 Split

- PaneTreeRenderer: direction='vertical' 时 `flex-direction: column`
- SplitDivider: 垂直模式 `cursor: row-resize`
- Cmd+Shift+D

#### Task 5.2: PanelBar hover 关闭按钮

- 每个 PanelBar hover 显示 × 按钮
- 移除 `showClose` prop

#### Task 5.3: 聚焦视觉

- 聚焦 Pane 的 PanelBar: `background: var(--accent-light)`
- 非聚焦: `var(--surface)`

#### Task 5.4: 4 Pane toast

- splitPane 时 paneCount >= 4 → toast "已达面板上限(4)"

**验证:** Cmd+Shift+D 上下分栏，所有交互完善。

---

## 依赖关系

```
Phase 0 (ChatStore 重构 + Sidecar 多 WS)
  ↓
Phase 1 (PaneTree 数据层 + 渲染) ← 依赖 Phase 0 的 ChatStore 分区
  ↓
Phase 2 (Sidebar → Drawer) ← 依赖 Phase 1 的 PaneStore
  ↓
Phase 3 (多窗口) ← 依赖 Phase 2 的分流逻辑 + Phase 0 的多 WS
  ↓
Phase 4 (Overview) ← 依赖 Phase 3 的 WindowStore

Phase 5 (垂直 Split) ← 可与 Phase 3/4 并行，依赖 Phase 1 的 PaneTreeRenderer
```

## 文件变更预估

| Phase | 新增文件 | 修改文件 | 预估行数 |
|-------|---------|---------|---------|
| Phase 0 | 0 | 4 (chat.ts, useChat.ts, server.ts, session-pool.ts) | ~250 |
| Phase 1 | 4 (pane.ts store, PaneTreeRenderer.vue, EmptyPane.vue, shared/pane.ts) | 5 (App.vue, settings.ts, ChatView.vue, shared/index.ts, shortcuts.ts) | ~700 |
| Phase 2 | 0 | 3 (AppSidebar.vue, AppHeader.vue, pane.ts store扩展) | ~200 |
| Phase 3 | 2 (window-manager.ts, window.ts store) | 4 (main.ts, preload.ts, ipc-handlers.ts, PanelBar.vue) | ~550 |
| Phase 4 | 1 (WindowCard.vue) | 1 (Overview.vue) | ~250 |
| Phase 5 | 0 | 3 (PaneTreeRenderer.vue, PanelBar.vue, shortcuts.ts electron) | ~150 |
| **合计** | **7** | **16** | **~2100** |
