use crate::engine::agent_spawner::AgentSpawner;
use crate::engine::config::AgentConfig;
use crate::engine::context::prompt_registry::PromptRegistry;
use crate::engine::llm::LlmProvider;
use crate::engine::tools::{PermissionContext, ToolRegistry};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

pub mod commands;
pub mod event_bus;
pub mod prompt_commands;

pub struct AppState {
    pub data_dir: PathBuf,
    pub provider: Arc<dyn LlmProvider>,
    pub model: String,
    pub config: Arc<AgentConfig>,
    pub tool_registry: Arc<ToolRegistry>,
    pub global_perms: PermissionContext,
    pub task_tree: Arc<tokio::sync::Mutex<crate::engine::task_tree::TaskTree>>,
    pub concurrency_manager: Arc<crate::engine::concurrency::ConcurrencyManager>,
    pub background_tasks: Arc<tokio::sync::Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>,
    pub agent_templates: Arc<std::sync::RwLock<crate::engine::agent_template::AgentTemplateRegistry>>,
    pub prompt_registry: Arc<std::sync::RwLock<PromptRegistry>>,
    pub agent_spawner: Arc<dyn AgentSpawner>,
    pub cancel_tokens: Arc<std::sync::Mutex<HashMap<String, tokio_util::sync::CancellationToken>>>,
}
