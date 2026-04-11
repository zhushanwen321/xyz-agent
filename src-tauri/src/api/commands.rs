use crate::api::AppState;
use crate::engine::tools::ToolExecutionContext;
use crate::engine::context::prompt::{DynamicContext, PromptManager};
use crate::engine::loop_::AgentLoop;
use crate::store::jsonl::LoadHistoryResult;
use crate::store::session;
use crate::types::{AssistantContentBlock, TranscriptEntry, UserContentBlock};
use serde::Deserialize;
use tauri::{AppHandle, State};

#[derive(serde::Serialize)]
pub struct ConfigResponse {
    pub anthropic_api_key: String,
    pub llm_model: String,
    pub anthropic_base_url: String,
    pub max_turns: u32,
    pub context_window: u32,
    pub max_output_tokens: u32,
    pub tool_output_max_bytes: usize,
    pub bash_default_timeout_secs: u64,
}

#[derive(Deserialize)]
pub struct UpdateConfigRequest {
    pub anthropic_api_key: String,
    pub llm_model: String,
    pub anthropic_base_url: String,
    pub max_turns: u32,
    pub context_window: u32,
    pub max_output_tokens: u32,
    pub tool_output_max_bytes: usize,
    pub bash_default_timeout_secs: u64,
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
    Ok(state.model.clone())
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

    let provider = state.provider.clone();
    let session_path = session::session_file_path(&state.data_dir, &session_id)
        .ok_or_else(|| format!("session {session_id} not found"))?;

    let LoadHistoryResult { entries: mut history, conversation_summary, .. } =
        crate::store::jsonl::load_history(&session_path).map_err(|e| e.to_string())?;
    log::debug!("[chat] history entries={}", history.len());

    let parent_uuid = history.last().map(|e| e.uuid().to_string());
    let user_entry = TranscriptEntry::User {
        uuid: uuid::Uuid::new_v4().to_string(),
        parent_uuid,
        timestamp: chrono::Utc::now().to_rfc3339(),
        session_id: session_id.clone(),
        content: vec![UserContentBlock::Text {
            text: content.clone(),
        }],
    };
    crate::store::jsonl::append_entry(&session_path, &user_entry).map_err(|e| e.to_string())?;

    let (event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel();
    crate::api::event_bus::spawn_bridge(app, event_rx);

    let model = state.model.clone();
    log::info!("[chat] starting agent_loop, model={model}");
    let agent_loop = AgentLoop::new(provider, session_id.clone(), model);
    history.push(user_entry.clone());

    let prompt_manager = PromptManager::new();
    let dynamic_context = DynamicContext {
        cwd: std::env::current_dir()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string(),
        os: std::env::consts::OS.to_string(),
        model: state.model.clone(),
        git_branch: None,
        tool_names: state.tool_registry.tool_names(),
        data_context_summary: None,
        conversation_summary,
    };

    let event_tx_for_turn = event_tx.clone();
    let tool_ctx = ToolExecutionContext {
        task_tree: state.task_tree.clone(),
        concurrency_manager: state.concurrency_manager.clone(),
        agent_templates: state.agent_templates.clone(),
        data_dir: state.data_dir.clone(),
        session_id: session_id.clone(),
        event_tx: event_tx_for_turn.clone(),
        api_messages: vec![],
        current_assistant_content: vec![],
        tool_registry: state.tool_registry.clone(),
        background_tasks: state.background_tasks.clone(),
        agent_spawner: state.agent_spawner.clone(),
        orchestrate_depth: 0,
    };
    let result = agent_loop
        .run_turn(
            content,
            history,
            Some(user_entry.uuid().to_string()),
            event_tx_for_turn,
            &state.tool_registry,
            &state.global_perms,
            &prompt_manager,
            &dynamic_context,
            &state.config,
            None,
            None,
            None,
            Some(tool_ctx),
            None,
        )
        .await;

    let _ = event_tx.send(crate::types::AgentEvent::TurnComplete {
        session_id: session_id.clone(),
    });
    drop(event_tx);

    let new_entries = result.map_err(|e| {
        log::error!("[chat] agent_loop error: {e}");
        e.to_string()
    })?;

    for entry in &new_entries {
        crate::store::jsonl::append_entry(&session_path, entry).map_err(|e| e.to_string())?;
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
    log::info!(
        "[chat] response received, entries={}, total_text_len={}",
        new_entries.len(),
        text_len
    );

    Ok(())
}

#[tauri::command]
pub async fn get_config(state: State<'_, AppState>) -> Result<ConfigResponse, String> {
    let agent = &state.config;
    let llm = crate::engine::config::load_llm_config().map_err(|e| e.to_string())?;
    Ok(ConfigResponse {
        anthropic_api_key: llm.api_key,
        llm_model: llm.model,
        anthropic_base_url: llm.base_url,
        max_turns: agent.max_turns,
        context_window: agent.context_window,
        max_output_tokens: agent.max_output_tokens,
        tool_output_max_bytes: agent.tool_output_max_bytes,
        bash_default_timeout_secs: agent.bash_default_timeout_secs,
    })
}

#[tauri::command]
pub async fn update_config(
    payload: UpdateConfigRequest,
) -> Result<(), String> {
    crate::engine::config::save_config(
        &payload.anthropic_api_key,
        &payload.llm_model,
        &payload.anthropic_base_url,
        payload.max_turns,
        payload.context_window,
        payload.max_output_tokens,
        payload.tool_output_max_bytes,
        payload.bash_default_timeout_secs,
    )
    .map_err(|e| e.to_string())
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
