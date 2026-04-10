use std::collections::HashMap;
use std::path::PathBuf;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/// 根据节点类型生成带前缀的唯一 ID。
/// dispatch_agent → "da_", orchestrate → "or_", 其他 → "tk_"
pub fn generate_task_id(node_type: &str) -> String {
    let prefix = match node_type {
        "dispatch_agent" => "da_",
        "orchestrate" => "or_",
        _ => "tk_",
    };
    // 使用 uuid 的随机字节取前 8 个，转为 base36
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

// ---------------------------------------------------------------------------
// TaskNode
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// OrchestrateNode
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// TaskTree
// ---------------------------------------------------------------------------

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

    // -- TaskNode methods --------------------------------------------------

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

    // -- OrchestrateNode methods -------------------------------------------

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

        while let Some(current_id) = queue.pop() {
            // 收集子节点 ID 和设置 kill 标志分两步，避免同时借用
            let children = if let Some(node) = self.orchestrate_nodes.get_mut(&current_id) {
                found = true;
                node.kill_requested = true;
                node.children_ids.clone()
            } else if let Some(node) = self.task_nodes.get_mut(&current_id) {
                found = true;
                node.kill_requested = true;
                node.children_ids.clone()
            } else {
                Vec::new()
            };
            queue.extend(children);
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_defaults() {
        let b = TaskBudget::default();
        assert_eq!((b.max_tokens, b.max_turns, b.max_tool_calls), (50_000, 20, 100));
        let u = TaskUsage::default();
        assert_eq!((u.total_tokens, u.tool_uses, u.duration_ms), (0, 0, 0));
    }

    #[test]
    fn test_task_node_serialization_roundtrip() {
        let node = TaskNode {
            task_id: "da_abc12345".to_string(),
            parent_id: None,
            session_id: "sess-1".to_string(),
            description: "test task".to_string(),
            status: TaskStatus::Running,
            mode: AgentMode::Preset,
            subagent_type: Some("code_review".to_string()),
            created_at: "2026-04-10T00:00:00Z".to_string(),
            completed_at: None,
            transcript_path: Some("subagents/da_abc12345.jsonl".to_string()),
            output_file: None,
            budget: TaskBudget::default(),
            usage: TaskUsage::default(),
            children_ids: Vec::new(),
            kill_requested: false,
            pause_requested: false,
        };
        let json = serde_json::to_string(&node).unwrap();
        assert!(json.contains("\"type\":\"task_node\""));
        assert!(json.contains("\"status\":\"running\""));
        let de: TaskNode = serde_json::from_str(&json).unwrap();
        assert_eq!(de.task_id, "da_abc12345");
        assert_eq!(de.status, TaskStatus::Running);
        assert_eq!(de.mode, AgentMode::Preset);
        assert_eq!(de.subagent_type.as_deref(), Some("code_review"));
    }

    #[test]
    fn test_orchestrate_node_serialization_roundtrip() {
        let node = OrchestrateNode {
            node_id: "or_xyz98765".to_string(),
            parent_id: Some("or_parent1".to_string()),
            session_id: "sess-1".to_string(),
            role: NodeRole::Orchestrator,
            depth: 1,
            description: "orchestrator node".to_string(),
            status: OrchestrateStatus::Idle,
            directive: "coordinate tasks".to_string(),
            agent_id: "agent-1".to_string(),
            conversation_path: PathBuf::from("orchestrate/or_xyz98765.jsonl"),
            output_file: None,
            budget: TaskBudget::default(),
            usage: TaskUsage::default(),
            children_ids: vec!["or_child1".to_string()],
            feedback_history: vec![FeedbackMessage {
                timestamp: "2026-04-10T00:00:00Z".to_string(),
                direction: FeedbackDirection::ChildToParent,
                message: "task done".to_string(),
                severity: FeedbackSeverity::Info,
            }],
            reuse_count: 2,
            last_active_at: "2026-04-10T01:00:00Z".to_string(),
            kill_requested: false,
            pause_requested: false,
        };
        let json = serde_json::to_string(&node).unwrap();
        assert!(json.contains("\"type\":\"orchestrate_node\""));
        assert!(json.contains("\"role\":\"orchestrator\""));
        let de: OrchestrateNode = serde_json::from_str(&json).unwrap();
        assert_eq!(de.node_id, "or_xyz98765");
        assert_eq!(de.feedback_history.len(), 1);
        assert_eq!(de.reuse_count, 2);
    }

    #[test]
    fn test_generate_task_id_prefix_and_uniqueness() {
        let da = generate_task_id("dispatch_agent");
        assert!(da.starts_with("da_") && da.len() == 11, "got: {}", da);
        let or = generate_task_id("orchestrate");
        assert!(or.starts_with("or_") && or.len() == 11, "got: {}", or);
        let tk = generate_task_id("unknown");
        assert!(tk.starts_with("tk_") && tk.len() == 11, "got: {}", tk);
        // uniqueness spot check
        assert_ne!(da, generate_task_id("dispatch_agent"));
    }

    #[test]
    fn test_task_tree_crud_and_lifecycle() {
        let mut tree = TaskTree::new();
        // create + get TaskNode
        tree.create_task_node(None, "s1", "do something", AgentMode::Preset, None, None);
        let id = tree.all_task_nodes()[0].task_id.clone();
        assert!(id.starts_with("da_"));
        assert_eq!(tree.get_task_node(&id).unwrap().status, TaskStatus::Pending);

        // status transition with auto completed_at
        tree.update_task_status(&id, TaskStatus::Running);
        assert!(tree.get_task_node(&id).unwrap().completed_at.is_none());
        tree.update_task_status(&id, TaskStatus::Completed);
        assert!(tree.get_task_node(&id).unwrap().completed_at.is_some());

        // create OrchestrateNode
        tree.create_orchestrate_node(
            None, "s1", NodeRole::Orchestrator, 0, "orch", "direct", "a1",
            PathBuf::from("o.jsonl"), None,
        );
        let oid = tree.all_orchestrate_nodes()[0].node_id.clone();
        assert!(oid.starts_with("or_"));
        assert_eq!(tree.get_orchestrate_node(&oid).unwrap().depth, 0);
    }

    #[test]
    fn test_kill_pause_resume() {
        let mut tree = TaskTree::new();
        tree.create_task_node(None, "s1", "t", AgentMode::Preset, None, None);
        let id = tree.all_task_nodes()[0].task_id.clone();

        assert!(!tree.should_kill(&id) && !tree.should_pause(&id));
        tree.request_kill(&id);
        tree.request_pause(&id);
        assert!(tree.should_kill(&id) && tree.should_pause(&id));
        tree.request_resume(&id);
        assert!(tree.should_kill(&id) && !tree.should_pause(&id));
    }

    #[test]
    fn test_request_kill_tree_cascades_to_children() {
        let mut tree = TaskTree::new();
        tree.create_orchestrate_node(
            None, "s1", NodeRole::Orchestrator, 0, "parent", "d", "a1",
            PathBuf::from("p.jsonl"), None,
        );
        let pid = tree.all_orchestrate_nodes()[0].node_id.clone();
        tree.create_orchestrate_node(
            Some(pid.clone()), "s1", NodeRole::Executor, 1, "child", "e", "a2",
            PathBuf::from("c.jsonl"), None,
        );
        let cid = tree.all_orchestrate_nodes()[1].node_id.clone();
        tree.get_orchestrate_node_mut(&pid).unwrap().children_ids.push(cid.clone());

        tree.request_kill_tree(&pid);
        assert!(tree.get_orchestrate_node(&pid).unwrap().kill_requested);
        assert!(tree.get_orchestrate_node(&cid).unwrap().kill_requested);

        // nonexistent returns false
        assert!(!tree.request_kill_tree("nope"));
    }
}
