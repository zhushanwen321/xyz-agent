# P2-前端 设计规格

**版本**: v3 | **日期**: 2026-04-10 | **状态**: 设计中

> **Mockup 参考**：[mockup-reference.html](mockup-reference.html) — 可用浏览器直接打开查看 4 种场景的视觉方案。

---

## 目标

前端展示两种模式的任务状态：dispatch_agent（内嵌 + 侧边栏）和 orchestrate（独立树形视图）。

---

## AgentEvent 新增变体

```typescript
// dispatch_agent 事件
| { type: 'TaskCreated'; session_id: string; task_id: string; description: string; mode: string; subagent_type: string; budget: { max_tokens: number } }
| { type: 'TaskProgress'; session_id: string; task_id: string; usage: { total_tokens: number; tool_uses: number; duration_ms: number } }
| { type: 'TaskCompleted'; session_id: string; task_id: string; status: string; result_summary: string; usage: { total_tokens: number } }
| { type: 'BudgetWarning'; session_id: string; task_id: string; usage_percent: number }
| { type: 'TaskFeedback'; session_id: string; task_id: string; message: string; severity: string }

// orchestrate 事件
| { type: 'OrchestrateNodeCreated'; session_id: string; node_id: string; parent_id: string | null; role: string; depth: number; description: string }
| { type: 'OrchestrateNodeProgress'; session_id: string; node_id: string; usage: { total_tokens: number; tool_uses: number; duration_ms: number } }
| { type: 'OrchestrateNodeCompleted'; session_id: string; node_id: string; status: string; result_summary: string; usage: { total_tokens: number } }
| { type: 'OrchestrateNodeIdle'; session_id: string; node_id: string }
| { type: 'OrchestrateFeedback'; session_id: string; node_id: string; direction: string; message: string; severity: string }
```

---

## 前端类型

```typescript
// TaskNode（dispatch_agent）
interface TaskNode {
  type: 'task_node'
  task_id: string
  session_id: string
  description: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'budget_exhausted' | 'killed' | 'paused'
  mode: 'preset' | 'fork'
  subagent_type: string | null
  budget: { max_tokens: number; max_turns: number; max_tool_calls: number }
  usage: { total_tokens: number; tool_uses: number; duration_ms: number }
  created_at: string
  completed_at: string | null
  output_file: string | null
}

// OrchestrateNode
interface OrchestrateNode {
  type: 'orchestrate_node'
  node_id: string
  parent_id: string | null
  session_id: string
  role: 'orchestrator' | 'executor'
  depth: number
  description: string
  status: 'pending' | 'running' | 'idle' | 'completed' | 'failed' | 'budget_exhausted' | 'killed' | 'paused'
  directive: string
  budget: { max_tokens: number; max_turns: number; max_tool_calls: number }
  usage: { total_tokens: number; tool_uses: number; duration_ms: number }
  feedback_history: Array<{ timestamp: string; direction: string; message: string; severity: string }>
  reuse_count: number
  children_ids: string[]
}
```

---

## useChat.ts 变更

```typescript
const taskNodes = ref<Map<string, TaskNode>>(new Map())
const orchestrateNodes = ref<Map<string, OrchestrateNode>>(new Map())

// dispatch_agent 事件处理
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

// orchestrate 事件处理
case 'OrchestrateNodeCreated':
  orchestrateNodes.value.set(event.node_id, { ...event, status: 'running',
    usage: { total_tokens: 0, tool_uses: 0, duration_ms: 0 }, children_ids: [],
    feedback_history: [], reuse_count: 0 })
  break
// ... 类似处理 Progress, Completed, Idle, Feedback

// loadHistory 从 LoadHistoryResult 填充
result.task_nodes.forEach(n => taskNodes.value.set(n.task_id, n))
result.orchestrate_nodes.forEach(n => orchestrateNodes.value.set(n.node_id, n))

return { ..., taskNodes: readonly(taskNodes), orchestrateNodes: readonly(orchestrateNodes) }
```

---

