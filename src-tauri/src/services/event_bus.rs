use crate::models::AgentEvent;
use tauri::{AppHandle, Emitter};

/// 桥接 mpsc channel 到 Tauri Event
pub fn spawn_bridge(
    app_handle: AppHandle,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<AgentEvent>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            log::debug!("[event_bus] forwarding event: type={}, session={}", event.variant_name(), event.session_id());
            let _ = app_handle.emit("agent-event", &event);
        }
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn agent_event_serializes_for_tauri() {
        let event = crate::models::AgentEvent::TextDelta {
            session_id: "s1".to_string(),
            delta: "hello".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains(r#""type":"TextDelta""#));
        assert!(json.contains(r#""session_id":"s1""#));
    }
}
