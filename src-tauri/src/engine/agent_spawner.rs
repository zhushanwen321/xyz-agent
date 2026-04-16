use async_trait::async_trait;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::engine::budget_guard::BudgetGuard;
use crate::engine::concurrency::ConcurrencyManager;
use crate::engine::config::AgentConfig;
use crate::engine::context::prompt::{DynamicContext, PromptManager};
use crate::engine::llm::registry::ProviderRegistry;
use crate::engine::llm::types::parse_model_ref;
use crate::engine::loop_::AgentLoop;
use crate::engine::task_tree::{TaskBudget, TaskTree, TaskUsage};
use crate::engine::tools::{PermissionContext, ToolExecutionContext, ToolRegistry};
use crate::types::transcript::{AssistantContentBlock, TranscriptEntry};
use crate::types::{AgentEvent, AppError};

// ── Spawn 配置 ──────────────────────────────────────────────

/// 子 Agent 启动配置
pub struct SpawnConfig {
    pub prompt: String,
    pub history: Vec<TranscriptEntry>,
    pub system_prompt_override: Option<String>,
    /// PromptRegistry 中的 key，如 "explore", "plan", "general_purpose"
    pub prompt_key: Option<String>,
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
    // P3: 标识字段
    pub session_id: String,
    pub task_id: String,
    pub node_id: Option<String>,
    /// 子 Agent 的 orchestrate 嵌套深度，用于递归限制
    pub orchestrate_depth: u32,
    /// 父级 CancellationToken，用于派生 child token
    pub parent_cancel_token: Option<tokio_util::sync::CancellationToken>,
    /// 子 Agent 使用的模型（如 "provider/model_id"），为 None 时使用 default_model
    pub model_ref: Option<String>,
}

// ── Spawn 句柄 ──────────────────────────────────────────────

/// 子 Agent 启动句柄，持有 JoinHandle + 结果缓存
pub struct SpawnHandle {
    pub task_id: String,
    pub join_handle: Option<tokio::task::JoinHandle<Result<AgentSpawnResult, AppError>>>,
    /// 异步模式下缓存结果，供后续轮询
    pub result: Option<AgentSpawnResult>,
}

// ── Spawn 结果 ──────────────────────────────────────────────

/// 子 Agent 执行结果
pub struct AgentSpawnResult {
    pub entries: Vec<TranscriptEntry>,
    pub usage: TaskUsage,
    pub status: String,
    pub output_file: Option<std::path::PathBuf>,
}

// ── AgentSpawner trait ───────────────────────────────────────

/// Agent 启动器 trait：解耦工具层（dispatch_agent）和 AgentLoop
#[async_trait]
pub trait AgentSpawner: Send + Sync {
    async fn spawn_agent(&self, config: SpawnConfig) -> Result<SpawnHandle, AppError>;
}

// ── DefaultAgentSpawner 实现 ────────────────────────────────

/// 默认 AgentSpawner，使用 AgentLoop 执行子 Agent
pub struct DefaultAgentSpawner {
    pub provider_registry: Arc<std::sync::RwLock<ProviderRegistry>>,
    pub default_model: String,
    pub config: Arc<AgentConfig>,
    pub tool_registry: Arc<ToolRegistry>,
    pub task_tree: Arc<tokio::sync::Mutex<TaskTree>>,
    pub concurrency_manager: Arc<ConcurrencyManager>,
    pub data_dir: std::path::PathBuf,
}

impl DefaultAgentSpawner {
    pub fn new(
        provider_registry: Arc<std::sync::RwLock<ProviderRegistry>>,
        default_model: String,
        config: Arc<AgentConfig>,
        tool_registry: Arc<ToolRegistry>,
        task_tree: Arc<tokio::sync::Mutex<TaskTree>>,
        concurrency_manager: Arc<ConcurrencyManager>,
        data_dir: std::path::PathBuf,
    ) -> Self {
        Self { provider_registry, default_model, config, tool_registry, task_tree, concurrency_manager, data_dir }
    }
}

