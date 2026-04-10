# P2-A: TaskTree + 共享类型 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 建立 P2 所有模块共享的数据类型和基础设施：TaskNode、OrchestrateNode、TaskTree、AgentEvent 扩展、TranscriptEntry 扩展、ToolExecutionContext。

**Spec:** [2026-04-10-P2-task-tree/spec.md](spec.md)

---

## Task 1: 共享类型定义

**Files:**
- Create: `src-tauri/src/engine/task_tree.rs`
- Test: `src-tauri/src/engine/task_tree.rs` (inline `#[cfg(test)]`)

- [ ] **Step 1: 写 TaskNode/OrchestrateNode 类型测试**

```rust
// engine/task_tree.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_node_serialization_roundtrip() {
        let node = TaskNode {
            task_id: "da_3x7k9m2".into(),
            parent_id: None,
            session_id: "sess_123".into(),
            description: "探索代码结构".into(),
            status: TaskStatus::Pending,
            mode: AgentMode::Preset,
            subagent_type: Some("Explore".into()),
            created_at: "2026-04-11T10:00:00Z".into(),
            completed_at: None,
            transcript_path: None,
            output_file: None,
            budget: TaskBudget::default(),
            usage: TaskUsage::default(),
            children_ids: vec![],
            kill_requested: false,
            pause_requested: false,
        };
        let json = serde_json::to_string(&node).unwrap();
        let de: TaskNode = serde_json::from_str(&json).unwrap();
        assert_eq!(de.task_id, node.task_id);
        assert_eq!(de.status, TaskStatus::Pending);
    }

    #[test]
    fn orchestrate_node_serialization_roundtrip() {
        let node = OrchestrateNode {
            node_id: "or_5q8w1n4".into(),
            parent_id: None,
            session_id: "sess_123".into(),
            role: NodeRole::Executor,
            depth: 0,
            description: "分析代码".into(),
            status: OrchestrateStatus::Pending,
            directive: "分析 src 目录结构".into(),
            agent_id: "agent_abc".into(),
            conversation_path: PathBuf::from("data/sess_123/orchestrate/or_5q8w1n4.jsonl"),
            output_file: None,
            budget: TaskBudget::default(),
            usage: TaskUsage::default(),
            children_ids: vec![],
            feedback_history: vec![],
            reuse_count: 0,
            last_active_at: "2026-04-11T10:00:00Z".into(),
            kill_requested: false,
            pause_requested: false,
        };
        let json = serde_json::to_string(&node).unwrap();
        let de: OrchestrateNode = serde_json::from_str(&json).unwrap();
        assert_eq!(de.node_id, node.node_id);
        assert_eq!(de.role, NodeRole::Executor);
    }

    #[test]
    fn task_id_generation() {
        let id = generate_task_id("dispatch_agent");
        assert!(id.starts_with("da_"));
        assert_eq!(id.len(), 11); // "da_" + 8 chars

        let id2 = generate_task_id("orchestrate");
        assert!(id2.starts_with("or_"));
    }
}
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd src-tauri && cargo test task_node_serialization --no-run`
Expected: 编译失败（类型未定义）

- [ ] **Step 3: 实现类型定义**

