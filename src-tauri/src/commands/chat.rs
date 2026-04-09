use crate::commands::session::AppState;
use crate::db::jsonl;
use crate::models::TranscriptEntry;
use crate::services::agent_loop::AgentLoop;
use crate::services::event_bus;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn send_message(
    session_id: String,
    content: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let provider = state.provider.clone();
    let config_dir = state.config_dir.clone();

    // 查找 session JSONL 路径
    let session_path = find_session_path(&config_dir, &session_id)
        .ok_or_else(|| format!("session {} not found", session_id))?;

    // 读取历史
    let history = jsonl::read_all_entries(&session_path).map_err(|e| e.to_string())?;

    // 追加 User entry
    let parent_uuid = history.last().and_then(|e| match e {
        TranscriptEntry::User { uuid, .. } => Some(uuid.clone()),
        TranscriptEntry::Assistant { uuid, .. } => Some(uuid.clone()),
        TranscriptEntry::System { uuid, .. } => Some(uuid.clone()),
        _ => None,
    });
    let user_entry = TranscriptEntry::User {
        uuid: uuid::Uuid::new_v4().to_string(),
        parent_uuid,
        timestamp: chrono::Utc::now().to_rfc3339(),
        session_id: session_id.clone(),
        content: content.clone(),
    };
    jsonl::append_entry(&session_path, &user_entry).map_err(|e| e.to_string())?;

    // 创建 channel + 桥接
    let (event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel();
    event_bus::spawn_bridge(app, event_rx);

    // 运行 AgentLoop
    let agent_loop = AgentLoop::new(provider, session_id.clone());
    let mut history_with_user = history;
    history_with_user.push(user_entry.clone());

    let assistant_entry = agent_loop
        .run_turn(content, history_with_user, Some(user_entry.uuid().to_string()), event_tx)
        .await
        .map_err(|e| e.to_string())?;

    // 追加 Assistant entry
    jsonl::append_entry(&session_path, &assistant_entry).map_err(|e| e.to_string())?;

    Ok(())
}

fn find_session_path(
    config_dir: &std::path::Path,
    session_id: &str,
) -> Option<std::path::PathBuf> {
    let projects_dir = config_dir.join("projects");
    if !projects_dir.exists() {
        return None;
    }
    for entry in std::fs::read_dir(&projects_dir).ok()? {
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
