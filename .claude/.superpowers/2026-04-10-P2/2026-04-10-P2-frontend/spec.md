# P2-前端任务树 设计规格

**版本**: v2 | **日期**: 2026-04-10 | **状态**: 设计中

---

## 目标

前端展示任务树状态、SubAgent 执行进度、预算消耗。

## AgentEvent 新增变体

```rust
// 4 个新事件
TaskCreated { session_id, task_id, parent_id, description, mode, subagent_type, budget }
TaskProgress { session_id, task_id, usage }
TaskCompleted { session_id, task_id, status, result_summary, usage }
BudgetWarning { session_id, task_id, usage_percent }
```

触发时机：
- TaskCreated — dispatch_agent 创建 TaskNode 后立即
- TaskProgress — 每轮迭代后（节流 ≤ 1 次/2s）
- TaskCompleted — SubAgent 结束时
- BudgetWarning — 预算达 90% 时（只发一次）

---

## 前端类型

```typescript
// TaskNode 类型
interface TaskNode {
  type: 'task_node'
  task_id: string
  parent_id: string | null
  session_id: string
  description: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'budget_exhausted' | 'killed'
  mode: 'preset' | 'fork'
  subagent_type: string | null
  budget: { max_tokens: number; max_turns: number; max_tool_calls: number }
  usage: { total_tokens: number; tool_uses: number; duration_ms: number }
  children_ids: string[]
  created_at: string
  completed_at: string | null
  output_file: string | null
}

// AgentEvent 扩展（追加到现有联合类型）
| { type: 'TaskCreated'; ... }
| { type: 'TaskProgress'; ... }
| { type: 'TaskCompleted'; ... }
| { type: 'TaskFeedback'; session_id: string; task_id: string; message: string; severity: string }
| { type: 'BudgetWarning'; ... }
```

---

## useChat.ts 变更

```typescript
const taskNodes = ref<Map<string, TaskNode>>(new Map())

// 事件处理
case 'TaskCreated':
  taskNodes.value.set(event.task_id, { ...event, status: 'running',
    usage: { total_tokens: 0, tool_uses: 0, duration_ms: 0 }, children_ids: [] })
  break
case 'TaskProgress':
  node = taskNodes.value.get(event.task_id)
  if (node) node.usage = event.usage
  break
case 'TaskCompleted':
  node = taskNodes.value.get(event.task_id)
  if (node) { node.status = event.status; node.usage = event.usage }
  break

// 暴露
return { ..., taskNodes: readonly(taskNodes) }
```

---

## 新增组件

### TaskTreeView.vue

可折叠面板，展示树形任务列表：

```
┌─ 任务树 ──────────────────────────────┐
│ ● 探索代码结构      completed  3.5K t │
│ ◉ 实现新功能        running   12.4K t │
│   ├─ ✓ 分析接口    completed  8.2K t  │
│   └─ ◉ 编写实现    running   4.2K t   │
└───────────────────────────────────────┘
```

状态图标：● pending, ◉ running, ✓ completed, ✗ failed, ⚡ budget_exhausted
Token 显示：缩写格式（K/M），如 `3.5K t`

### TaskTreeNode.vue

递归组件，接收 TaskNode，渲染状态行 + 预算进度条（running 时）+ 子节点列表。

### TaskDetail.vue

点击节点展开详情面板：
- 任务描述、模板类型、模式
- 预算使用（进度条）
- 工具调用次数、执行时长
- 结果摘要（completed 时）
- 反馈消息列表（来自 feedback 工具）
- 操作按钮：running→[暂停][终止]，paused→[恢复][终止]
- [查看对话]（调用 get_subagent_history 从独立 JSONL 加载）

---

## 现有组件变更

### ToolCallCard.vue

工具名为 `dispatch_agent` 时渲染特殊卡片：

- 运行中：显示任务描述 + 模板名 + 预算进度条
- 完成：显示状态 + token/工具/时长统计 + [查看详情]

### StatusBar.vue

新增活跃任务数显示：`tasks: 2 running`

### ChatView.vue

集成 TaskTreeView，位置为聊天区域右侧可折叠面板。

---

## 约束

- TaskNode 事件节流 ≤ 1 次/2s（防止高频更新）
- 结果摘要 ≤ 2000 字符（前端展示用）
- 无暂停/恢复 UI（P2 不实现用户干预）
- SubAgent 的 TextDelta 不推送到前端（后端通过独立 channel + 桥接过滤）

## 已知限制

- **无实时流式** — SubAgent 内部的 TextDelta 不推送到前端
- **无日志 Tab** — 不展示 SubAgent 内部的工具调用日志
- **无历史任务树** — 切换 session 后任务树从 JSONL 重新加载

## LoadHistoryResult 类型更新

后端 `LoadHistoryResult` 新增 `task_nodes` 字段，前端需同步更新：

```typescript
interface LoadHistoryResult {
  entries: TranscriptEntry[]
  conversation_summary: string | null
  task_nodes: TaskNode[]              // NEW
}
```

`useChat.ts` 的 `loadHistory` 方法需要从返回值中提取 `task_nodes`，填充到 `taskNodes` ref：
```typescript
const result = await getHistory(sessionId)
// 现有逻辑...
result.task_nodes.forEach(node => taskNodes.value.set(node.task_id, node))
```
