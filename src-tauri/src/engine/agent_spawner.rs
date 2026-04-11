use async_trait::async_trait;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::engine::budget_guard::BudgetGuard;
use crate::engine::concurrency::ConcurrencyManager;
use crate::engine::config::AgentConfig;
use crate::engine::context::prompt::{DynamicContext, PromptManager};
use crate::engine::llm::LlmProvider;
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
    pub provider: Arc<dyn LlmProvider>,
    pub model: String,
    pub config: Arc<AgentConfig>,
    pub tool_registry: Arc<ToolRegistry>,
    pub task_tree: Arc<tokio::sync::Mutex<TaskTree>>,
    pub concurrency_manager: Arc<ConcurrencyManager>,
    pub data_dir: std::path::PathBuf,
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

        let agent_loop = AgentLoop::new(
            self.provider.clone(),
            config.session_id.clone(),
            self.model.clone(),
        );

        let tool_registry = filter_tools(&self.tool_registry, config.tool_filter.as_deref());
        let prompt_manager = match &config.system_prompt_override {
            Some(p) => PromptManager::new_with_prompt(p),
            None => PromptManager::new(),
        };
        let agent_config = self.config.clone();
        let task_tree = self.task_tree.clone();
        let node_id = config.node_id.clone();
        let data_dir = self.data_dir.clone();

        // 构建 spawner 引用，供子 Agent 的 ToolExecutionContext 使用
        let spawner: Arc<dyn AgentSpawner> = Arc::new(DefaultAgentSpawner {
            provider: self.provider.clone(),
            model: self.model.clone(),
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

    // 构建 ToolExecutionContext，使子 Agent 的 P2 工具（dispatch_agent/orchestrate/feedback）可用
    let tool_ctx = ToolExecutionContext {
        task_tree: task_tree.clone(),
        concurrency_manager: concurrency_manager.clone(),
        agent_templates: Arc::new(crate::engine::agent_template::AgentTemplateRegistry::new()),
        data_dir: data_dir.clone(),
        session_id: config.session_id.clone(),
        event_tx: config.event_tx.clone(),
        api_messages: vec![],
        current_assistant_content: vec![],
        tool_registry: tool_registry.clone(),
        background_tasks: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
        agent_spawner: spawner,
        orchestrate_depth: config.orchestrate_depth,
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
mod tests {
    use super::*;
    use crate::engine::llm::test_utils::MockLlmProvider;
    use crate::types::AssistantContentBlock;

    fn test_dynamic_context() -> DynamicContext {
        DynamicContext {
            cwd: "/test".to_string(),
            os: "test".to_string(),
            model: "test-model".to_string(),
            git_branch: None,
            tool_names: vec![],
            data_context_summary: None,
            conversation_summary: None,
        }
    }

    #[test]
    fn filter_tools_returns_registry_clone_when_no_filter() {
        let registry = ToolRegistry::new();
        let filtered = filter_tools(&registry, None);
        assert_eq!(filtered.tool_names().len(), 0);
    }

    #[test]
    fn filter_tools_respects_whitelist() {
        use crate::engine::tools::ToolRegistry;
        let mut registry = ToolRegistry::new();
        registry.register(Arc::new(crate::engine::tools::bash::BashTool::new(
            std::path::PathBuf::from("/tmp"), 30, 10000,
        )));
        registry.register(Arc::new(crate::engine::tools::read::ReadTool::new(
            std::path::PathBuf::from("/tmp"), 10000,
        )));
        registry.register(Arc::new(crate::engine::tools::write::WriteTool::new(
            std::path::PathBuf::from("/tmp"),
        )));

        let filtered = filter_tools(
            &registry,
            Some(&["Read".to_string(), "Bash".to_string()]),
        );
        assert_eq!(filtered.tool_names(), vec!["Bash", "Read"]);
    }

    #[test]
    fn build_subagent_history_appends_fork_context() {
        let fork_messages = vec![serde_json::json!({
            "role": "user",
            "content": "hello"
        })];
        let assistant_content = vec![AssistantContentBlock::ToolUse {
            id: "toolu_1".to_string(),
            name: "Read".to_string(),
            input: serde_json::json!({"file_path": "/tmp/test"}),
        }];

        let result = build_subagent_history(&fork_messages, &assistant_content, "do something");

        assert_eq!(result.len(), 2);
        let last = &result[1];
        assert_eq!(last["role"], "user");
        let content = last["content"].as_array().unwrap();
        // 应有 tool_result + fork-context text
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["type"], "tool_result");
        assert_eq!(content[0]["tool_use_id"], "toolu_1");
        assert!(content[1]["text"].as_str().unwrap().contains("<fork-context>"));
    }

    #[test]
    fn build_subagent_history_without_tool_uses() {
        let fork_messages = vec![serde_json::json!({
            "role": "assistant",
            "content": "thinking..."
        })];
        let assistant_content: Vec<AssistantContentBlock> = vec![];

        let result = build_subagent_history(&fork_messages, &assistant_content, "task prompt");

        assert_eq!(result.len(), 2);
        let content = result[1]["content"].as_array().unwrap();
        // 没有 tool_result，只有 fork-context text
        assert_eq!(content.len(), 1);
        assert!(content[0]["text"].as_str().unwrap().contains("task prompt"));
    }

    #[tokio::test]
    async fn default_agent_spawner_runs_subagent() {
        let provider = Arc::new(MockLlmProvider::new(vec![
            MockLlmProvider::text_response("sub-agent response"),
        ]));

        let spawner = DefaultAgentSpawner {
            provider: provider.clone(),
            model: "test-model".to_string(),
            config: Arc::new(AgentConfig::default()),
            tool_registry: Arc::new(ToolRegistry::new()),
            task_tree: Arc::new(tokio::sync::Mutex::new(TaskTree::new())),
            concurrency_manager: Arc::new(ConcurrencyManager::new(2)),
            data_dir: std::path::PathBuf::from("/tmp"),
        };

        let (event_tx, _event_rx) = tokio::sync::mpsc::unbounded_channel();

        let config = SpawnConfig {
            prompt: "test prompt".to_string(),
            history: vec![],
            system_prompt_override: None,
            tool_filter: None,
            budget: None,
            event_tx,
            sync: true,
            fork_api_messages: None,
            fork_assistant_content: None,
            dynamic_context: test_dynamic_context(),
            permission_context: PermissionContext::default(),
            session_id: "test-session".to_string(),
            task_id: "da_test1234".to_string(),
            node_id: None,
            orchestrate_depth: 0,
        };

        let mut handle = spawner.spawn_agent(config).await.unwrap();
        let join = handle.join_handle.take().unwrap();
        let result = join.await.unwrap().unwrap();

        assert_eq!(result.status, "completed");
        assert_eq!(result.entries.len(), 1);
        assert!(result.usage.total_tokens > 0);
    }

    #[tokio::test]
    async fn spawner_respects_concurrency_limit() {
        // 验证并发槽位被正确获取和释放
        let provider = Arc::new(MockLlmProvider::new(vec![
            MockLlmProvider::text_response("first"),
            MockLlmProvider::text_response("second"),
        ]));

        let concurrency = Arc::new(ConcurrencyManager::new(2));

        let spawner = DefaultAgentSpawner {
            provider,
            model: "test-model".to_string(),
            config: Arc::new(AgentConfig::default()),
            tool_registry: Arc::new(ToolRegistry::new()),
            task_tree: Arc::new(tokio::sync::Mutex::new(TaskTree::new())),
            concurrency_manager: concurrency.clone(),
            data_dir: std::path::PathBuf::from("/tmp"),
        };

        let (event_tx1, _rx1) = tokio::sync::mpsc::unbounded_channel();
        let (event_tx2, _rx2) = tokio::sync::mpsc::unbounded_channel();

        let config1 = SpawnConfig {
            prompt: "first".to_string(),
            history: vec![],
            system_prompt_override: None,
            tool_filter: None,
            budget: None,
            event_tx: event_tx1,
            sync: true,
            fork_api_messages: None,
            fork_assistant_content: None,
            dynamic_context: test_dynamic_context(),
            permission_context: PermissionContext::default(),
            session_id: "s1".to_string(),
            task_id: "da_first123".to_string(),
            node_id: None,
            orchestrate_depth: 0,
        };

        let config2 = SpawnConfig {
            prompt: "second".to_string(),
            history: vec![],
            system_prompt_override: None,
            tool_filter: None,
            budget: None,
            event_tx: event_tx2,
            sync: true,
            fork_api_messages: None,
            fork_assistant_content: None,
            dynamic_context: test_dynamic_context(),
            permission_context: PermissionContext::default(),
            session_id: "s2".to_string(),
            task_id: "da_second456".to_string(),
            node_id: None,
            orchestrate_depth: 0,
        };

        let mut handle1 = spawner.spawn_agent(config1).await.unwrap();
        let join1 = handle1.join_handle.take().unwrap();

        let mut handle2 = spawner.spawn_agent(config2).await.unwrap();
        let join2 = handle2.join_handle.take().unwrap();

        let r1 = join1.await.unwrap().unwrap();
        let r2 = join2.await.unwrap().unwrap();
        assert_eq!(r1.status, "completed");
        assert_eq!(r2.status, "completed");
        // permit 在 drop 后释放
        assert_eq!(concurrency.active_count(), 0);
    }
}
