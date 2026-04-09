use crate::db::jsonl::LoadHistoryResult;
use crate::db::session_index;
use crate::services::llm::LlmProvider;
use crate::services::tool_registry::{PermissionContext, ToolRegistry};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

pub struct AppState {
    pub data_dir: PathBuf,
    pub provider: Arc<dyn LlmProvider>,
    pub model: String,
    pub tool_registry: ToolRegistry,
    pub global_perms: PermissionContext,
}

#[tauri::command]
pub async fn new_session(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let meta = session_index::new_session(&state.data_dir).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "session_id": meta.id,
        "title": meta.title,
    }))
}

#[tauri::command]
pub async fn list_sessions(state: State<'_, AppState>) -> Result<Vec<session_index::SessionMeta>, String> {
    session_index::list_sessions(&state.data_dir).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_history(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<LoadHistoryResult, String> {
    let path = session_index::session_file_path(&state.data_dir, &session_id)
        .ok_or_else(|| format!("session {session_id} not found"))?;
    crate::db::jsonl::load_history(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_session(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    session_index::delete_session(&state.data_dir, &session_id).map_err(|e| e.to_string())
}
