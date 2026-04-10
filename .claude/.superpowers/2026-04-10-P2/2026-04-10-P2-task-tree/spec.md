# P2-TaskTree 设计规格

**版本**: v3 | **日期**: 2026-04-10 | **状态**: 设计中

---

## 目标

管理 SubAgent 的树形结构：追踪节点状态、预算消耗。TreeNode 专属于 SubAgent，主 Agent 不是 TreeNode。

## 核心类型

### TaskNode

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename = "task_node")]
pub struct TaskNode {
    pub task_id: String,
    pub parent_id: Option<String>,      // 父 SubAgent 的 task_id（P2 通常为 None）
    pub session_id: String,
    pub description: String,            // 3-5 词摘要
    pub status: TaskStatus,
    pub mode: AgentMode,                // preset / fork
    pub subagent_type: Option<String>,
    pub created_at: String,             // ISO timestamp
    pub completed_at: Option<String>,
    // 关联
    pub transcript_path: Option<String>,  // SubAgent 独立 JSONL 路径
    pub output_file: Option<String>,      // 完整输出文件路径
    // 预算
    pub budget: TaskBudget,
    pub usage: TaskUsage,
    // 子节点
    pub children_ids: Vec<String>,
    // 控制
    pub kill_requested: bool,           // 用户请求终止
}
```

### TaskStatus 状态机（含用户干预）

```
pending → running → completed
                 → failed
                 → budget_exhausted
running ⇄ paused              ← 用户干预
running → killed              ← 用户干预
paused → killed               ← 用户干预
```

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum TaskStatus {
    #[serde(rename = "pending")]
    Pending,
    #[serde(rename = "running")]
    Running,
    #[serde(rename = "paused")]
    Paused,
    #[serde(rename = "completed")]
    Completed,
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "budget_exhausted")]
    BudgetExhausted,
    #[serde(rename = "killed")]
    Killed,
}
```

### TaskBudget / TaskUsage

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
```

### AgentMode

```rust
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
    nodes: HashMap<String, TaskNode>,
    max_depth: usize,   // 默认 5（P2 实际上限 2：主→子）
    max_width: usize,   // 默认 10
}
```

AppState 中使用 `Arc<Mutex<TaskTree>>` 提供内部可变性。

关键方法：
- `create_node(task_id, parent_id, ...)` — 创建并注册
- `update_status(task_id, status)` — 状态转换
- `update_usage(task_id, usage)` — 用量更新
- `request_kill(task_id)` — 标记 kill_requested=true
- `request_pause(task_id)` — 状态改为 Paused
- `request_resume(task_id)` — 状态改为 Running
- `should_pause(task_id) → bool` — 检查是否应暂停（AgentLoop 每轮检查）
- `should_kill(task_id) → bool` — 检查是否应终止

---

## 持久化（Sidechain 模式）

借鉴 Claude Code 的 sidechain 模式。SubAgent 对话与主 session 物理隔离。

### 目录结构

```
{data_dir}/
├── {session_id}.jsonl              # 主 session（不含 SubAgent 对话）
├── {session_id}/
│   └── subagents/
│       ├── {task_id}.jsonl         # SubAgent 独立对话
│       └── {task_id}.meta.json     # TaskNode 元数据快照
└── tasks/
    └── output/
        └── {task_id}.txt           # SubAgent 完整输出
```

### TaskNode 元数据存主 JSONL

TaskNode 仍作为 TranscriptEntry 变体存入主 session JSONL：

```rust
// TranscriptEntry 新增变体
#[serde(rename = "task_node")]
TaskNode { /* TaskNode 的全部字段 */ }
```

TaskNode 变体**没有** `uuid` 和 `parent_uuid` 字段。`TranscriptEntry::uuid()` 和 `parent_uuid()` 需更新 match 分支，返回 `""` 和 `None`。

### SubAgent 对话存独立 JSONL

SubAgent 的 User/Assistant/Summary entry 写入 `{session_id}/subagents/{task_id}.jsonl`。格式与主 session JSONL 相同（每行一个 JSON 对象）。

写入路径通过 `ToolExecutionContext` 中的 `data_dir` + `session_id` + `task_id` 构建。dispatch_agent 内部调用独立的 `append_entry` 写入。

### 主 session 加载不受影响

`load_history` 加载主 session JSONL，其中 TaskNode 变体的 `transcript_path` 字段指向 SubAgent 独立文件。主 Agent 的 User/Assistant entry 不受影响。

```rust
pub struct LoadHistoryResult {
    pub entries: Vec<TranscriptEntry>,       // 主 session entry（含 TaskNode）
    pub conversation_summary: Option<String>,
    pub task_nodes: Vec<TaskNode>,           // 解析出的 TaskNode 列表
}
```

前端通过 `task_nodes` 展示任务树。需要查看 SubAgent 对话时，调用 `get_subagent_history(task_id)` 从独立 JSONL 加载。

---

## 用户干预机制

### 后端

TaskTree 的 `request_kill` / `request_pause` / `request_resume` 由前端 Tauri command 调用：

```rust
#[tauri::command]
async fn pause_task(session_id: String, task_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.task_tree.lock().await.request_pause(&task_id).map_err(|e| e.to_string())
}
```

AgentLoop 每轮迭代检查：
```rust
if let Some(tree) = &task_tree {
    let tree = tree.lock().await;
    if tree.should_kill(&task_id) {
        break; // 终止循环
    }
    while tree.should_pause(&task_id) {
        drop(tree);
        tokio::time::sleep(Duration::from_millis(500)).await;
        tree = task_tree.lock().await;
    }
}
```

### 前端

TaskDetail.vue 中显示操作按钮：
- running → [暂停] [终止]
- paused → [恢复] [终止]
- completed/failed → [查看对话]

---

## 约束

- TaskTree 不 import tauri
- AppState 使用 `Arc<Mutex<TaskTree>>`
- SubAgent 对话存独立 JSONL（sidechain 模式）
- TaskNode 元数据存主 session JSONL（append-only）
- 禁止嵌套保证 max_depth ≤ 2（P2）
- TranscriptEntry 的 `uuid()`/`parent_uuid()` 需更新

## 已知限制

- **不支持 SubAgent resume** — P2 不实现从断点恢复 SubAgent 执行
- **无独立 compact** — SubAgent 的上下文压缩随 AgentLoop 复用主逻辑
- **加载全量** — load_history 加载全部 TaskNode
