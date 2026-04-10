# P2-TaskTree 设计规格

**版本**: v1 | **日期**: 2026-04-10 | **状态**: 设计中

---

## 目标

管理 SubAgent 的树形结构：追踪节点状态、预算消耗、关联 TranscriptEntry。

## 核心类型

### TaskNode

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename = "task_node")]
pub struct TaskNode {
    pub task_id: String,
    pub parent_id: Option<String>,
    pub session_id: String,
    pub description: String,           // 3-5 词摘要
    pub status: TaskStatus,
    pub mode: AgentMode,               // preset / fork
    pub subagent_type: Option<String>,
    pub created_at: String,            // ISO timestamp
    pub completed_at: Option<String>,
    // 关联
    pub transcript_start: Option<String>,  // 第一条 entry uuid
    pub transcript_end: Option<String>,    // 最后一条 entry uuid
    pub output_file: Option<String>,       // 完整输出文件路径
    // 预算
    pub budget: TaskBudget,
    pub usage: TaskUsage,
    // 子节点
    pub children_ids: Vec<String>,
}
```

### TaskStatus 状态机

```
pending → running → completed
                 → failed
                 → budget_exhausted
running → killed（用户终止）
```

P2 实际只会看到 pending → running → completed/failed/budget_exhausted。killed 预留。

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum TaskStatus {
    #[serde(rename = "pending")]
    Pending,
    #[serde(rename = "running")]
    Running,
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

关键方法：
- `create_node(task_id, parent_id, ...)` — 创建并注册
- `update_status(task_id, status)` — 状态转换
- `update_usage(task_id, usage)` — 用量更新
- `get(task_id) → Option<&TaskNode>`
- `children_of(task_id) → Vec<&TaskNode>`
- `active_tasks() -> Vec<&TaskNode>` — status=running 的节点

---

## 持久化

### 方案：TaskNode 作为 TranscriptEntry 变体

TaskNode 直接嵌入 TranscriptEntry 枚举，存入现有 JSONL：

```rust
// TranscriptEntry 新增变体
#[serde(rename = "task_node")]
TaskNode { /* TaskNode 的全部字段 */ }
```

### 写入时机

每个 TaskNode 写入两次（append-only）：
1. **创建时**：status=running，usage=空，transcript_start/end/output_file=None
2. **完成时**：status=completed/failed/budget_exhausted，填入 usage、transcript_end、output_file

加载时对同 task_id 的记录取最后一条（覆盖更新）。

### TranscriptEntry 关联

SubAgent 产生的 User/Assistant/Summary entry 照常追加到 JSONL。通过 `transcript_start` 和 `transcript_end` 的 uuid 范围关联到 TaskNode。

```
JSONL 内容：
  {"type":"task_node","task_id":"t1","status":"running",...}    ← 创建
  {"type":"user","uuid":"u1",...}                               ← SubAgent 的对话
  {"type":"assistant","uuid":"a1",...}
  {"type":"user","uuid":"u2",...}
  {"type":"assistant","uuid":"a2",...}
  {"type":"task_node","task_id":"t1","status":"completed","transcript_start":"u1","transcript_end":"a2",...}  ← 完成
```

### load_history 变更

`load_history` 需识别 TaskNode 类型：
- 收集所有 TaskNode 到 `Vec<TaskNode>`，同 task_id 取最后一条
- `LoadHistoryResult` 新增 `task_nodes: Vec<TaskNode>`

```rust
pub struct LoadHistoryResult {
    pub entries: Vec<TranscriptEntry>,
    pub conversation_summary: Option<String>,
    pub task_nodes: Vec<TaskNode>,        // NEW
}
```

---

## 约束

- TaskTree 不 import tauri
- append-only 持久化（不修改已有记录）
- 禁止嵌套保证 max_depth ≤ 2（P2）
- 同 task_id 取最后一条记录

## 已知限制

- **无用户干预** — P2 不实现暂停/恢复/终止（killed 状态预留）
- **无独立 transcript 文件** — SubAgent entry 与主 session 混在同一个 JSONL
- **加载全量** — load_history 加载全部 TaskNode，不做增量
