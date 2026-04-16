use crate::engine::agent_spawner::AgentSpawner;
use crate::engine::config::AgentConfig;
use crate::engine::llm::LlmProvider;
use crate::engine::tools::{PermissionContext, ToolRegistry};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

pub mod commands;
pub mod event_bus;

pub struct AppState {
    pub data_dir: PathBuf,
    pub provider: Arc<std::sync::RwLock<Option<Arc<dyn LlmProvider>>>>,
    pub model: Arc<std::sync::RwLock<String>>,
    pub config: Arc<AgentConfig>,
    pub tool_registry: Arc<ToolRegistry>,
    pub global_perms: PermissionContext,
    pub task_tree: Arc<tokio::sync::Mutex<crate::engine::task_tree::TaskTree>>,
    pub concurrency_manager: Arc<crate::engine::concurrency::ConcurrencyManager>,
    pub background_tasks: Arc<tokio::sync::Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>,
    pub agent_templates: Arc<crate::engine::agent_template::AgentTemplateRegistry>,
    pub agent_spawner: Arc<std::sync::RwLock<Option<Arc<dyn AgentSpawner>>>>,
    pub cancel_tokens: Arc<std::sync::Mutex<HashMap<String, tokio_util::sync::CancellationToken>>>,
}
