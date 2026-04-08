use crate::error::AppError;
use crate::models::{AgentEvent, TokenUsage, TranscriptEntry};
use crate::services::llm::LlmProvider;
use futures::StreamExt;
use std::sync::Arc;

pub struct AgentLoop {
    provider: Arc<dyn LlmProvider>,
    session_id: String,
}

impl AgentLoop {
    pub fn new(provider: Arc<dyn LlmProvider>, session_id: String) -> Self {
        Self {
            provider,
            session_id,
        }
    }

    pub async fn run_turn(
        &self,
        user_message: String,
        history: Vec<TranscriptEntry>,
        event_tx: tokio::sync::mpsc::UnboundedSender<AgentEvent>,
    ) -> Result<TranscriptEntry, AppError> {
        let mut api_messages = history_to_api_messages(&history);
        api_messages.push(serde_json::json!({
            "role": "user",
            "content": user_message,
        }));

        let model = "claude-sonnet-4-20250514";
        let mut stream = self.provider.chat_stream(api_messages, model).await?;

        let mut full_content = String::new();
        let mut final_usage = TokenUsage {
            input_tokens: 0,
            output_tokens: 0,
        };

        while let Some(item) = stream.next().await {
            match item {
                Ok(crate::services::llm::LlmStreamEvent::TextDelta { delta }) => {
                    full_content.push_str(&delta);
                    let _ = event_tx.send(AgentEvent::TextDelta {
                        session_id: self.session_id.clone(),
                        delta,
                    });
                }
                Ok(crate::services::llm::LlmStreamEvent::ThinkingDelta { delta }) => {
                    let _ = event_tx.send(AgentEvent::ThinkingDelta {
                        session_id: self.session_id.clone(),
                        delta,
                    });
                }
                Ok(crate::services::llm::LlmStreamEvent::MessageStop { usage }) => {
                    final_usage = usage;
                    let _ = event_tx.send(AgentEvent::MessageComplete {
                        session_id: self.session_id.clone(),
                        role: "assistant".to_string(),
                        content: full_content.clone(),
                        usage: final_usage.clone(),
                    });
                }
                Ok(crate::services::llm::LlmStreamEvent::Error { message }) => {
                    let _ = event_tx.send(AgentEvent::Error {
                        session_id: self.session_id.clone(),
                        message: message.clone(),
                    });
                }
                Err(e) => {
                    let _ = event_tx.send(AgentEvent::Error {
                        session_id: self.session_id.clone(),
                        message: e.to_string(),
                    });
                    return Err(e);
                }
            }
        }

        let now = chrono::Utc::now().to_rfc3339();
        Ok(TranscriptEntry::Assistant {
            uuid: uuid::Uuid::new_v4().to_string(),
            parent_uuid: None,
            timestamp: now,
            session_id: self.session_id.clone(),
            content: full_content,
            usage: Some(final_usage),
        })
    }
}

/// 将 TranscriptEntry 链转为 Anthropic {role, content} 数组
fn history_to_api_messages(history: &[TranscriptEntry]) -> Vec<serde_json::Value> {
    history
        .iter()
        .filter(|entry| {
            matches!(
                entry,
                TranscriptEntry::User { .. } | TranscriptEntry::Assistant { .. }
            )
        })
        .map(|entry| match entry {
            TranscriptEntry::User { content, .. } => serde_json::json!({
                "role": "user",
                "content": content,
            }),
            TranscriptEntry::Assistant { content, .. } => serde_json::json!({
                "role": "assistant",
                "content": content,
            }),
            _ => unreachable!(),
        })
        .collect()
}

