use crate::engine::config::AgentConfig;
use crate::engine::llm::LlmProvider;
use crate::engine::tools::{PermissionContext, ToolRegistry};
use std::path::PathBuf;
use std::sync::Arc;

pub mod commands;
pub mod event_bus;

pub struct AppState {
    pub data_dir: PathBuf,
    pub provider: Arc<dyn LlmProvider>,
    pub model: String,
    pub config: Arc<AgentConfig>,
    pub tool_registry: Arc<ToolRegistry>,
    pub global_perms: PermissionContext,
}
