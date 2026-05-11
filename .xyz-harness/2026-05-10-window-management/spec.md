# 窗口管理系统 — 需求设计文档

## 目标

将 xyz-agent 的窗口管理从"单窗口 + 布尔分栏"升级为"多窗口 + 二叉树分栏"模型，参考 Ghostty 终端的 split 交互。

## 范围

### 包含

1. PaneTree 二叉树数据结构（支持水平/垂直 split）
2. 每个 Pane 独立绑定 Session
3. Sidebar 改为左侧 Drawer（按需打开）
4. Drawer 中点击 Session 的智能分流（1 Pane → split，2+ Pane → 新窗口）
5. 每个窗口最多 4 个 Pane（硬性限制）
6. Sidecar 支持多 WS 连接广播
7. ChatStore 按 SessionId 分区隔离
8. Electron 多窗口管理（createWindow 工厂 + IPC 广播）
9. Main 进程维护窗口状态 `Map<windowId, WindowState>`
10. Overview 改造为窗口管理面板
11. Cmd+W 清空 Pane 的 session 绑定（变为空面板），不删除 split 结构；右键"关闭面板"可合并 split 并移除空 Pane
12. Cmd+D 水平 split、Cmd+Shift+D 垂直 split、Cmd+1 恢复单 Pane 标准视图
13. Cmd+N/B/J 等快捷键通过 Electron 主进程 globalShortcut 或 Vue 局部键盘事件注册
14. PanelBar 增加 hover 关闭按钮
15. "移动到新窗口"右键菜单
16. 移除 focus mode

### 不包含

- 跨窗口拖拽 Pane（v2）
- 窗口 Tab 标签页
- 窗口布局持久化（重启后重置）
- Focus mode（移除）
- Sidecar subscription 模型（当前用广播+过滤，够用）

## 数据流

### 新增数据字段

| 字段 | 类型 | 生产者 | 存储位置 | 消费者 | 读取时机 |
|------|------|--------|---------|--------|----------|
| paneTree | PaneTree | PaneStore | Pinia (内存) | PaneTreeRenderer | split/close 操作后 |
| windows | Map<string, WindowState> | WindowManager (main) | Main 进程 (内存) | Overview (IPC 查询) | 打开 Overview 时 |
| focusedPaneId | string | PaneStore | Pinia (内存) | PanelBar, ChatInput | 聚焦切换后 |
| chatSessions | Map<string, ChatState> | ChatStore | Pinia (内存) | ChatPanel | 消息到达时 |

### 数据流图

```
用户操作 (点击/快捷键)
  → PaneStore (split/close/bind/navigate)
    → PaneTree 更新
    → PaneTreeRenderer 重新渲染
    → PanelBar 更新聚焦状态

用户操作 (Drawer 点击 session)
  → PaneStore 检查 paneCount
    → paneCount === 1 → splitRight + bindSession
    → paneCount >= 2 → IPC → main.createWindow(sessionId)
      → main 创建 BrowserWindow，URL 携带 ?sessionId=xxx
      → 新 Vue 实例 onMounted 读取 URL query，绑定 session

Sidecar 消息到达
  → WS 连接 (per-window, 窗口内所有 panel 共享)
    → 全局 handler 统一注册 (App.vue 层, 仅 1 套)
      → 按 msg.sessionId 路由到 ChatStore 对应分区
        → 对应 Pane 的 ChatPanel 响应式更新
      → 无匹配分区的消息直接丢弃

非本窗口 panel 的 session 消息也会到达 (sidecar 广播), 但无对应 ChatStore 分区, 自然忽略.

Main 进程窗口管理
  → WindowManager 维护 Map<windowId, WindowState>
  → 各窗口通过 IPC 上报 PaneTree 变更
  → Overview 通过 IPC 查询所有窗口状态
```

### 时序要求

- Split 操作：用户操作后 < 100ms 完成渲染
- 窗口创建：Cmd+N 后 < 500ms 新窗口可见
- 聚焦切换：点击/键盘后 < 50ms PanelBar 状态更新
- Sidecar 消息到达：广播到所有 WS 连接，每个窗口按 sessionId 过滤