```rust
// engine/task_tree.rs
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tokio::sync::Mutex;

// === 共享类型 ===

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TaskBudget {
    pub max_tokens: u32,
    pub max_turns: u32,
    pub max_tool_calls: u32,
}

impl Default for TaskBudget {
    fn default() -> Self {
        Self { max_tokens: 50_000, max_turns: 20, max_tool_calls: 100 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct TaskUsage {
    pub total_tokens: u32,
    pub tool_uses: u32,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum AgentMode {
    #[serde(rename = "preset")]
    Preset,
    #[serde(rename = "fork")]
    Fork,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
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
    #[serde(rename = "paused")]
    Paused,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum OrchestrateStatus {
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
    #[serde(rename = "paused")]
    Paused,
    #[serde(rename = "idle")]
    Idle,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum NodeRole {
    #[serde(rename = "orchestrator")]
    Orchestrator,
    #[serde(rename = "executor")]
    Executor,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum FeedbackDirection {
    #[serde(rename = "child_to_parent")]
    ChildToParent,
    #[serde(rename = "parent_to_child")]
    ParentToChild,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum FeedbackSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeedbackMessage {
    pub timestamp: String,
    pub direction: FeedbackDirection,
    pub message: String,
    pub severity: FeedbackSeverity,
}

// === ID 生成 ===

pub fn generate_task_id(node_type: &str) -> String {
    let prefix = match node_type {
        "dispatch_agent" => "da_",
        "orchestrate" => "or_",
        _ => "tk_",
    };
    let alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
    let random_part: String = (0..8)
        .map(|_| {
            let v = rand::random::<u8>() as usize % 36;
            alphabet.chars().nth(v).unwrap()
        })
        .collect();
    format!("{}{}", prefix, random_part)
}

// === TaskNode ===

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename = "task_node")]
pub struct TaskNode {
    pub task_id: String,
    pub parent_id: Option<String>,
    pub session_id: String,
    pub description: String,
    pub status: TaskStatus,
    pub mode: AgentMode,
    pub subagent_type: Option<String>,
    pub created_at: String,
    pub completed_at: Option<String>,
    pub transcript_path: Option<String>,
    pub output_file: Option<String>,
    pub budget: TaskBudget,
    pub usage: TaskUsage,
    pub children_ids: Vec<String>,
    pub kill_requested: bool,
    pub pause_requested: bool,
}

// === OrchestrateNode ===

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename = "orchestrate_node")]
pub struct OrchestrateNode {
    pub node_id: String,
    pub parent_id: Option<String>,
    pub session_id: String,
    pub role: NodeRole,
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

// === TaskTree ===

pub struct TaskTree {
    task_nodes: HashMap<String, TaskNode>,
    orchestrate_nodes: HashMap<String, OrchestrateNode>,
}

impl TaskTree {
    pub fn new() -> Self {
        Self {
            task_nodes: HashMap::new(),
            orchestrate_nodes: HashMap::new(),
        }
    }

    pub fn create_task_node(&mut self, node: TaskNode) {
        self.task_nodes.insert(node.task_id.clone(), node);
    }

    pub fn get_task_node(&self, id: &str) -> Option<&TaskNode> {
        self.task_nodes.get(id)
    }

    pub fn update_task_status(&mut self, id: &str, status: TaskStatus) {
        if let Some(node) = self.task_nodes.get_mut(id) {
            node.status = status;
        }
    }

    pub fn update_task_usage(&mut self, id: &str, usage: TaskUsage) {
        if let Some(node) = self.task_nodes.get_mut(id) {
            node.usage = usage;
        }
    }

    pub fn request_kill(&mut self, id: &str) {
        if let Some(node) = self.task_nodes.get_mut(id) {
            node.kill_requested = true;
        }
    }

    pub fn request_pause(&mut self, id: &str) {
        if let Some(node) = self.task_nodes.get_mut(id) {
            node.pause_requested = true;
        }
    }

    pub fn request_resume(&mut self, id: &str) {
        if let Some(node) = self.task_nodes.get_mut(id) {
            node.pause_requested = false;
        }
    }

    pub fn should_kill(&self, id: &str) -> bool {
        self.task_nodes.get(id).map(|n| n.kill_requested).unwrap_or(false)
    }

    pub fn should_pause(&self, id: &str) -> bool {
        self.task_nodes.get(id).map(|n| n.pause_requested).unwrap_or(false)
    }

    // OrchestrateNode 方法（对称实现，省略重复代码结构）
    pub fn create_orchestrate_node(&mut self, node: OrchestrateNode) {
        self.orchestrate_nodes.insert(node.node_id.clone(), node);
    }

    pub fn get_orchestrate_node(&self, id: &str) -> Option<&OrchestrateNode> {
        self.orchestrate_nodes.get(id)
    }

    pub fn get_orchestrate_node_mut(&mut self, id: &str) -> Option<&mut OrchestrateNode> {
        self.orchestrate_nodes.get_mut(id)
    }

    pub fn request_kill_tree(&mut self, node_id: &str) {
        // 设置自身 kill
        if let Some(node) = self.orchestrate_nodes.get_mut(node_id) {
            node.kill_requested = true;
        }
        // 递归设置所有子节点
        let children: Vec<String> = self.orchestrate_nodes.get(node_id)
            .map(|n| n.children_ids.clone())
            .unwrap_or_default();
        for child_id in children {
            self.request_kill_tree(&child_id);
        }
        // 同时检查 task_nodes 中是否有对应节点
        if let Some(node) = self.task_nodes.get_mut(node_id) {
            node.kill_requested = true;
        }
    }

    pub fn all_task_nodes(&self) -> Vec<&TaskNode> {
        self.task_nodes.values().collect()
    }

    pub fn all_orchestrate_nodes(&self) -> Vec<&OrchestrateNode> {
        self.orchestrate_nodes.values().collect()
    }
}
```

