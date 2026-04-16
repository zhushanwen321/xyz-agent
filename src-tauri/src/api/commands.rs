use std::path::Path;
use std::sync::Arc;
use crate::api::AppState;
use crate::engine::llm::types::{ProviderConfig, ModelInfo, parse_model_ref};
use crate::engine::llm::LlmProvider;
use crate::engine::context::prompt::{DynamicContext, PromptManager};
use crate::engine::loop_::AgentLoop;
use crate::engine::tools::ToolExecutionContext;
use crate::store::jsonl::LoadHistoryResult;
use crate::store::session;
use crate::types::{AgentEvent, AssistantContentBlock, TranscriptEntry, UserContentBlock};
use serde::Deserialize;
use tauri::{AppHandle, State};

#[derive(serde::Serialize)]
pub struct ConfigResponse {
    pub providers: Vec<ProviderConfig>,
    pub default_model: String,
    pub current_model: String,
    pub max_turns: u32,
    pub context_window: u32,
    pub max_output_tokens: u32,
    pub tool_output_max_bytes: usize,
    pub bash_default_timeout_secs: u64,
    pub thinking_enabled: bool,
    pub thinking_budget_tokens: u32,
}

#[derive(Deserialize)]
pub struct UpdateConfigRequest {
    pub max_turns: u32,
    pub context_window: u32,
    pub max_output_tokens: u32,
    pub tool_output_max_bytes: usize,
    pub bash_default_timeout_secs: u64,
    pub thinking_enabled: bool,
    pub thinking_budget_tokens: u32,
}

#[tauri::command]
pub async fn new_session(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let meta = session::new_session(&state.data_dir).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "session_id": meta.id,
        "title": meta.title,
    }))
}

