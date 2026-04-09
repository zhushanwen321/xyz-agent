use crate::commands::session::AppState;
use crate::db::{jsonl, session_index};
use crate::models::{AssistantContentBlock, TranscriptEntry, UserContentBlock};
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
    let preview: String = content.chars().take(50).collect();
    log::info!("[chat] send_message: session={session_id}, content={preview}");

    let provider = state.provider.clone();
    let session_path = session_index::session_file_path(&state.data_dir, &session_id)
        .ok_or_else(|| format!("session {session_id} not found"))?;

    let mut history = jsonl::read_all_entries(&session_path).map_err(|e| e.to_string())?;
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
    jsonl::append_entry(&session_path, &user_entry).map_err(|e| e.to_string())?;

    let (event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel();
    event_bus::spawn_bridge(app, event_rx);

    let model = state.model.clone();
    log::info!("[chat] starting agent_loop, model={model}");
    let agent_loop = AgentLoop::new(provider, session_id.clone(), model);
    history.push(user_entry.clone());

    let assistant_entry = agent_loop
        .run_turn(content, history, Some(user_entry.uuid().to_string()), event_tx)
        .await
        .map_err(|e| {
            log::error!("[chat] agent_loop error: {e}");
            e.to_string()
        })?;

    let text_len = match &assistant_entry {
        TranscriptEntry::Assistant { content, .. } => content
            .iter()
            .filter_map(|b| match b {
                AssistantContentBlock::Text { text } => Some(text.len()),
                _ => None,
            })
            .sum::<usize>(),
        _ => 0,
    };
    log::info!("[chat] response received, length={}", text_len);
    jsonl::append_entry(&session_path, &assistant_entry).map_err(|e| e.to_string())?;

    Ok(())
}