/// 从环境变量或配置文件读取 Anthropic API key
pub fn extract_api_key() -> Result<String, AppError> {
    if let Ok(key) = std::env::var("ANTHROPIC_API_KEY") {
        return Ok(key);
    }

    let config_path = dirs::home_dir()
        .ok_or_else(|| AppError::Config("cannot find home directory".to_string()))?
        .join(".xyz-agent")
        .join("config.toml");

    if config_path.exists() {
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| AppError::Config(format!("read config failed: {}", e)))?;
        for line in content.lines() {
            let trimmed = line.trim();
            if let Some(key) = trimmed.strip_prefix("anthropic_api_key") {
                let key = key.trim_start_matches(['=', ' ']).trim();
                if !key.is_empty() {
                    return Ok(key.to_string());
                }
            }
        }
    }

    Err(AppError::Config(
        "ANTHROPIC_API_KEY not found in env or ~/.xyz-agent/config.toml".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_to_api_messages_filters_system_entries() {
        let history = vec![
            TranscriptEntry::System {
                uuid: "sys-1".to_string(),
                parent_uuid: None,
                timestamp: "2026-01-01T00:00:00Z".to_string(),
                session_id: "s1".to_string(),
                content: "system prompt".to_string(),
            },
            TranscriptEntry::User {
                uuid: "u1".to_string(),
                parent_uuid: None,
                timestamp: "2026-01-01T00:00:00Z".to_string(),
                session_id: "s1".to_string(),
                content: "hello".to_string(),
            },
            TranscriptEntry::CustomTitle {
                session_id: "s1".to_string(),
                title: "My Chat".to_string(),
            },
            TranscriptEntry::Summary {
                session_id: "s1".to_string(),
                leaf_uuid: "leaf-1".to_string(),
                summary: "summary text".to_string(),
            },
            TranscriptEntry::Assistant {
                uuid: "a1".to_string(),
                parent_uuid: Some("u1".to_string()),
                timestamp: "2026-01-01T00:00:01Z".to_string(),
                session_id: "s1".to_string(),
                content: "response".to_string(),
                usage: None,
            },
        ];

        let messages = history_to_api_messages(&history);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[0]["content"], "hello");
        assert_eq!(messages[1]["role"], "assistant");
        assert_eq!(messages[1]["content"], "response");
    }

    #[test]
    fn history_to_api_messages_empty() {
        let history: Vec<TranscriptEntry> = vec![];
        let messages = history_to_api_messages(&history);
        assert!(messages.is_empty());
    }

    #[test]
    fn history_to_api_messages_preserves_order() {
        let history = vec![
            TranscriptEntry::User {
                uuid: "u1".to_string(),
                parent_uuid: None,
                timestamp: "2026-01-01T00:00:00Z".to_string(),
                session_id: "s1".to_string(),
                content: "first".to_string(),
            },
            TranscriptEntry::Assistant {
                uuid: "a1".to_string(),
                parent_uuid: Some("u1".to_string()),
                timestamp: "2026-01-01T00:00:01Z".to_string(),
                session_id: "s1".to_string(),
                content: "second".to_string(),
                usage: None,
            },
            TranscriptEntry::User {
                uuid: "u2".to_string(),
                parent_uuid: Some("a1".to_string()),
                timestamp: "2026-01-01T00:00:02Z".to_string(),
                session_id: "s1".to_string(),
                content: "third".to_string(),
            },
        ];

        let messages = history_to_api_messages(&history);
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["content"], "first");
        assert_eq!(messages[1]["content"], "second");
        assert_eq!(messages[2]["content"], "third");

        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[1]["role"], "assistant");
        assert_eq!(messages[2]["role"], "user");
    }

    #[test]
    fn extract_api_key_missing_returns_error() {
        // 保存并清除环境变量
        let saved = std::env::var("ANTHROPIC_API_KEY").ok();
        std::env::remove_var("ANTHROPIC_API_KEY");

        let result = extract_api_key();
        assert!(result.is_err());
        if let Err(AppError::Config(msg)) = result {
            assert!(msg.contains("ANTHROPIC_API_KEY not found"));
        } else {
            panic!("Expected Config error");
        }

        // 恢复环境变量
        if let Some(val) = saved {
            std::env::set_var("ANTHROPIC_API_KEY", val);
        }
    }
}
