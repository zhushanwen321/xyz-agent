# FG1 Task 23 Summary: Integrate Fork/Clone in MessageActionMenu

## 修改文件

| 文件 | 变更说明 |
|------|----------|
| `src-electron/renderer/src/components/chat/MessageActionMenu.vue` | 接入 fork/clone，移除 stub 状态 |
| `src-electron/renderer/src/components/chat/MessageBubble.vue` | 添加 `sessionId` prop，透传给 MessageActionMenu |
| `src-electron/renderer/src/components/panel/ChatPanel.vue` | 向 MessageBubble 传递 `sessionId` 和 `entry-id` |

## 具体变更

### 1. MessageActionMenu.vue
- **新增 prop**: `sessionId: string` — 当前会话 ID
- **导入 `useTree` composable**: 复用已有的 `fork()` 和 `cloneSession()` 方法
- **`handleFork()`**: 调用 `fork(sessionId, entryId)`，发送 `session.tree-fork` WS 消息
- **`handleClone()`**: 调用 `cloneSession(sessionId)`，发送 `session.tree-clone` WS 消息
- **移除 stub 状态**: 删除 `msg-action-menu__item--stub` CSS class 和样式规则，Fork/Clone 菜单项现在完全可交互
- **安全守卫**: 仅在 `sessionId`（和 `entryId`）非空时发送请求

### 2. MessageBubble.vue
- **新增 prop**: `sessionId?: string`（默认 `''`）
- **透传**: 将 `sessionId` 传递给 `<MessageActionMenu :session-id="sessionId" />`

### 3. ChatPanel.vue
- **传递 sessionId**: `<MessageBubble :session-id="sessionId ?? ''" />`
- **传递 entryId**: `<MessageBubble :entry-id="msg.id" />`（使用消息 ID 作为 tree entry ID）

## WS 消息流

```
用户点击 Fork → handleFork()
  → useTree.fork(sessionId, entryId)
  → send({ type: 'session.tree-fork', payload: { sessionId, entryId } })
  → 后端处理 (FG6) → 创建新 session，label 为 "原名称-fork"

用户点击 Clone → handleClone()
  → useTree.cloneSession(sessionId)
  → send({ type: 'session.tree-clone', payload: { sessionId } })
  → 后端处理 (FG6) → 创建新 session，label 为 "原名称-clone"
```

## 验证

- `npm run lint`: ✅ 0 errors, 4 pre-existing warnings
- `git commit`: `35ea1c7` feat(chat-area-round1): task 23 integrate Fork/Clone in MessageActionMenu

## 接受标准对照

- **AC1** ✅: 每条消息 hover 显示 `⋯`，点击弹出操作菜单（已有，未修改）
- **AC10** ✅: Fork/Clone 菜单项接入后端（依赖 FG6 已完成的 `-fork`/`-clone` 后缀逻辑）