- [ ] **Step 4: 运行测试**

Run: `cd src-tauri && cargo test task_node --no-fail-fast`
Expected: PASS

- [ ] **Step 5: 注册模块到 engine/mod.rs**

在 `engine/mod.rs` 添加 `pub mod task_tree;`

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/engine/task_tree.rs src-tauri/src/engine/mod.rs
git commit -m "feat(P2-A): add TaskTree types — TaskNode, OrchestrateNode, shared types"
```

---

## Task 2: AgentEvent 扩展

**Files:**
- Modify: `src-tauri/src/types/event.rs`

- [ ] **Step 1: 写事件测试**

在 `types/event.rs` 的 `#[cfg(test)]` 中添加：

```rust
#[test]
fn task_event_serialization() {
    let event = AgentEvent::TaskCreated {
        session_id: "s1".into(),
        task_id: "da_3x7k9m2".into(),
        description: "探索代码".into(),
        mode: "preset".into(),
        subagent_type: "Explore".into(),
        budget: TaskBudgetSummary { max_tokens: 50000 },
    };
    let json = serde_json::to_string(&event).unwrap();
    assert!(json.contains("\"type\":\"TaskCreated\""));
    let de: AgentEvent = serde_json::from_str(&json).unwrap();
    assert!(matches!(de, AgentEvent::TaskCreated { .. }));
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd src-tauri && cargo test task_event_serialization`
Expected: 编译失败

- [ ] **Step 3: 添加新变体到 AgentEvent**

在 `types/event.rs` 的 `AgentEvent` enum 中追加：

```rust
// dispatch_agent 事件
TaskCreated { session_id: String, task_id: String, description: String, mode: String, subagent_type: String, budget: TaskBudgetSummary },
TaskProgress { session_id: String, task_id: String, usage: TaskUsageSummary },
TaskCompleted { session_id: String, task_id: String, status: String, result_summary: String, usage: TaskUsageSummary },
BudgetWarning { session_id: String, task_id: String, usage_percent: u32 },
TaskFeedback { session_id: String, task_id: String, message: String, severity: String },

// orchestrate 事件
OrchestrateNodeCreated { session_id: String, node_id: String, parent_id: Option<String>, role: String, depth: u32, description: String },
OrchestrateNodeProgress { session_id: String, node_id: String, usage: TaskUsageSummary },
OrchestrateNodeCompleted { session_id: String, node_id: String, status: String, result_summary: String, usage: TaskUsageSummary },
OrchestrateNodeIdle { session_id: String, node_id: String },
OrchestrateFeedback { session_id: String, node_id: String, direction: String, message: String, severity: String },
```

