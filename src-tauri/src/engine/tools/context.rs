use std::sync::Arc;
use std::collections::HashMap;

use crate::types::AgentEvent;
use crate::types::transcript::AssistantContentBlock;
use crate::engine::task_tree::TaskTree;
use crate::engine::concurrency::ConcurrencyManager;
use crate::engine::agent_template::AgentTemplateRegistry;
use crate::engine::agent_spawner::AgentSpawner;

use super::ToolRegistry;

/// P2 tools (dispatch_agent, feedback, orchestrate) 所需的运行时上下文。
/// P1 tools 通过 `Option<&ToolExecutionContext>` 忽略此参数。
#[derive(Clone)]
pub struct ToolExecutionContext {
    pub task_tree: Arc<tokio::sync::Mutex<TaskTree>>,
    pub concurrency_manager: Arc<ConcurrencyManager>,
    pub agent_templates: Arc<std::sync::RwLock<AgentTemplateRegistry>>,
    pub data_dir: std::path::PathBuf,
    pub session_id: String,
    pub event_tx: tokio::sync::mpsc::UnboundedSender<AgentEvent>,
    pub api_messages: Vec<serde_json::Value>,
    pub current_assistant_content: Vec<AssistantContentBlock>,
    pub tool_registry: Arc<ToolRegistry>,
    pub background_tasks: Arc<tokio::sync::Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>,
    pub agent_spawner: Arc<dyn AgentSpawner>,
    pub orchestrate_depth: u32,
    /// 当前 Agent 的 node_id（递归 orchestrate 时用于设置 parent_id）
    pub node_id: Option<String>,
    /// 父级 CancellationToken，用于派生子 Agent 的 child token（级联取消）
    pub parent_cancel_token: Option<tokio_util::sync::CancellationToken>,
}