## 架构约束

### Sidecar

1. `SidecarServer.client` 从 `WsType | null` 改为 `Set<WsType>`
2. `handleConnection` 不再踢掉旧连接，改为添加到 Set
3. `send` / `broadcastSessionList` / `broadcastProviderList` 广播到所有连接
4. `SessionPool.bindWebSocket(ws)` 改为 `addClient(ws)`，`send` 广播到所有 client
5. 每个 WS 连接独立处理 heartbeat

### 前端

1. **PaneStore** 是 PaneTree 的唯一数据源
2. **ChatStore** 按 sessionId 分区：`chatSessions: Map<string, { messages, streaming, isGenerating, error }>`。单个 ChatPanel 只读写自己 sessionId 对应的分区
3. **useChat** composable 简化为操作层；`useProvider` / `useSession` 内的 WS 事件监听器也一并迁移到 App.vue 全局 handler
4. **ChatSessionState** 包含 `agentViews: Record<string, Message[]>`，子 Agent 消息按 session 隔离
5. **WindowStore** 通过 IPC 与 main 进程同步窗口状态
6. **WindowState** 类型在 `src-electron/shared/src/pane.ts` 中定义
7. PaneTreeRenderer 是递归组件

### Electron 主进程

1. `WindowManager` 类维护 `Map<windowId, BrowserWindow>` 和 `Map<windowId, WindowState>`
2. 每个窗口创建时通过 URL query 传递初始 sessionId
3. 各窗口通过 IPC 上报 PaneTree 变更
4. Overview 通过 IPC 查询所有窗口状态

### Preload

1. 新增 IPC 通道：`create-window`, `close-window`, `focus-window`, `get-windows`, `update-window-state`
2. 保持现有 `onShortcut`, `onSidecarPort`, `openSettingsWindow` 不变

### Electron 主进程 IPC

1. `ipc-handlers.ts` 新增 handler：`create-window`（调用 WindowManager.create）、`get-windows`（调用 WindowManager.getAll）、`focus-window`、`update-window-state`
2. `shortcuts.ts` 新增：`split`(Cmd+D)、`split-vertical`(Cmd+Shift+D)、`close-pane`(Cmd+W)、`new-window`(Cmd+N)、`drawer`(Cmd+B)、`standard`(Cmd+1 已存在，行为改为恢复单 Pane)
3. Settings 窗口走独立 IPC `open-settings-window`，不纳入 WindowManager

### 已移除

- **Focus mode**：`settingsStore.focusMode` 及相关逻辑全部移除。sidebar 已改为 Drawer，focus mode 的核心价值（隐藏 sidebar）不再需要

## 验收标准

1. 单窗口内可以水平 split（Cmd+D），两个 Pane 各自绑定不同 Session
2. 单窗口内可以垂直 split（Cmd+Shift+D）
3. 最多 4 个 Pane，超限时 toast 提示
4. Cmd+W 清空 Pane session 绑定（变空面板），不删除 split 结构；右键"关闭面板"合并 split
5. Sidebar 作为 Drawer 打开（Cmd+B），点击 session 智能分流
6. Cmd+N 创建新窗口，URL query 传递初始 sessionId
7. Cmd+1 关闭所有 split，恢复单 Pane 标准视图
8. 多窗口同时连接 sidecar，各自独立接收消息
9. 不同 Pane 显示不同 session 的消息，互不干扰
10. 子 Agent（agentViews）在多 Pane 下正常工作
11. 拖拽分隔条可调整 Pane 大小（ratio 更新）
12. Overview 显示所有窗口的 PaneTree 结构示意图（CSS flex 模拟，非截图）
13. "移动到新窗口" 右键菜单可用
14. Focus mode 已移除，无残留引用
15. Settings 窗口不纳入 WindowManager 管理
16. 侧边栏 Drawer 与通知 Drawer 不冲突
17. 构建通过：`npm run build`
18. Lint 通过：`npm run lint`

## 待决议项

无。
