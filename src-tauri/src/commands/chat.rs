use crate::commands::session::AppState;
use crate::db::{jsonl, session_index};
use crate::models::{TranscriptEntry, UserContentBlock};
use crate::services::agent_loop::AgentLoop;
use crate::services::event_bus;
use crate::services::prompt_manager::{DynamicContext, PromptManager};
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

    // 临时创建 ToolRegistry（Plan D 将移到 AppState）
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

    let new_entries = agent_loop
        .run_turn(
            content,
            history,
            Some(user_entry.uuid().to_string()),
            event_tx,
            &state.tool_registry,
            &state.global_perms,
            &prompt_manager,
            &dynamic_context,
        )
        .await
        .map_err(|e| {
            log::error!("[chat] agent_loop error: {e}");
            e.to_string()
        })?;

    // 将所有新增 entries 写入 JSONL（assistant + tool_result，不含用户消息）
    for entry in &new_entries {
        jsonl::append_entry(&session_path, entry).map_err(|e| e.to_string())?;
    }

    let text_len: usize = new_entries
        .iter()
        .map(|e| match e {
            TranscriptEntry::Assistant { content, .. } => content
                .iter()
                .filter_map(|b| match b {
                    crate::models::AssistantContentBlock::Text { text } => Some(text.len()),
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
