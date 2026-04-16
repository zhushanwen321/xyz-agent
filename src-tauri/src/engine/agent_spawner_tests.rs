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
        disabled_tools: vec![],
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
    assert_eq!(content.len(), 1);
    assert!(content[0]["text"].as_str().unwrap().contains("task prompt"));
}

#[tokio::test]
async fn default_agent_spawner_runs_subagent() {
    let provider = Arc::new(MockLlmProvider::new(vec![
        MockLlmProvider::text_response("sub-agent response"),
    ]));
    let registry = crate::engine::llm::registry::ProviderRegistry::from_single(
        "test", provider.clone(), "test-model",
    );

    let spawner = DefaultAgentSpawner {
        provider_registry: Arc::new(std::sync::RwLock::new(registry)),
        default_model: "test/test-model".to_string(),
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
        prompt_key: None,
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
        parent_cancel_token: None,
        model_ref: None,
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
    let provider = Arc::new(MockLlmProvider::new(vec![
        MockLlmProvider::text_response("first"),
        MockLlmProvider::text_response("second"),
    ]));
    let registry = crate::engine::llm::registry::ProviderRegistry::from_single(
        "test", provider.clone(), "test-model",
    );

    let concurrency = Arc::new(ConcurrencyManager::new(2));

    let spawner = DefaultAgentSpawner {
        provider_registry: Arc::new(std::sync::RwLock::new(registry)),
        default_model: "test/test-model".to_string(),
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
        prompt_key: None,
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
        parent_cancel_token: None,
        model_ref: None,
    };

    let config2 = SpawnConfig {
        prompt: "second".to_string(),
        history: vec![],
        system_prompt_override: None,
        prompt_key: None,
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
        parent_cancel_token: None,
        model_ref: None,
    };

    let mut handle1 = spawner.spawn_agent(config1).await.unwrap();
    let join1 = handle1.join_handle.take().unwrap();

    let mut handle2 = spawner.spawn_agent(config2).await.unwrap();
    let join2 = handle2.join_handle.take().unwrap();

    let r1 = join1.await.unwrap().unwrap();
    let r2 = join2.await.unwrap().unwrap();
    assert_eq!(r1.status, "completed");
    assert_eq!(r2.status, "completed");
    assert_eq!(concurrency.active_count(), 0);
}
