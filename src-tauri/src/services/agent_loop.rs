use crate::error::AppError;
use crate::models::{AgentEvent, TokenUsage, TranscriptEntry};
use crate::services::llm::{LlmProvider, LlmStreamEvent};
use futures::StreamExt;
use std::sync::Arc;

pub struct AgentLoop {
    provider: Arc<dyn LlmProvider>,
    session_id: String,
    model: String,
}

impl AgentLoop {
    pub fn new(provider: Arc<dyn LlmProvider>, session_id: String, model: String) -> Self {
        Self {
            provider,
            session_id,
            model,
        }
    }

    pub async fn run_turn(
        &self,
        user_message: String,
        history: Vec<TranscriptEntry>,
        parent_uuid: Option<String>,
        event_tx: tokio::sync::mpsc::UnboundedSender<AgentEvent>,
    ) -> Result<TranscriptEntry, AppError> {
        let session_id = &self.session_id;

        let mut api_messages = history_to_api_messages(&history);
        api_messages.push(serde_json::json!({
            "role": "user",
            "content": user_message,
        }));

        let mut stream = self.provider.chat_stream(api_messages, &self.model).await?;

        let mut full_content = String::new();
        let mut final_usage = TokenUsage {
            input_tokens: 0,
            output_tokens: 0,
        };

        while let Some(item) = stream.next().await {
            match item {
                Ok(LlmStreamEvent::TextDelta { delta }) => {
                    if delta.is_empty() {
                        continue;
                    }
                    full_content.push_str(&delta);
                    let _ = event_tx.send(AgentEvent::TextDelta {
                        session_id: session_id.clone(),
                        delta,
                    });
                }
                Ok(LlmStreamEvent::ThinkingDelta { delta }) => {
                    let _ = event_tx.send(AgentEvent::ThinkingDelta {
                        session_id: session_id.clone(),
                        delta,
                    });
                }
                Ok(LlmStreamEvent::MessageStop { usage }) => {
                    final_usage = usage;
                    let _ = event_tx.send(AgentEvent::MessageComplete {
                        session_id: session_id.clone(),
                        role: "assistant".to_string(),
                        content: full_content.clone(),
                        usage: final_usage.clone(),
                    });
                }
                Ok(LlmStreamEvent::Error { message }) => {
                    let _ = event_tx.send(AgentEvent::Error {
                        session_id: session_id.clone(),
                        message,
                    });
                }
                Err(e) => {
                    let _ = event_tx.send(AgentEvent::Error {
                        session_id: session_id.clone(),
                        message: e.to_string(),
                    });
                    return Err(e);
                }
            }
        }

        let now = chrono::Utc::now().to_rfc3339();
        Ok(TranscriptEntry::Assistant {
            uuid: uuid::Uuid::new_v4().to_string(),
            parent_uuid,
            timestamp: now,
            session_id: session_id.clone(),
            content: full_content,
            usage: Some(final_usage),
        })
    }
}

fn history_to_api_messages(history: &[TranscriptEntry]) -> Vec<serde_json::Value> {
    history
        .iter()
        .filter_map(|entry| match entry {
            TranscriptEntry::User { content, .. } => Some(serde_json::json!({
                "role": "user",
                "content": content,
            })),
            TranscriptEntry::Assistant { content, .. } => Some(serde_json::json!({
                "role": "assistant",
                "content": content,
            })),
            _ => None,
        })
        .collect()
}

/// LLM 配置：从 .env 文件、环境变量、~/.xyz-agent/config.toml 读取
pub struct LlmConfig {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
}

/// 加载 LLM 配置，优先级：环境变量 > .env 文件 > config.toml
pub fn load_llm_config() -> Result<LlmConfig, AppError> {
    // 尝试加载 .env 文件（项目根目录下的 .env）
    // dotenvy 不会覆盖已存在的环境变量，所以环境变量优先级更高
    let _ = dotenvy::dotenv();

    let api_key = std::env::var("ANTHROPIC_API_KEY")
        .or_else(|_| read_api_key_from_config_file())
        .map_err(|_| {
            AppError::Config(
                "ANTHROPIC_API_KEY not found in .env, env, or ~/.xyz-agent/config.toml"
                    .to_string(),
            )
        })?;

    let base_url = std::env::var("ANTHROPIC_BASE_URL")
        .unwrap_or_else(|_| "https://api.anthropic.com".to_string());

    let model =
        std::env::var("LLM_MODEL").unwrap_or_else(|_| "claude-sonnet-4-20250514".to_string());

    Ok(LlmConfig {
        api_key,
        base_url,
        model,
    })
}

fn read_api_key_from_config_file() -> Result<String, ()> {
    let config_path = dirs::home_dir()
        .ok_or(())?
        .join(".xyz-agent")
        .join("config.toml");

    if !config_path.exists() {
        return Err(());
    }

    let content = std::fs::read_to_string(&config_path).map_err(|_| ())?;
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(key) = trimmed.strip_prefix("anthropic_api_key") {
            let key = key.trim_start_matches(['=', ' ']).trim();
            if !key.is_empty() {
                return Ok(key.to_string());
            }
        }
    }

    Err(())
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
    fn load_llm_config_reads_from_env() {
        let saved_key = std::env::var("ANTHROPIC_API_KEY").ok();
        let saved_url = std::env::var("ANTHROPIC_BASE_URL").ok();
        let saved_model = std::env::var("LLM_MODEL").ok();

        std::env::set_var("ANTHROPIC_API_KEY", "env-test-key");
        std::env::set_var("ANTHROPIC_BASE_URL", "https://custom.api.com");
        std::env::set_var("LLM_MODEL", "claude-opus-4");

        let config = load_llm_config().unwrap();
        assert_eq!(config.api_key, "env-test-key");
        assert_eq!(config.base_url, "https://custom.api.com");
        assert_eq!(config.model, "claude-opus-4");

        // 恢复
        match saved_key {
            Some(v) => std::env::set_var("ANTHROPIC_API_KEY", v),
            None => std::env::remove_var("ANTHROPIC_API_KEY"),
        }
        match saved_url {
            Some(v) => std::env::set_var("ANTHROPIC_BASE_URL", v),
            None => std::env::remove_var("ANTHROPIC_BASE_URL"),
        }
        match saved_model {
            Some(v) => std::env::set_var("LLM_MODEL", v),
            None => std::env::remove_var("LLM_MODEL"),
        }
    }
}