添加辅助类型：

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskBudgetSummary {
    pub max_tokens: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskUsageSummary {
    pub total_tokens: u32,
    pub tool_uses: u32,
    pub duration_ms: u64,
}
```

更新 `session_id()` 和 `variant_name()` match 分支。

- [ ] **Step 4: 运行测试**

Run: `cd src-tauri && cargo test task_event_serialization`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/types/event.rs
git commit -m "feat(P2-A): extend AgentEvent with dispatch/orchestrate event variants"
```

---

## Task 3: TranscriptEntry 扩展 + ToolExecutionContext

**Files:**
- Modify: `src-tauri/src/types/transcript.rs`
- Modify: `src-tauri/src/engine/tools/mod.rs`

- [ ] **Step 1: 添加 TranscriptEntry 变体**

在 `TranscriptEntry` enum 中追加：

```rust
#[serde(rename = "task_node")]
TaskNode {
    uuid: String,
    parent_uuid: Option<String>,
    timestamp: String,
    session_id: String,
    #[serde(flatten)]
    node: crate::engine::task_tree::TaskNode,
},
#[serde(rename = "orchestrate_node")]
OrchestrateNode {
    uuid: String,
    parent_uuid: Option<String>,
    timestamp: String,
    session_id: String,
    #[serde(flatten)]
    node: crate::engine::task_tree::OrchestrateNode,
},
#[serde(rename = "feedback")]
Feedback {
    uuid: String,
    parent_uuid: Option<String>,
    timestamp: String,
    session_id: String,
    task_id: String,
    message: String,
    severity: String,
},
```

更新 `uuid()` 和 `parent_uuid()` match 分支。

- [ ] **Step 2: 添加 ToolExecutionContext 到 tools/mod.rs**

```rust
use std::sync::Arc;
use crate::engine::task_tree::TaskTree;

pub struct ToolExecutionContext {
    pub task_tree: Arc<tokio::sync::Mutex<TaskTree>>,
    pub concurrency_manager: Arc<crate::engine::concurrency::ConcurrencyManager>,
    pub agent_templates: Arc<crate::engine::agent_template::AgentTemplateRegistry>,
    pub data_dir: std::path::PathBuf,
    pub session_id: String,
    pub event_tx: tokio::sync::mpsc::UnboundedSender<crate::types::AgentEvent>,
    pub api_messages: Vec<serde_json::Value>,
    pub current_assistant_content: Vec<crate::types::transcript::AssistantContentBlock>,
    pub tool_registry: Arc<ToolRegistry>,
}
```

- [ ] **Step 3: 更新 Tool trait 签名**

```rust
async fn call(&self, input: serde_json::Value, ctx: Option<&ToolExecutionContext>) -> ToolResult;
```

- [ ] **Step 4: 更新现有工具签名**

`tools/read/mod.rs`, `tools/write/mod.rs`, `tools/bash/mod.rs` 的 `call` 方法增加 `ctx: Option<&ToolExecutionContext>` 参数，内部 `let _ = ctx;`。

- [ ] **Step 5: 更新 execute_batch/execute_single 签名**

在 `tools/mod.rs` 中增加 `ctx: Option<&ToolExecutionContext>` 参数并透传到 `tool.call(call.input, ctx)`。

- [ ] **Step 6: 运行所有测试**

Run: `cd src-tauri && cargo test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/types/transcript.rs src-tauri/src/engine/tools/
git commit -m "feat(P2-A): extend TranscriptEntry + Tool trait with ToolExecutionContext"
```

---

## Task 4: LoadHistoryResult 扩展

**Files:**
- Modify: `src-tauri/src/store/jsonl.rs`

- [ ] **Step 1: 扩展 LoadHistoryResult**

```rust
#[derive(serde::Serialize)]
pub struct LoadHistoryResult {
    pub entries: Vec<TranscriptEntry>,
    pub conversation_summary: Option<String>,
    pub task_nodes: Vec<crate::engine::task_tree::TaskNode>,
    pub orchestrate_nodes: Vec<crate::engine::task_tree::OrchestrateNode>,
    pub pending_async_results: Vec<AsyncResult>,
}

#[derive(serde::Serialize)]
pub struct AsyncResult {
    pub task_id: String,
    pub description: String,
    pub status: String,
    pub result_summary: String,
    pub output_file: Option<String>,
}
```

- [ ] **Step 2: 更新 load_history 从 entries 中提取 TaskNode/OrchestrateNode**

在 `load_history` 函数中，遍历 entries，将 `TranscriptEntry::TaskNode` 和 `TranscriptEntry::OrchestrateNode` 收集到对应字段。

- [ ] **Step 3: 运行测试**

Run: `cd src-tauri && cargo test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/store/jsonl.rs
git commit -m "feat(P2-A): extend LoadHistoryResult with task_nodes and orchestrate_nodes"
```

---

## Task 5: AppState 扩展

**Files:**
- Modify: `src-tauri/src/api/mod.rs`

- [ ] **Step 1: 添加 P2 字段到 AppState**

```rust
pub struct AppState {
    // P0/P1 现有字段
    pub data_dir: PathBuf,
    pub provider: Arc<dyn LlmProvider>,
    pub model: String,
    pub config: Arc<AgentConfig>,
    pub tool_registry: Arc<ToolRegistry>,
    pub global_perms: PermissionContext,
    // P2 新增
    pub task_tree: Arc<tokio::sync::Mutex<TaskTree>>,
    pub concurrency_manager: Arc<ConcurrencyManager>,
    pub background_tasks: Arc<tokio::sync::Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>,
    pub agent_templates: Arc<AgentTemplateRegistry>,
}
```

- [ ] **Step 2: 更新 lib.rs setup 闭包中的 AppState 初始化**

- [ ] **Step 3: 运行 cargo check**

Run: `cd src-tauri && cargo check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/api/mod.rs src-tauri/src/lib.rs
git commit -m "feat(P2-A): extend AppState with TaskTree, ConcurrencyManager, background_tasks"
```
