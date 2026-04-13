use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskBudget {
    pub max_tokens: u32,
    pub max_turns: u32,
    pub max_tool_calls: u32,
}

impl Default for TaskBudget {
    fn default() -> Self {
        Self {
            max_tokens: 50_000,
            max_turns: 20,
            max_tool_calls: 100,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskUsage {
    pub total_tokens: u32,
    pub tool_uses: u32,
    pub duration_ms: u64,
}

impl Default for TaskUsage {
    fn default() -> Self {
        Self {
            total_tokens: 0,
            tool_uses: 0,
            duration_ms: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentMode {
    Preset,
    Fork,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    Running,
    Completed,
    Failed,
    BudgetExhausted,
    Killed,
    Paused,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OrchestrateStatus {
    Idle,
    Pending,
    Running,
    Completed,
    Failed,
    BudgetExhausted,
    Killed,
    Paused,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NodeRole {
    Orchestrator,
    Executor,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FeedbackDirection {
    ChildToParent,
    ParentToChild,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
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

pub fn generate_task_id(node_type: &str) -> String {
    let prefix = match node_type {
        "dispatch_agent" => "da_",
        "orchestrate" => "or_",
        _ => "tk_",
    };
    let uuid_str = Uuid::new_v4().to_string().replace("-", "");
    let random_part: String = uuid_str
        .chars()
        .take(8)
        .map(|c| {
            // hex digit (0-9a-f) → base36 (0-9, a-z)
            let val = c.to_digit(16).unwrap_or(0);
            if val < 10 {
                (b'0' + val as u8) as char
            } else {
                (b'a' + (val - 10) as u8) as char
            }
        })
        .collect();
    format!("{}{}", prefix, random_part)
}

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
    pub pause_requested: bool,
    /// 子 Agent 执行完成后的结果摘要
    pub result_summary: Option<String>,
    /// 结果是否已注入到父 Agent 对话中
    pub result_injected: bool,
}

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
    pub pause_requested: bool,
    /// 结果是否已注入到父 Agent 对话中
    pub result_injected: bool,
    pub result_summary: Option<String>,
}

/// 异步任务结果，用于注入到下一轮对话
pub struct AsyncTaskResult {
    pub task_id: String,
    pub description: String,
    pub result_summary: String,
}

pub struct TaskTree {
    task_nodes: HashMap<String, TaskNode>,
    orchestrate_nodes: HashMap<String, OrchestrateNode>,
    /// 每个 task node 的 pause 唤醒通知器，resume/kill 时触发
    pause_notifiers: HashMap<String, Arc<tokio::sync::Notify>>,
    /// 每个节点的 CancellationToken，替代 kill_requested（CancellationToken 不可序列化，不能放在 node struct 上）
    /// 注意：cancel_tokens 随节点生命周期存在，不做主动清理。session 期间节点数量有限（通常 <100），可接受。
    cancel_tokens: HashMap<String, CancellationToken>,
}

impl TaskTree {
    /// Maximum allowed depth for orchestrate nodes to prevent infinite recursion
    const MAX_ORCHESTRATE_DEPTH: u32 = 20;

    pub fn new() -> Self {
        Self {
            task_nodes: HashMap::new(),
            orchestrate_nodes: HashMap::new(),
            pause_notifiers: HashMap::new(),
            cancel_tokens: HashMap::new(),
        }
    }

    pub fn create_task_node(
        &mut self,
        parent_id: Option<String>,
        session_id: &str,
        description: &str,
        mode: AgentMode,
        subagent_type: Option<String>,
        budget: Option<TaskBudget>,
    ) -> &TaskNode {
        let task_id = generate_task_id("dispatch_agent");
        let node = TaskNode {
            task_id,
            parent_id,
            session_id: session_id.to_string(),
            description: description.to_string(),
            status: TaskStatus::Pending,
            mode,
            subagent_type,
            created_at: Utc::now().to_rfc3339(),
            completed_at: None,
            transcript_path: None,
            output_file: None,
            budget: budget.unwrap_or_default(),
            usage: TaskUsage::default(),
            children_ids: Vec::new(),
            pause_requested: false,
            result_summary: None,
            result_injected: false,
        };
        let id = node.task_id.clone();
        self.task_nodes.insert(id.clone(), node);
        self.cancel_tokens.insert(id.clone(), CancellationToken::new());
        self.task_nodes.get(&id).unwrap()
    }

    pub fn get_task_node(&self, id: &str) -> Option<&TaskNode> {
        self.task_nodes.get(id)
    }

    pub fn update_task_status(&mut self, id: &str, status: TaskStatus) -> bool {
        if let Some(node) = self.task_nodes.get_mut(id) {
            node.status = status;
            if matches!(
                status,
                TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Killed | TaskStatus::BudgetExhausted
            ) {
                node.completed_at = Some(Utc::now().to_rfc3339());
            }
            true
        } else {
            false
        }
    }

    pub fn update_task_usage(&mut self, id: &str, usage: TaskUsage) -> bool {
        if let Some(node) = self.task_nodes.get_mut(id) {
            node.usage = usage;
            true
        } else {
            false
        }
    }

    pub fn request_kill(&mut self, id: &str) -> bool {
        if let Some(token) = self.cancel_tokens.get(id) {
            token.cancel();
            if let Some(notify) = self.pause_notifiers.get(id) {
                notify.notify_one();
            }
            true
        } else {
            false
        }
    }

    pub fn request_pause(&mut self, id: &str) -> bool {
        if let Some(node) = self.task_nodes.get_mut(id) {
            node.pause_requested = true;
            true
        } else if let Some(node) = self.orchestrate_nodes.get_mut(id) {
            node.pause_requested = true;
            true
        } else {
            false
        }
    }

    pub fn request_resume(&mut self, id: &str) -> bool {
        if let Some(node) = self.task_nodes.get_mut(id) {
            node.pause_requested = false;
            if let Some(notify) = self.pause_notifiers.get(id) {
                notify.notify_one();
            }
            true
        } else if let Some(node) = self.orchestrate_nodes.get_mut(id) {
            node.pause_requested = false;
            true
        } else {
            false
        }
    }

    pub fn should_kill(&self, id: &str) -> bool {
        self.cancel_tokens.get(id).map_or(false, |t| t.is_cancelled())
    }

    pub fn should_pause(&self, id: &str) -> bool {
        self.task_nodes.get(id).map_or(false, |n| n.pause_requested)
            || self.orchestrate_nodes.get(id).map_or(false, |n| n.pause_requested)
    }

    /// 获取或创建节点的 pause Notify，用于 resume/kill 时即时唤醒
    pub fn get_or_create_notifier(&mut self, id: &str) -> Arc<tokio::sync::Notify> {
        self.pause_notifiers
            .entry(id.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Notify::new()))
            .clone()
    }

    /// 获取节点的 CancellationToken
    pub fn get_cancel_token(&self, id: &str) -> Option<&CancellationToken> {
        self.cancel_tokens.get(id)
    }

    /// 为节点注入 CancellationToken（用于子 Agent 从父级派生 child token）
    pub fn set_cancel_token(&mut self, id: String, token: CancellationToken) {
        self.cancel_tokens.insert(id, token);
    }

    pub fn create_orchestrate_node(
        &mut self,
        node_id: String,
        parent_id: Option<String>,
        session_id: &str,
        role: NodeRole,
        depth: u32,
        description: &str,
        directive: &str,
        agent_id: &str,
        conversation_path: PathBuf,
        budget: Option<TaskBudget>,
    ) -> &OrchestrateNode {
        // Prevent infinite recursion by enforcing maximum depth
        assert!(
            depth <= Self::MAX_ORCHESTRATE_DEPTH,
            "orchestrate depth {} exceeds maximum allowed depth {}",
            depth,
            Self::MAX_ORCHESTRATE_DEPTH
        );

        // Prevent duplicate node_id entries
        if self.orchestrate_nodes.contains_key(&node_id) {
            return self.orchestrate_nodes.get(&node_id).unwrap();
        }

        let pid = parent_id.clone();
        let node = OrchestrateNode {
            node_id,
            parent_id,
            session_id: session_id.to_string(),
            role,
            depth,
            description: description.to_string(),
            status: OrchestrateStatus::Pending,
            directive: directive.to_string(),
            agent_id: agent_id.to_string(),
            conversation_path,
            output_file: None,
            budget: budget.unwrap_or_default(),
            usage: TaskUsage::default(),
            children_ids: Vec::new(),
            feedback_history: Vec::new(),
            reuse_count: 0,
            last_active_at: Utc::now().to_rfc3339(),
            pause_requested: false,
            result_injected: false,
            result_summary: None,
        };
        let id = node.node_id.clone();
        self.orchestrate_nodes.insert(id.clone(), node);
        self.cancel_tokens.insert(id.clone(), CancellationToken::new());
        // 自动维护父节点的 children_ids
        if let Some(ref pid) = pid {
            if let Some(parent) = self.orchestrate_nodes.get_mut(pid) {
                parent.children_ids.push(id.clone());
            }
        }
        self.orchestrate_nodes.get(&id).unwrap()
    }

    pub fn get_orchestrate_node(&self, id: &str) -> Option<&OrchestrateNode> {
        self.orchestrate_nodes.get(id)
    }

    pub fn get_orchestrate_node_mut(&mut self, id: &str) -> Option<&mut OrchestrateNode> {
        self.orchestrate_nodes.get_mut(id)
    }

    /// 级联终止：cancel 目标节点及其所有后代的 CancellationToken
    pub fn request_kill_tree(&mut self, id: &str) -> bool {
        let mut found = false;
        let mut queue = vec![id.to_string()];
        let mut notified_ids: Vec<String> = Vec::new();
        let mut visited = std::collections::HashSet::new();

        while let Some(current_id) = queue.pop() {
            // Prevent processing the same node twice in case of cycles
            if !visited.insert(current_id.clone()) {
                continue;
            }

            let children = if let Some(node) = self.orchestrate_nodes.get_mut(&current_id) {
                found = true;
                if let Some(token) = self.cancel_tokens.get(&current_id) {
                    token.cancel();
                }
                node.children_ids.clone()
            } else if let Some(node) = self.task_nodes.get_mut(&current_id) {
                found = true;
                if let Some(token) = self.cancel_tokens.get(&current_id) {
                    token.cancel();
                }
                notified_ids.push(current_id.clone());
                node.children_ids.clone()
            } else {
                Vec::new()
            };
            queue.extend(children);
        }

        // 唤醒所有被终止的 task node（orchestrate node 由 AgentSpawner 管理）
        for nid in &notified_ids {
            if let Some(notify) = self.pause_notifiers.get(nid) {
                notify.notify_one();
            }
        }

        found
    }

    pub fn all_task_nodes(&self) -> Vec<&TaskNode> {
        self.task_nodes.values().collect()
    }

    pub fn all_orchestrate_nodes(&self) -> Vec<&OrchestrateNode> {
        self.orchestrate_nodes.values().collect()
    }

    /// 设置节点结果摘要（同时查找 task_nodes 和 orchestrate_nodes）
    pub fn set_task_result(&mut self, task_id: &str, summary: String) -> bool {
        if let Some(node) = self.task_nodes.get_mut(task_id) {
            node.result_summary = Some(summary);
            return true;
        }
        if let Some(node) = self.orchestrate_nodes.get_mut(task_id) {
            node.result_summary = Some(summary);
            return true;
        }
        false
    }

    /// 查询指定 session 中已完成但未注入结果的任务（包含 task_nodes 和 orchestrate_nodes）
    pub fn completed_not_injected(&self, session_id: &str) -> Vec<AsyncTaskResult> {
        let tasks: Vec<AsyncTaskResult> = self.task_nodes
            .values()
            .filter(|n| {
                n.session_id == session_id
                    && matches!(n.status, TaskStatus::Completed)
                    && !n.result_injected
                    && n.result_summary.is_some()
            })
            .map(|n| AsyncTaskResult {
                task_id: n.task_id.clone(),
                description: n.description.clone(),
                result_summary: n.result_summary.clone().unwrap_or_default(),
            })
            .collect();

        let orch: Vec<AsyncTaskResult> = self.orchestrate_nodes
            .values()
            .filter(|n| {
                n.session_id == session_id
                    && matches!(n.status, OrchestrateStatus::Completed)
                    && !n.result_injected
                    && n.result_summary.is_some()
            })
            .map(|n| AsyncTaskResult {
                task_id: n.node_id.clone(),
                description: n.description.clone(),
                result_summary: n.result_summary.clone().unwrap_or_default(),
            })
            .collect();

        let mut all = tasks;
        all.extend(orch);
        all
    }

    /// 标记结果已注入（同时查找 task_nodes 和 orchestrate_nodes）
    pub fn mark_result_injected(&mut self, task_id: &str) -> bool {
        if let Some(node) = self.task_nodes.get_mut(task_id) {
            node.result_injected = true;
            return true;
        }
        if let Some(node) = self.orchestrate_nodes.get_mut(task_id) {
            node.result_injected = true;
            return true;
        }
        false
    }
}

#[cfg(test)]
#[path = "task_tree_tests.rs"]
mod tests;