#[async_trait]
impl AgentSpawner for DefaultAgentSpawner {
    async fn spawn_agent(&self, config: SpawnConfig) -> Result<SpawnHandle, AppError> {
        let task_id = config.task_id.clone();

        // 并发控制
        let concurrency = self.concurrency_manager.clone();
        let permit = concurrency
            .acquire()
            .await
            .map_err(|e| AppError::Llm(e))?;

        // 从 registry 动态获取 provider
        let model_ref = config.model_ref.as_deref().unwrap_or(&self.default_model);
        let (provider_name, model_id) = parse_model_ref(model_ref)?;
        let provider = self.provider_registry.read().unwrap()
            .get_provider(provider_name)
            .ok_or_else(|| AppError::Config(format!("provider '{}' not found", provider_name)))?;

        let agent_loop = AgentLoop::new(
            provider,
            config.session_id.clone(),
            model_id.to_string(),
        );

        let tool_registry = filter_tools(&self.tool_registry, config.tool_filter.as_deref());
        let prompt_manager = match &config.system_prompt_override {
            Some(p) => PromptManager::new_with_prompt(p),
            None => {
                let key = config.prompt_key.as_deref().unwrap_or("general_purpose");
                PromptManager::new()
                    .with_user_prompts(&self.data_dir)
                    .with_key(key)
            }
        };
        let agent_config = self.config.clone();
        let task_tree = self.task_tree.clone();
        let node_id = config.node_id.clone();
        let data_dir = self.data_dir.clone();

        // 构建 spawner 引用，供子 Agent 的 ToolExecutionContext 使用
        let spawner: Arc<dyn AgentSpawner> = Arc::new(DefaultAgentSpawner {
            provider_registry: self.provider_registry.clone(),
            default_model: self.default_model.clone(),
            config: self.config.clone(),
            tool_registry: self.tool_registry.clone(),
            task_tree: self.task_tree.clone(),
            concurrency_manager: self.concurrency_manager.clone(),
            data_dir: self.data_dir.clone(),
        });

        let handle = tokio::spawn(async move {
            // 并发 permit 在整个子 Agent 执行期间持有
            let _permit = permit;

            let result = run_subagent(
                &agent_loop,
                config,
                Arc::new(tool_registry),
                &prompt_manager,
                &agent_config,
                task_tree,
                node_id,
                &data_dir,
                concurrency,
                spawner,
            )
            .await;

            result
        });

        Ok(SpawnHandle {
            task_id,
            join_handle: Some(handle),
            result: None,
        })
    }
}

// ── 辅助函数 ────────────────────────────────────────────────

/// 执行子 Agent 单次 run_turn，组装 budget / api_messages_override
async fn run_subagent(
    agent_loop: &AgentLoop,
    config: SpawnConfig,
    tool_registry: Arc<ToolRegistry>,
    prompt_manager: &PromptManager,
    agent_config: &AgentConfig,
    task_tree: Arc<tokio::sync::Mutex<TaskTree>>,
    node_id: Option<String>,
    data_dir: &std::path::PathBuf,
    concurrency_manager: Arc<ConcurrencyManager>,
    spawner: Arc<dyn AgentSpawner>,
) -> Result<AgentSpawnResult, AppError> {
    let start = Instant::now();
    let mut budget_guard = config.budget.map(BudgetGuard::new);

    // 构建 api_messages_override：Fork 模式使用父 Agent 快照，否则从 history 生成
    let api_messages_override = if let Some(fork_msgs) = config.fork_api_messages {
        Some(fork_msgs)
    } else {
        None
    };

    // 构建 ToolExecutionContext，使子 Agent 的 P2 工具（Subagent/Orchestrate/Communication）可用
    let tool_ctx = ToolExecutionContext {
        task_tree: task_tree.clone(),
        concurrency_manager: concurrency_manager.clone(),
        agent_templates: Arc::new(std::sync::RwLock::new(crate::engine::agent_template::AgentTemplateRegistry::new())),
        data_dir: data_dir.clone(),
        session_id: config.session_id.clone(),
        event_tx: config.event_tx.clone(),
        api_messages: vec![],
        current_assistant_content: vec![],
        tool_registry: tool_registry.clone(),
        background_tasks: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
        agent_spawner: spawner,
        orchestrate_depth: config.orchestrate_depth,
        node_id: config.node_id.clone(),
        parent_cancel_token: config.parent_cancel_token.clone(),
    };

    // 从 TaskTree 获取子 Agent 的 CancellationToken
    // 调用方（dispatch_agent/orchestrate）在 spawn_agent 之前已通过 set_cancel_token 写入，
    // tokio::spawn 保证此处在 set 之后执行
    let cancel_token = {
        let tree = task_tree.lock().await;
        tree.get_cancel_token(&config.task_id)
            .cloned()
            .unwrap_or_else(tokio_util::sync::CancellationToken::new)
    };

    let entries = agent_loop
        .run_turn(
            config.prompt.clone(),
            config.history.clone(),
            None,
            config.event_tx.clone(),
            &tool_registry,
            &config.permission_context,
            prompt_manager,
            &config.dynamic_context,
            agent_config,
            budget_guard.as_mut(),
            Some(task_tree),
            node_id,
            Some(tool_ctx),
            api_messages_override,
            cancel_token,
        )
        .await?;

    let elapsed = start.elapsed().as_millis() as u64;

    // 汇总 token usage
    let total_tokens: u32 = entries
        .iter()
        .filter_map(|e| match e {
            TranscriptEntry::Assistant { usage, .. } => usage.as_ref().map(|u| u.output_tokens),
            _ => None,
        })
        .sum();

    let tool_uses: u32 = entries
        .iter()
        .filter(|e| {
            matches!(
                e,
                TranscriptEntry::User { content, .. }
                if content.iter().any(|b| matches!(b, crate::types::UserContentBlock::ToolResult { .. }))
            )
        })
        .count() as u32;

    // result_summary 由调用方（dispatch_agent/orchestrate）通过 set_task_result 写入

    let status = "completed".to_string();

    Ok(AgentSpawnResult {
        entries,
        usage: TaskUsage {
            total_tokens,
            tool_uses,
            duration_ms: elapsed,
        },
        status,
        output_file: None,
    })
}

