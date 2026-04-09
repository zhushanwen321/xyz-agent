use crate::db::{jsonl, session_index};
use crate::models::TranscriptEntry;
use crate::services::llm::LlmProvider;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

pub struct AppState {
    pub config_dir: PathBuf,
    pub provider: Arc<dyn LlmProvider>,
    pub model: String,
}

#[tauri::command]
pub async fn new_session(cwd: String, state: State<'_, AppState>) -> Result<Value, String> {
    let meta = session_index::new_session(&state.config_dir, &cwd)
        .map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "session_id": meta.id,
        "title": meta.title,
    }))
}

#[tauri::command]
pub async fn list_sessions(
    cwd: String,
    state: State<'_, AppState>,
) -> Result<Vec<session_index::SessionMeta>, String> {
    session_index::list_sessions(&state.config_dir, &cwd).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_history(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<TranscriptEntry>, String> {
    let projects_dir = state.config_dir.join("projects");
    if !projects_dir.exists() {
        return Err(format!("session {} not found", session_id));
    }

    let entry = walkdir_for_session(&projects_dir, &session_id)
        .ok_or_else(|| format!("session {} not found", session_id))?;

    jsonl::read_all_entries(&entry).map_err(|e| e.to_string())
}

/// 在 projects 目录下递归查找 session JSONL 文件
fn walkdir_for_session(
    projects_dir: &std::path::Path,
    session_id: &str,
) -> Option<std::path::PathBuf> {
    for entry in std::fs::read_dir(projects_dir).ok()? {
        let entry = entry.ok()?;
        let path = entry.path();
        if path.is_dir() {
            let target = path.join(format!("{}.jsonl", session_id));
            if target.exists() {
                return Some(target);
            }
        }
    }
    None
}
