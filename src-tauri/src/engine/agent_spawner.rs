use async_trait::async_trait;

use crate::engine::context::prompt::DynamicContext;
use crate::engine::task_tree::{TaskBudget, TaskUsage};
use crate::engine::tools::PermissionContext;
use crate::types::transcript::{AssistantContentBlock, TranscriptEntry};
use crate::types::AppError;
use crate::types::AgentEvent;

/// 子 Agent 启动配置，包含所有运行时依赖
pub struct SpawnConfig {
    pub prompt: String,
    pub history: Vec<TranscriptEntry>,
    pub system_prompt_override: Option<String>,
    pub tool_filter: Option<Vec<String>>,
    pub budget: Option<TaskBudget>,
    pub event_tx: tokio::sync::mpsc::UnboundedSender<AgentEvent>,
    pub sync: bool,
    // Fork 专用：复制父 Agent 的 API messages 以最大化 Prompt Cache 命中
    pub fork_api_messages: Option<Vec<serde_json::Value>>,
    pub fork_assistant_content: Option<Vec<AssistantContentBlock>>,
    // 运行时依赖
    pub dynamic_context: DynamicContext,
    pub permission_context: PermissionContext,
}

/// 子 Agent 启动句柄，持有 tokio JoinHandle 用于结果收集
pub struct SpawnHandle {
    pub task_id: String,
    pub join_handle:
        Option<tokio::task::JoinHandle<Result<AgentSpawnResult, AppError>>>,
}

/// 子 Agent 执行结果
pub struct AgentSpawnResult {
    pub entries: Vec<TranscriptEntry>,
    pub usage: TaskUsage,
    pub status: String,
    pub output_file: Option<std::path::PathBuf>,
}

/// Agent 启动器 trait：解耦工具层（dispatch_agent）和 AgentLoop
#[async_trait]
pub trait AgentSpawner: Send + Sync {
    fn spawn_agent(&self, config: SpawnConfig) -> Result<SpawnHandle, AppError>;
}
