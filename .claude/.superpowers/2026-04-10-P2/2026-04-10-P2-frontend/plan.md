# P2-E: 前端完整 UI 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 实现前端展示 SubAgent 卡片、编排树形视图、Chat Tab 系统和用户操作按钮。

**Spec:** [2026-04-10-P2-frontend/spec.md](spec.md) + [mockup-reference.html](mockup-reference.html)
**前置:** P2-D 事件系统完成

---

## Task 1: 类型扩展

**Files:**
- Modify: `src/types/index.ts`

- [ ] **Step 1: 添加 P2 事件类型**

```ts
// dispatch_agent 事件（追加到 AgentEvent 联合类型）
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

- [ ] **Step 2: 添加 TaskNode 和 OrchestrateNode 接口**

```ts
export interface TaskNode {
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

export interface OrchestrateNode {
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

- [ ] **Step 3: 扩展 LoadHistoryResult**

```ts
export interface LoadHistoryResult {
  entries: TranscriptEntry[]
  conversation_summary: string | null
  task_nodes: TaskNode[]
  orchestrate_nodes: OrchestrateNode[]
  pending_async_results: Array<{
    task_id: string; description: string; status: string; result_summary: string
  }>
}
```

- [ ] **Step 4: Commit**

```bash
git add src/types/index.ts
git commit -m "feat(P2-E): add TaskNode, OrchestrateNode types and extended event variants"
```

---

## Task 2: useChat 扩展

**Files:**
- Modify: `src/composables/useChat.ts`

- [ ] **Step 1: 添加 taskNodes 和 orchestrateNodes 状态**

```ts
const taskNodes = ref<Map<string, TaskNode>>(new Map())
const orchestrateNodes = ref<Map<string, OrchestrateNode>>(new Map())
```

- [ ] **Step 2: 添加事件处理分支**

在 onAgentEvent callback 中追加：

```ts
case 'TaskCreated':
  taskNodes.value.set(event.task_id, {
    type: 'task_node', ...event, status: 'running',
    usage: { total_tokens: 0, tool_uses: 0, duration_ms: 0 },
    budget: event.budget, created_at: new Date().toISOString(),
    completed_at: null, output_file: null, subagent_type: event.subagent_type,
    mode: event.mode as 'preset' | 'fork',
  })
  break
case 'TaskProgress':
  node = taskNodes.value.get(event.task_id)
  if (node) node.usage = event.usage
  break
case 'TaskCompleted':
  node = taskNodes.value.get(event.task_id)
  if (node) { node.status = event.status as TaskNode['status']; node.usage = event.usage }
  break
case 'BudgetWarning':
  // TODO: 视觉反馈（卡片边框变黄）
  break
case 'TaskFeedback':
  // TODO: feedback 摘要展示
  break
// orchestrate 事件（类似结构）
case 'OrchestrateNodeCreated':
  orchestrateNodes.value.set(event.node_id, {
    type: 'orchestrate_node', ...event, status: 'running',
    usage: { total_tokens: 0, tool_uses: 0, duration_ms: 0 }, children_ids: [],
    feedback_history: [], reuse_count: 0, directive: '', budget: { max_tokens: 0, max_turns: 0, max_tool_calls: 0 },
  })
  break
```

- [ ] **Step 3: loadHistory 填充 taskNodes/orchestrateNodes**

```ts
result.task_nodes.forEach(n => taskNodes.value.set(n.task_id, n))
result.orchestrate_nodes.forEach(n => orchestrateNodes.value.set(n.node_id, n))
```

- [ ] **Step 4: 导出新状态**

```ts
return { ..., taskNodes: readonly(taskNodes), orchestrateNodes: readonly(orchestrateNodes) }
```

- [ ] **Step 5: Commit**

```bash
git add src/composables/useChat.ts
git commit -m "feat(P2-E): extend useChat with taskNodes/orchestrateNodes state and event handling"
```

---

## Task 3: SubAgentCard 组件

**Files:**
- Create: `src/components/SubAgentCard.vue`

- [ ] **Step 1: 实现 SubAgentCard**

参考 mockup-reference.html 场景 1 的内嵌卡片设计：

```vue
<script setup lang="ts">
import type { TaskNode } from '@/types'

const props = defineProps<{ task: TaskNode }>()
const isExpanded = ref(false)

const statusIcon = computed(() => {
  switch (props.task.status) {
    case 'running': return 'spinner'
    case 'completed': return 'check'
    case 'failed': return 'x'
    case 'budget_exhausted': return 'zap'
    default: return 'clock'
  }
})
const progressPercent = computed(() =>
  Math.min(100, (props.task.usage.total_tokens / props.task.budget.max_tokens) * 100)
)
</script>
```

模板结构：
- 头部：λ 图标 + 模板名 + description + token 统计 + 状态图标
- 运行中：spinner + 进度条 + token 计数
- 完成：check + 统计 + [展开详情]
- 参考 mockup 中 `.mockup-body` 内的卡片 HTML

- [ ] **Step 2: Commit**

```bash
git add src/components/SubAgentCard.vue
git commit -m "feat(P2-E): add SubAgentCard component with progress bar and status display"
```

---

## Task 4: ToolCallCard 扩展

**Files:**
- Modify: `src/components/ToolCallCard.vue`

- [ ] **Step 1: 添加 dispatch_agent 特殊渲染**

当 `toolCall.tool_name === 'dispatch_agent'` 时，渲染 SubAgentCard 替代默认工具卡片：

```vue
<!-- 在 ToolCallCard.vue template 中添加条件 -->
<SubAgentCard v-if="isDispatchAgent" :task="dispatchTask" />
<!-- 原有渲染用 v-else 包裹 -->
```

- [ ] **Step 2: Commit**

```bash
git add src/components/ToolCallCard.vue
git commit -m "feat(P2-E): extend ToolCallCard with dispatch_agent special rendering"
```

---

## Task 5: SubAgentSidebar 组件

**Files:**
- Create: `src/components/SubAgentSidebar.vue`

- [ ] **Step 1: 实现双 Tab 侧边栏**

参考 mockup 场景 3/4 的 Sidebar 设计：

```vue
<script setup lang="ts">
import type { TaskNode, OrchestrateNode } from '@/types'

const props = defineProps<{
  taskNodes: Map<string, TaskNode>
  orchestrateNodes: Map<string, OrchestrateNode>
}>()

const activeTab = ref<'subagents' | 'orchestrate'>('subagents')
const emit = defineEmits<{
  openTab: [id: string, type: 'task' | 'orchestrate']
  killTask: [taskId: string]
  pauseTask: [taskId: string]
}>()
</script>
```

模板结构：
- 双 Tab 切换（SubAgents | Orchestrate）
- SubAgents Tab：活跃/等待/完成的卡片列表
- Orchestrate Tab：树形视图
- 参考 mockup 中 Sidebar 部分的 HTML

- [ ] **Step 2: Commit**

```bash
git add src/components/SubAgentSidebar.vue
git commit -m "feat(P2-E): add SubAgentSidebar with dual-tab layout (SubAgents + Orchestrate)"
```

---

## Task 6: TaskTreeView + TaskTreeNode 组件

**Files:**
- Create: `src/components/TaskTreeView.vue`
- Create: `src/components/TaskTreeNode.vue`

- [ ] **Step 1: 实现 TaskTreeNode 递归组件**

参考 mockup 场景 4 的树形视图：

```vue
<script setup lang="ts">
import type { OrchestrateNode } from '@/types'

const props = defineProps<{
  node: OrchestrateNode
  allNodes: Map<string, OrchestrateNode>
  selectedId: string | null
}>()

const emit = defineEmits<{
  select: [nodeId: string]
  kill: [nodeId: string]
}>()

const children = computed(() =>
  props.node.children_ids
    .map(id => props.allNodes.get(id))
    .filter(Boolean) as OrchestrateNode[]
)

const statusColor = computed(() => {
  switch (props.node.status) {
    case 'running': return '#3b82f6'   // 蓝
    case 'completed': return '#22c55e'  // 绿
    case 'idle': return '#eab308'       // 黄
    case 'failed': return '#ef4444'     // 红
    default: return '#71717a'           // 灰
  }
})
</script>
```

- [ ] **Step 2: 实现 TaskTreeView 容器**

```vue
<script setup lang="ts">
// 找到所有根节点（parent_id === null）并渲染
const rootNodes = computed(() =>
  [...props.nodes.values()].filter(n => n.parent_id === null)
)
</script>
```

- [ ] **Step 3: Commit**

```bash
git add src/components/TaskTreeView.vue src/components/TaskTreeNode.vue
git commit -m "feat(P2-E): add TaskTreeView and TaskTreeNode with recursive rendering and status colors"
```

---

## Task 7: ChatView 集成 Sidebar + Tab 系统

**Files:**
- Modify: `src/components/ChatView.vue`

- [ ] **Step 1: 集成 Sidebar 到 ChatView 布局**

在 ChatView template 中添加右侧 Sidebar：

```vue
<div class="flex h-full flex-1">
  <!-- 现有聊天区域 -->
  <div class="flex flex-1 flex-col">
    <!-- ... 现有内容 ... -->
  </div>
  <!-- 右侧 Sidebar -->
  <SubAgentSidebar
    v-if="showSidebar"
    :task-nodes="taskNodes"
    :orchestrate-nodes="orchestrateNodes"
    @open-tab="handleOpenTab"
    @kill-task="handleKillTask"
  />
</div>
```

- [ ] **Step 2: Sidebar 自动展开/折叠逻辑**

```ts
const showSidebar = computed(() =>
  taskNodes.value.size > 0 || orchestrateNodes.value.size > 0
)
```

- [ ] **Step 3: Commit**

```bash
git add src/components/ChatView.vue
git commit -m "feat(P2-E): integrate SubAgentSidebar into ChatView with auto-show/hide"
```

---

## Task 8: Tauri commands 扩展

**Files:**
- Modify: `src-tauri/src/api/commands.rs`
- Modify: `src/lib/tauri.ts`

- [ ] **Step 1: 添加 kill/pause/resume Tauri commands**

```rust
// api/commands.rs
#[tauri::command]
pub async fn kill_task(task_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut tree = state.task_tree.lock().await;
    tree.request_kill(&task_id);
    Ok(())
}

#[tauri::command]
pub async fn pause_task(task_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut tree = state.task_tree.lock().await;
    tree.request_pause(&task_id);
    Ok(())
}

#[tauri::command]
pub async fn resume_task(task_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut tree = state.task_tree.lock().await;
    tree.request_resume(&task_id);
    Ok(())
}
```

- [ ] **Step 2: 前端 tauri.ts 封装**

```ts
export function killTask(taskId: string) { return invoke<void>('kill_task', { taskId }) }
export function pauseTask(taskId: string) { return invoke<void>('pause_task', { taskId }) }
export function resumeTask(taskId: string) { return invoke<void>('resume_task', { taskId }) }
```

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/api/commands.rs src/lib/tauri.ts src-tauri/src/lib.rs
git commit -m "feat(P2-E): add kill/pause/resume Tauri commands and frontend bindings"
```

---

## Task 9: StatusBar 活跃任务指示

**Files:**
- Modify: `src/components/StatusBar.vue`

- [ ] **Step 1: 添加活跃任务数显示**

在 StatusBar 右侧添加：

```vue
<span v-if="activeTaskCount > 0" class="text-blue-400">
  {{ activeTaskCount }} task{{ activeTaskCount > 1 ? 's' : '' }}
</span>
```

- [ ] **Step 2: Commit**

```bash
git add src/components/StatusBar.vue
git commit -m "feat(P2-E): add active task count indicator to StatusBar"
```
