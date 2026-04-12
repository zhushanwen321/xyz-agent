use crate::types::AgentEvent;
use tauri::{AppHandle, Emitter};

/// 桥接 mpsc channel 到 Tauri Event
pub fn spawn_bridge(
    app_handle: AppHandle,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<AgentEvent>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            // TextDelta/ThinkingDelta 是高频流式事件，不打印日志
            match &event {
                AgentEvent::TextDelta { .. } | AgentEvent::ThinkingDelta { .. } => {}
                AgentEvent::ToolCallStart { tool_name, input, .. } => {
                    log::info!("[event_bus] ToolCallStart: tool={}, input={}", tool_name, input);
                }
                AgentEvent::ToolCallEnd { is_error, output, .. } => {
                    let level = if *is_error { log::Level::Warn } else { log::Level::Info };
                    // 在 char 边界处截断，避免 panic 在多字节 UTF-8 字符中间
                    let truncated = output.char_indices()
                        .take_while(|(i, _)| *i < 200)
                        .last()
                        .map(|(i, c)| &output[..i + c.len_utf8()])
                        .unwrap_or(output);
                    log::log!(level, "[event_bus] ToolCallEnd: is_error={}, output={}", is_error, truncated);
                }
                AgentEvent::Error { message, .. } => {
                    log::warn!("[event_bus] Error: {}", message);
                }
                _ => {
                    log::debug!("[event_bus] forwarding event: type={}, session={}", event.variant_name(), event.session_id());
                }
            }
            let _ = app_handle.emit("agent-event", &event);
        }
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn agent_event_serializes_for_tauri() {
        let event = crate::types::AgentEvent::TextDelta {
            session_id: "s1".to_string(),
            delta: "hello".to_string(),
            source_task_id: None,
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains(r#""type":"TextDelta""#));
        assert!(json.contains(r#""session_id":"s1""#));
    }
}
