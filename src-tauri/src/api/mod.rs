use crate::engine::agent_spawner::AgentSpawner;
use crate::engine::config::AgentConfig;
use crate::engine::context::prompt_registry::PromptRegistry;
use crate::engine::llm::registry::ProviderRegistry;
use crate::engine::tools::{PermissionContext, ToolRegistry};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::{RwLockReadGuard, RwLockWriteGuard};

pub mod commands;
pub mod event_bus;
pub mod prompt_commands;
pub mod tool_commands;

pub type SpawnerRef = Arc<std::sync::RwLock<Option<Arc<dyn AgentSpawner>>>>;

pub struct AppState {
    // 基础设施
    pub data_dir: PathBuf,
    pub provider_registry: Arc<std::sync::RwLock<ProviderRegistry>>,
    pub current_model: Arc<std::sync::RwLock<String>>,
    pub config: Arc<AgentConfig>,
    pub tool_registry: Arc<ToolRegistry>,
    pub global_perms: PermissionContext,

    // 运行时
    pub task_tree: Arc<tokio::sync::Mutex<crate::engine::task_tree::TaskTree>>,
    pub concurrency_manager: Arc<crate::engine::concurrency::ConcurrencyManager>,
    pub background_tasks: Arc<tokio::sync::Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>,
    pub cancel_tokens: Arc<std::sync::Mutex<HashMap<String, tokio_util::sync::CancellationToken>>>,

    // 模板与 Spawner
    pub agent_templates: Arc<std::sync::RwLock<crate::engine::agent_template::AgentTemplateRegistry>>,
    pub prompt_registry: Arc<std::sync::RwLock<PromptRegistry>>,
    pub agent_spawner: SpawnerRef,
}

impl AppState {
    pub fn read_registry(&self) -> Result<RwLockReadGuard<'_, ProviderRegistry>, String> {
        self.provider_registry.read().map_err(|e| format!("registry lock poisoned: {e}"))
    }

    pub fn write_registry(&self) -> Result<RwLockWriteGuard<'_, ProviderRegistry>, String> {
        self.provider_registry.write().map_err(|e| format!("registry lock poisoned: {e}"))
    }

    pub fn read_model(&self) -> Result<RwLockReadGuard<'_, String>, String> {
        self.current_model.read().map_err(|e| format!("model lock poisoned: {e}"))
    }

    pub fn write_model(&self) -> Result<RwLockWriteGuard<'_, String>, String> {
        self.current_model.write().map_err(|e| format!("model lock poisoned: {e}"))
    }
}