/// 按名称白名单过滤工具注册表，返回新的 ToolRegistry
fn filter_tools(
    registry: &ToolRegistry,
    filter: Option<&[String]>,
) -> ToolRegistry {
    match filter {
        Some(names) if !names.is_empty() => registry.filtered(names),
        _ => registry.clone(),
    }
}

// Fork 模式尚未启用，以下函数待 mode=fork 路径激活后使用
#[allow(dead_code)]
/// 构建 Fork 模式的历史消息：将 prompt 作为 user message 追加到 fork messages 后
fn build_subagent_history(
    fork_messages: &[serde_json::Value],
    fork_assistant_content: &[AssistantContentBlock],
    prompt: &str,
) -> Vec<serde_json::Value> {
    let mut messages = fork_messages.to_vec();

    let mut result_blocks: Vec<serde_json::Value> = fork_assistant_content
        .iter()
        .filter_map(|block| {
            if let AssistantContentBlock::ToolUse { id, .. } = block {
                Some(serde_json::json!({
                    "type": "tool_result",
                    "tool_use_id": id,
                    "content": "Fork started — processing in background"
                }))
            } else {
                None
            }
        })
        .collect();

    result_blocks.push(serde_json::json!({
        "type": "text",
        "text": format!("<fork-context>\n{}\n</fork-context>", prompt)
    }));

    messages.push(serde_json::json!({
        "role": "user",
        "content": result_blocks
    }));

    messages
}

#[allow(dead_code)]
/// 事件通道桥接：将子 Agent 的事件转发到主 Agent，带节流
pub fn bridge_events(
    sub_rx: tokio::sync::mpsc::UnboundedReceiver<AgentEvent>,
    main_tx: tokio::sync::mpsc::UnboundedSender<AgentEvent>,
    _task_id: String,
    _session_id: String,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut rx = sub_rx;
        let mut last_progress = Instant::now();
        let throttle = Duration::from_secs(2);

        while let Some(event) = rx.recv().await {
            match &event {
                AgentEvent::TaskProgress { .. } => {
                    if last_progress.elapsed() >= throttle {
                        last_progress = Instant::now();
                        let _ = main_tx.send(event);
                    }
                }
                AgentEvent::TaskCompleted { .. }
                | AgentEvent::BudgetWarning { .. }
                | AgentEvent::TaskFeedback { .. } => {
                    let _ = main_tx.send(event);
                }
                _ => {}
            }
        }
    })
}

// ── 测试 ────────────────────────────────────────────────────

#[cfg(test)]
#[path = "agent_spawner_tests.rs"]
mod tests;
