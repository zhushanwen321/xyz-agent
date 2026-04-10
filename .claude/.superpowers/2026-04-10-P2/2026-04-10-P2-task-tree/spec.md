# P2-TaskTree 设计规格

**版本**: v5 | **日期**: 2026-04-10 | **状态**: 设计中

---

## 目标

管理 SubAgent（dispatch_agent）和编排节点（orchestrate）的树形结构。TaskNode 用于一次性 SubAgent，OrchestrateNode 用于编排模式。

---

## TaskNode（dispatch_agent 用）

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename = "task_node")]
pub struct TaskNode {
    pub task_id: String,              // uuid 生成，同时作为 TranscriptEntry 的 uuid
    pub parent_id: Option<String>,
    pub session_id: String,
    pub description: String,
    pub status: TaskStatus,
    pub mode: AgentMode,              // preset / fork
    pub subagent_type: Option<String>,
    pub created_at: String,
    pub completed_at: Option<String>,
    pub transcript_path: Option<String>,
    pub output_file: Option<String>,
    pub budget: TaskBudget,
    pub usage: TaskUsage,
    pub children_ids: Vec<String>,    // P2 通常为空（不嵌套）
    pub kill_requested: bool,
    pub pause_requested: bool,
}
```

### TaskStatus 状态机

```
pending → running → completed
                 → failed
                 → budget_exhausted
running ⇄ paused              ← 用户干预
running/paused → killed       ← 用户干预
```

---

## OrchestrateNode（orchestrate 用）

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename = "orchestrate_node")]
pub struct OrchestrateNode {
    pub node_id: String,
    pub parent_id: Option<String>,
    pub session_id: String,
    pub role: NodeRole,               // Orchestrator / Executor
    pub depth: u32,
    pub description: String,
    pub status: OrchestrateStatus,
    pub directive: String,
    pub agent_id: String,
    pub conversation_path: PathBuf,
    pub output_file: Option<PathBuf>,
    pub budget: TaskBudget,
    pub usage: TaskUsage,
    pub children_ids: Vec<String>,
    pub feedback_history: Vec<FeedbackMessage>,
    pub reuse_count: u32,
    pub last_active_at: String,
    pub kill_requested: bool,
    pub pause_requested: bool,
}
```

### OrchestrateStatus 状态机

```
pending → running → completed
                 → failed
                 → budget_exhausted
running → idle            ← run_turn 结束，等待复用
idle → running            ← 被复用
running ⇄ paused          ← 用户干预 / feedback error 暂停
running/paused/idle → killed  ← 级联终止
idle → completed          ← 10分钟超时自动清理
```

---

## 共享类型

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskBudget {
    pub max_tokens: u32,
    pub max_turns: u32,
    pub max_tool_calls: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskUsage {
    pub total_tokens: u32,
    pub tool_uses: u32,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AgentMode {
    #[serde(rename = "preset")]
    Preset,
    #[serde(rename = "fork")]
    Fork,
}
```

---

## TaskTree

```rust
pub struct TaskTree {
    task_nodes: HashMap<String, TaskNode>,
    orchestrate_nodes: HashMap<String, OrchestrateNode>,
}
```

### TaskNode 方法
- `create_task_node(...)` — 创建并注册
- `update_status(id, status)` — 状态转换
- `update_usage(id, usage)` — 用量更新
- `request_kill(id)` — kill_requested=true
- `request_pause(id)` / `request_resume(id)`
- `should_pause(id) → bool` / `should_kill(id) → bool`

### AgentLoop 集成

`run_turn` 每轮循环检查 pause/kill 状态：

```rust
// run_turn 内部
if task_tree.should_kill(&node_id).await {
    break; // → status = killed
}
if task_tree.should_pause(&node_id).await {
    // 暂停循环：每秒检查是否恢复或终止
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        if !task_tree.should_pause(&node_id).await { break; }
        if task_tree.should_kill(&node_id).await { break; }
    }
}
```

这确保级联终止（request_kill_tree）和用户暂停操作能在 1 秒内响应。

### OrchestrateNode 方法
- `create_orchestrate_node(...)` — 创建并注册
- `update_status(id, status)` — 状态转换
- `append_feedback(id, msg)` — 追加反馈
- `mark_idle(id)` — 标记空闲
- `reactivate(id, new_directive, new_budget)` — 复用激活
- `request_kill_tree(id)` — **级联终止**：递归设置所有子节点 kill_requested
- `get_idle_agents(owner_id) → Vec<&OrchestrateNode>` — 获取可复用的空闲 Agent
- `cleanup_idle(timeout_secs: u64)` — 清理超时空闲 Agent

---

## 持久化（Sidechain 模式）

### 目录结构

```
{data_dir}/
├── {session_id}.jsonl                    # 主 session
├── {session_id}/
│   ├── subagents/
│   │   └── {task_id}.jsonl               # dispatch_agent SubAgent 对话
│   └── orchestrate/
│       └── {node_id}.jsonl               # orchestrate Agent 对话
└── tasks/
    └── output/
        └── {task_id}.txt                 # 完整输出
```

### 元数据写入

TaskNode 和 OrchestrateNode 都作为 TranscriptEntry 变体存入主 session JSONL。TranscriptEntry 新增变体：

```rust
// TranscriptEntry 扩展
| TaskNode { ... }            // dispatch_agent 元数据
| OrchestrateNode { ... }     // orchestrate 元数据
| Feedback { ... }            // 反馈消息（可来自任一系统）
```

### LoadHistoryResult 扩展

```rust
pub struct LoadHistoryResult {
    pub entries: Vec<TranscriptEntry>,
    pub conversation_summary: Option<String>,
    pub task_nodes: Vec<TaskNode>,
    pub orchestrate_nodes: Vec<OrchestrateNode>,
    // 异步任务：已完成但尚未注入的结果
    pub pending_async_results: Vec<AsyncResult>,
}

pub struct AsyncResult {
    pub task_id: String,
    pub description: String,
    pub status: String,       // completed / failed
    pub result_summary: String,
    pub output_file: Option<String>,
}
```

---

## AppState 扩展

```rust
pub struct AppState {
    // 现有字段...
    pub task_tree: Arc<tokio::sync::Mutex<TaskTree>>,
    pub concurrency_manager: Arc<ConcurrencyManager>,
    pub background_tasks: Arc<tokio::sync::Mutex<HashMap<String, JoinHandle<()>>>>,
    pub agent_templates: Arc<AgentTemplateRegistry>,
}
```

---

## 约束

- TaskTree 不 import tauri
- SubAgent 禁止嵌套（dispatch_agent + orchestrate 都排除）
- 编排深度 MAX_DEPTH=5
- Agent 所有权：只有创建者可复用
- 空闲超时 10 分钟
- TranscriptEntry 的 uuid()/parent_uuid() 需更新 match 分支