#[tauri::command]
pub async fn list_sessions(state: State<'_, AppState>) -> Result<Vec<session::SessionMeta>, String> {
    session::list_sessions(&state.data_dir).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_history(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<LoadHistoryResult, String> {
    let path = session::session_file_path(&state.data_dir, &session_id)
        .ok_or_else(|| format!("session {session_id} not found"))?;
    crate::store::jsonl::load_history(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_session(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    session::delete_session(&state.data_dir, &session_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rename_session(
    session_id: String,
    new_title: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    session::rename_session(&state.data_dir, &session_id, &new_title).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_current_model(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state.current_model.read().unwrap().clone())
}

#[tauri::command]
pub async fn list_tools(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(state.tool_registry.tool_names())
}

#[tauri::command]
pub async fn send_message(
    session_id: String,
    content: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let preview: String = content.chars().take(50).collect();
    log::info!("[chat] send_message: session={session_id}, content={preview}");

    // 1. 获取 provider 和 model
    let provider = acquire_provider_for_model(&state)?;
    let model = state.current_model.read().unwrap().clone();
    let (_, model_id) = parse_model_ref(&model).unwrap_or(("unknown", &model));
    log::info!("[chat] starting agent_loop, model={model}");
    log::info!("[chat] starting agent_loop, model={model}");

    // 2. 加载历史 + 创建 user entry
    let session_path = session::session_file_path(&state.data_dir, &session_id)
        .ok_or_else(|| format!("session {session_id} not found"))?;
    let LoadHistoryResult { entries: mut history, conversation_summary, .. } =
        crate::store::jsonl::load_history(&session_path).map_err(|e| e.to_string())?;
    log::debug!("[chat] history entries={}", history.len());

    let user_entry = create_user_entry(&session_id, &content, history.last());
    crate::store::jsonl::append_entry(&session_path, &user_entry).map_err(|e| e.to_string())?;
    history.push(user_entry.clone());

    // 3. Event channel + EventBus bridge
    let (event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel();
    crate::api::event_bus::spawn_bridge(app, event_rx);

    // 4. CancellationToken with RAII guard
    let cancel_token = {
        let mut tokens = state.cancel_tokens.lock().unwrap();
        tokens.entry(session_id.clone())
            .or_insert_with(tokio_util::sync::CancellationToken::new)
            .clone()
    };
    struct TokenGuard {
        tokens: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, tokio_util::sync::CancellationToken>>>,
        session_id: String,
    }
    impl Drop for TokenGuard {
        fn drop(&mut self) {
            self.tokens.lock().unwrap().remove(&self.session_id);
        }
    }
    let _token_guard = TokenGuard { tokens: state.cancel_tokens.clone(), session_id: session_id.clone() };

    // 5. 构建 prompt 和 context
    let agent_loop = AgentLoop::new(provider, session_id.clone(), model_id.to_string());
    let prompt_manager = PromptManager::new().with_user_prompts(&state.data_dir);
    let dynamic_context = DynamicContext {
        cwd: std::env::current_dir().unwrap_or_default().to_string_lossy().to_string(),
        os: std::env::consts::OS.to_string(),
        model: state.current_model.read().unwrap().clone(),
        git_branch: None,
        tool_names: state.tool_registry.tool_names(),
        data_context_summary: None,
        conversation_summary,
        disabled_tools: crate::api::tool_commands::load_disabled_tools(&state.data_dir),
    };

    // 6. 注入后台任务结果
    inject_pending_results(
        &state.task_tree, &session_id, &session_path, &mut history,
    ).await?;

    // 7. 构建工具上下文并运行
    let event_tx_for_turn = event_tx.clone();
    let tool_ctx = build_tool_context(&state, &session_id, &event_tx_for_turn, &cancel_token)?;
    let result = agent_loop
        .run_turn(
            content, history, Some(user_entry.uuid().to_string()), event_tx_for_turn,
            &state.tool_registry, &state.global_perms, &prompt_manager, &dynamic_context,
            &state.config, None, None, None, Some(tool_ctx), None, cancel_token,
        )
        .await;

    // 8. 发送 TurnComplete 并持久化
    let _ = event_tx.send(AgentEvent::TurnComplete { session_id: session_id.clone(), source_task_id: None });
    drop(event_tx);

    let new_entries = result.map_err(|e| {
        log::error!("[chat] agent_loop error: {e}");
        e.to_string()
    })?;
    let text_len = persist_entries(&session_path, &new_entries)?;
    log::info!("[chat] response received, entries={}, total_text_len={}", new_entries.len(), text_len);

    Ok(())
}

// --- send_message helpers ---

/// 从 current_model ref 解析 provider_name，获取对应的 LlmProvider
fn acquire_provider_for_model(state: &AppState) -> Result<Arc<dyn LlmProvider>, String> {
    let model_ref = state.current_model.read().map_err(|e| format!("model lock: {e}"))?.clone();
    let (provider_name, _) = parse_model_ref(&model_ref)
        .map_err(|e| e.to_string())?;
    let registry = state.provider_registry.read().map_err(|e| format!("registry lock: {e}"))?;
    registry.get_provider(provider_name)
        .ok_or("API Key not configured. Please configure in Settings.".to_string())
}

/// 构建 user TranscriptEntry
fn create_user_entry(
    session_id: &str,
    content: &str,
    last_entry: Option<&TranscriptEntry>,
) -> TranscriptEntry {
    let parent_uuid = last_entry.map(|e| e.uuid().to_string());
    TranscriptEntry::User {
        uuid: uuid::Uuid::new_v4().to_string(),
        parent_uuid,
        timestamp: chrono::Utc::now().to_rfc3339(),
        session_id: session_id.to_string(),
        content: vec![UserContentBlock::Text { text: content.to_string() }],
    }
}

/// 将已完成的后台任务结果注入 history，保持 user/assistant 交替性
async fn inject_pending_results(
    task_tree: &Arc<tokio::sync::Mutex<crate::engine::task_tree::TaskTree>>,
    session_id: &str,
    session_path: &Path,
    history: &mut Vec<TranscriptEntry>,
) -> Result<(), String> {
    let pending_results = {
        let tree = task_tree.lock().await;
        tree.completed_not_injected(session_id)
    };

    if pending_results.is_empty() {
        return Ok(());
    }

    let mut injected_ids = Vec::new();
    for result in &pending_results {
        let text = format!(
            "[Background] task completed: {}\n{}",
            result.description,
            result.result_summary.chars().take(2000).collect::<String>()
        );
        let inject_entry = TranscriptEntry::Assistant {
            uuid: uuid::Uuid::new_v4().to_string(),
            parent_uuid: None,
            timestamp: chrono::Utc::now().to_rfc3339(),
            session_id: session_id.to_string(),
            content: vec![AssistantContentBlock::Text { text }],
            usage: None,
        };
        crate::store::jsonl::append_entry(session_path, &inject_entry).map_err(|e| e.to_string())?;
        history.push(inject_entry);

        // 保持 user/assistant 交替性
        let sys_entry = TranscriptEntry::User {
            uuid: uuid::Uuid::new_v4().to_string(),
            parent_uuid: None,
            timestamp: chrono::Utc::now().to_rfc3339(),
            session_id: session_id.to_string(),
            content: vec![UserContentBlock::Text {
                text: "[System: 以上是异步任务结果，请结合用户消息处理]".into(),
            }],
        };
        crate::store::jsonl::append_entry(session_path, &sys_entry).map_err(|e| e.to_string())?;
        history.push(sys_entry);

        injected_ids.push(result.task_id.clone());
    }

    let mut tree = task_tree.lock().await;
    for id in &injected_ids {
        tree.mark_result_injected(id);
    }
    Ok(())
}

/// 构建 ToolExecutionContext
fn build_tool_context(
    state: &AppState,
    session_id: &str,
    event_tx: &tokio::sync::mpsc::UnboundedSender<AgentEvent>,
    cancel_token: &tokio_util::sync::CancellationToken,
) -> Result<ToolExecutionContext, String> {
    let agent_spawner = state.agent_spawner.read().unwrap().clone()
        .ok_or("API Key not configured. Please configure in Settings.".to_string())?;
    Ok(ToolExecutionContext {
        task_tree: state.task_tree.clone(),
        concurrency_manager: state.concurrency_manager.clone(),
        agent_templates: state.agent_templates.clone(),
        data_dir: state.data_dir.clone(),
        session_id: session_id.to_string(),
        event_tx: event_tx.clone(),
        api_messages: vec![],
        current_assistant_content: vec![],
        tool_registry: state.tool_registry.clone(),
        background_tasks: state.background_tasks.clone(),
        agent_spawner,
        orchestrate_depth: 0,
        node_id: None,
        parent_cancel_token: Some(cancel_token.clone()),
    })
}

/// 持久化新 entries 到 JSONL 并返回总文本长度
fn persist_entries(
    session_path: &Path,
    new_entries: &[TranscriptEntry],
) -> Result<usize, String> {
    for entry in new_entries {
        crate::store::jsonl::append_entry(session_path, entry).map_err(|e| e.to_string())?;
    }
    let text_len: usize = new_entries
        .iter()
        .map(|e| match e {
            TranscriptEntry::Assistant { content, .. } => content
                .iter()
                .filter_map(|b| match b {
                    AssistantContentBlock::Text { text } => Some(text.len()),
                    _ => None,
                })
                .sum::<usize>(),
            _ => 0,
        })
        .sum();
    Ok(text_len)
}

#[tauri::command]
pub async fn check_api_key(state: State<'_, AppState>) -> Result<bool, String> {
    let registry = state.provider_registry.read().map_err(|e| format!("registry lock: {e}"))?;
    Ok(!registry.is_empty())
}

#[tauri::command]
pub async fn get_config(state: State<'_, AppState>) -> Result<ConfigResponse, String> {
    let agent = &state.config;
    let registry = state.provider_registry.read().map_err(|e| format!("registry lock: {e}"))?;
    let providers_config = crate::engine::config::load_providers();
    let current_model = state.current_model.read().map_err(|e| format!("model lock: {e}"))?.clone();
    let default_model = providers_config.default_model
        .or_else(|| registry.default_model_ref())
        .unwrap_or_default();

    // 脱敏 API keys
    let providers = providers_config.providers.into_iter().map(|mut p| {
        p.api_key = mask_api_key(&p.api_key);
        p
    }).collect();

    Ok(ConfigResponse {
        providers,
        default_model,
        current_model,
        max_turns: agent.max_turns,
        context_window: agent.context_window,
        max_output_tokens: agent.max_output_tokens,
        tool_output_max_bytes: agent.tool_output_max_bytes,
        bash_default_timeout_secs: agent.bash_default_timeout_secs,
        thinking_enabled: agent.thinking_enabled,
        thinking_budget_tokens: agent.thinking_budget_tokens,
    })
}

/// API Key 脱敏：只显示前 6 位和后 4 位
fn mask_api_key(key: &str) -> String {
    if key.len() <= 10 {
        return "*".repeat(key.len());
    }
    format!("{}...{}", &key[..6], &key[key.len()-4..])
}

#[tauri::command]
pub async fn update_config(
    payload: UpdateConfigRequest,
    state: State<'_, AppState>,
) -> Result<(), String> {
    crate::engine::config::save_config(
        "", // API key 不再通过此路径保存
        "",
        "",
        payload.max_turns,
        payload.context_window,
        payload.max_output_tokens,
        payload.tool_output_max_bytes,
        payload.bash_default_timeout_secs,
        payload.thinking_enabled,
        payload.thinking_budget_tokens,
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

// ── Multi-Provider Commands ──────────────────────────────────

#[tauri::command]
pub async fn list_models(state: State<'_, AppState>) -> Result<Vec<ModelInfo>, String> {
    let registry = state.provider_registry.read().map_err(|e| format!("registry lock: {e}"))?;
    Ok(registry.list_models())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCurrentModelRequest {
    pub model_ref: String,
}

#[tauri::command]
pub async fn set_current_model(
    payload: SetCurrentModelRequest,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (provider_name, _) = parse_model_ref(&payload.model_ref).map_err(|e| e.to_string())?;
    {
        let registry = state.provider_registry.read().map_err(|e| format!("registry lock: {e}"))?;
        if registry.get_provider(provider_name).is_none() {
            return Err(format!("provider '{}' not found", provider_name));
        }
    }
    let mut m = state.current_model.write().map_err(|e| format!("model lock: {e}"))?;
    *m = payload.model_ref;
    Ok(())
}

#[tauri::command]
pub async fn save_provider(
    payload: ProviderConfig,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // 持久化到 config.toml
    crate::engine::config::save_provider_config(&payload, &state.config)
        .map_err(|e| e.to_string())?;

    // 热更新 registry
    let mut registry = state.provider_registry.write().map_err(|e| format!("registry lock: {e}"))?;
    registry.update_provider(payload);
    Ok(())
}

#[tauri::command]
pub async fn delete_provider(
    name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // 持久化
    crate::engine::config::delete_provider(&name)
        .map_err(|e| e.to_string())?;

    // 热更新 registry
    let mut registry = state.provider_registry.write().map_err(|e| format!("registry lock: {e}"))?;
    registry.remove_provider(&name);
    Ok(())
}

#[tauri::command]
pub async fn cancel_message(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let token = state.cancel_tokens.lock().unwrap().get(&session_id).cloned();
    if let Some(token) = token {
        token.cancel();
    } else {
        return Err(format!("no active session '{session_id}'"));
    }
    Ok(())
}

#[tauri::command]
pub async fn kill_task(task_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut tree = state.task_tree.lock().await;
    if !tree.request_kill(&task_id) {
        return Err(format!("task '{}' not found", task_id));
    }
    Ok(())
}

#[tauri::command]
pub async fn pause_task(task_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut tree = state.task_tree.lock().await;
    if !tree.request_pause(&task_id) {
        return Err(format!("task '{}' not found", task_id));
    }
    Ok(())
}

#[tauri::command]
pub async fn resume_task(task_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut tree = state.task_tree.lock().await;
    if !tree.request_resume(&task_id) {
        return Err(format!("task '{}' not found", task_id));
    }
    Ok(())
}

#[tauri::command]
pub async fn load_sidechain_history(
    session_id: String,
    sidechain_id: String,
    sidechain_type: String,
    state: State<'_, AppState>,
) -> Result<Vec<TranscriptEntry>, String> {
    crate::store::jsonl::load_sidechain_entries(
        &state.data_dir, &session_id, &sidechain_id, &sidechain_type,
    )
    .map_err(|e| e.to_string())
}
