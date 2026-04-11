use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use chrono::Utc;
use serde::{Deserialize, Serialize};
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
    pub kill_requested: bool,
    pub pause_requested: bool,
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
    pub kill_requested: bool,
    pub pause_requested: bool,
}

pub struct TaskTree {
    task_nodes: HashMap<String, TaskNode>,
    orchestrate_nodes: HashMap<String, OrchestrateNode>,
    /// 每个 task node 的 pause 唤醒通知器，resume/kill 时触发
    pause_notifiers: HashMap<String, Arc<tokio::sync::Notify>>,
}

impl TaskTree {
    pub fn new() -> Self {
        Self {
            task_nodes: HashMap::new(),
            orchestrate_nodes: HashMap::new(),
            pause_notifiers: HashMap::new(),
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
            kill_requested: false,
            pause_requested: false,
        };
        let id = node.task_id.clone();
        self.task_nodes.insert(id.clone(), node);
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
        if let Some(node) = self.task_nodes.get_mut(id) {
            node.kill_requested = true;
            // 唤醒暂停等待，使 agent loop 退出
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
        } else {
            false
        }
    }

    pub fn request_resume(&mut self, id: &str) -> bool {
        if let Some(node) = self.task_nodes.get_mut(id) {
            node.pause_requested = false;
            // 即时唤醒暂停等待中的 agent loop
            if let Some(notify) = self.pause_notifiers.get(id) {
                notify.notify_one();
            }
            true
        } else {
            false
        }
    }

    pub fn should_kill(&self, id: &str) -> bool {
        self.task_nodes.get(id).map_or(false, |n| n.kill_requested)
    }

    pub fn should_pause(&self, id: &str) -> bool {
        self.task_nodes.get(id).map_or(false, |n| n.pause_requested)
    }

    /// 获取或创建节点的 pause Notify，用于 resume/kill 时即时唤醒
    pub fn get_or_create_notifier(&mut self, id: &str) -> Arc<tokio::sync::Notify> {
        self.pause_notifiers
            .entry(id.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Notify::new()))
            .clone()
    }

    pub fn create_orchestrate_node(
        &mut self,
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
        let node_id = generate_task_id("orchestrate");
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
            kill_requested: false,
            pause_requested: false,
        };
        let id = node.node_id.clone();
        self.orchestrate_nodes.insert(id.clone(), node);
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

    /// 级联终止：设置目标节点及其所有后代的 kill_requested
    pub fn request_kill_tree(&mut self, id: &str) -> bool {
        let mut found = false;
        let mut queue = vec![id.to_string()];
        let mut notified_ids: Vec<String> = Vec::new();

        while let Some(current_id) = queue.pop() {
            let children = if let Some(node) = self.orchestrate_nodes.get_mut(&current_id) {
                found = true;
                node.kill_requested = true;
                node.children_ids.clone()
            } else if let Some(node) = self.task_nodes.get_mut(&current_id) {
                found = true;
                node.kill_requested = true;
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
}

#[cfg(test)]
#[path = "task_tree_tests.rs"]
mod tests;