## 核心交互模型

### Chat Tab 机制

聊天窗口支持多个 Tab：
- **Main Chat Tab**（默认）：主 Agent 对话
- **SubAgent Tab**：每个后台 SubAgent 或编排节点可打开独立 Tab
  - 复用现有聊天组件（MessageBubble, ToolCallCard）
  - 实时流式输出（通过独立 event channel）
  - Tab 只读（无输入框），底部状态栏显示预算/工具统计
  - Tab 可关闭（× 按钮）

### 右侧 Sidebar

双 Tab 切换面板（可折叠）：
- **SubAgents Tab**：活跃 SubAgent 卡片列表
- **Orchestrate Tab**：编排树形视图

---

## 展示策略

### dispatch_agent 三种模式

**模式 1：同步阻塞 (sync=true, 单个)**
- SubAgent 作为嵌套 Agent 卡片内嵌在 Assistant 消息中
- 卡片结构：头像(λ) + 模板名 + 描述 + 进度/统计 + 状态图标
- 运行中：spinner + 进度条 + token 计数
- 完成：✓ + token/工具/时长统计 + [展开详情]
- 不可展开为 Chat Tab（同步模式结束后已有完整结果）

**模式 2：异步并行收集 (sync=true, 多个并发)**
- 多个 SubAgent 卡片同时内嵌在 Assistant 消息中
- 每个卡片独立显示 spinner + 进度条
- 底部显示 "等待所有 Agent 完成..." 提示
- 全部完成后主 Agent 继续回复

**模式 3：异步后台 (sync=false)**
- Sidebar SubAgents Tab 中显示卡片（带进度条）
- 点击卡片 → 打开 Chat Tab 显示实时输出
- Sidebar 卡片状态：running（蓝色高亮）/ pending（灰色半透明）/ completed（✓）
- 当前打开的 Tab 对应的卡片有蓝色边框高亮

### orchestrate 编排树

**Sidebar Orchestrate Tab**：
```
[O] 重构认证模块    12K
  ├─ [E] 分析现有代码  ✓ 8.2K
  ├─ [E] 编写新逻辑   4.2K   ← 选中高亮
  └─ [E] 编写测试     idle(2x)
```
- 图标：[O]=Orchestrator(蓝), [E]=Executor
- 状态色：running=蓝, completed=绿, idle=黄, pending=灰, failed=红
- 点击节点 → 打开 Chat Tab

**节点 Chat Tab 信息栏**（Tab 下方）：
```
[E] Executor | parent: [O] 重构认证模块 | depth: 1 | 4.2K / 50K | ⏸ ✕
```
- 显示：角色、父节点描述、深度、预算进度、操作按钮
- 操作：暂停/恢复/终止（级联传播）

---

## 用户操作

### dispatch_agent
- 同步模式：无特殊操作，结果内嵌展示
- 异步后台：
  - 点击 Sidebar 卡片 → 打开 Chat Tab
  - Chat Tab 内可暂停/恢复/终止
  - 关闭 Tab 不终止任务

### orchestrate 节点
- 点击树节点 → 打开 Chat Tab（带节点信息栏）
- 信息栏操作按钮：暂停/恢复/终止（级联传播到子节点）
- 树节点 hover 显示 token 数和 reuse_count
- idle 节点显示 reuse 次数标签（如 "2x"）

---

## LoadHistoryResult 类型更新

```typescript
interface LoadHistoryResult {
  entries: TranscriptEntry[]
  conversation_summary: string | null
  task_nodes: TaskNode[]
  orchestrate_nodes: OrchestrateNode[]
  pending_async_results: Array<{
    task_id: string
    description: string
    status: string
    result_summary: string
  }>
}
```

---

## 约束

- TaskProgress 节流 ≤1次/2s
- OrchestrateNodeProgress 节流 ≤1次/2s
- 结果摘要 ≤2000 字符
- SubAgent 的 TextDelta 不推送到前端
- 切换 session 时停止接收 Progress，切换回来从 JSONL 恢复
