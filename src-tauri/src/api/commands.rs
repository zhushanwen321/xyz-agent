use crate::engine::context::prompt::{DynamicContext, PromptManager};
use crate::engine::loop_::AgentLoop;
use crate::engine::llm::LlmProvider;
use crate::engine::tools::{PermissionContext, ToolRegistry};
use crate::store::jsonl::LoadHistoryResult;
use crate::store::session;
use crate::types::{AssistantContentBlock, TranscriptEntry, UserContentBlock};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, State};

pub struct AppState {
    pub data_dir: PathBuf,
    pub provider: Arc<dyn LlmProvider>,
    pub model: String,
    pub tool_registry: ToolRegistry,
    pub global_perms: PermissionContext,
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

    let mut history = crate::store::jsonl::read_all_entries(&session_path).map_err(|e| e.to_string())?;
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
        conversation_summary: None,
    };

    let event_tx_for_turn = event_tx.clone();
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
