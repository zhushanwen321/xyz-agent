pub mod anthropic;
pub mod types;
pub mod registry;
#[cfg(test)]
pub mod test_utils;

use crate::types::AppError;
use crate::types::TokenUsage;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::pin::Pin;

// ── Stream event ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum LlmStreamEvent {
    #[serde(rename = "text_delta")]
    TextDelta { delta: String },
    #[serde(rename = "thinking_delta")]
    ThinkingDelta { delta: String },
    #[serde(rename = "message_stop")]
    MessageStop {
        usage: TokenUsage,
        stop_reason: Option<String>,
    },
    #[serde(rename = "error")]
    Error { message: String },
    // tool_use 生命周期事件，用于 agent loop 驱动工具调用
    #[serde(rename = "tool_use_start")]
    ToolUseStart { id: String, name: String, index: u64 },
    #[serde(rename = "tool_use_input_delta")]
    ToolUseInputDelta { id: String, partial_input: String },
    #[serde(rename = "tool_use_end")]
    ToolUseEnd { id: String },
}

// ── Provider trait ────────────────────────────────────────────

#[async_trait]
pub trait LlmProvider: Send + Sync {
    async fn chat_stream(
        &self,
        system: Vec<serde_json::Value>,
        messages: Vec<serde_json::Value>,
        model: &str,
        tools: Option<Vec<serde_json::Value>>,
    ) -> Result<Pin<Box<dyn futures::Stream<Item = Result<LlmStreamEvent, AppError>> + Send>>, AppError>;
}

pub use types::{ModelTier, ModelEntry, ProviderConfig, ModelInfo, parse_model_ref};

// ── 单元测试 ──────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_delta_serialization_roundtrip() {
        let event = LlmStreamEvent::TextDelta {
            delta: "hello".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"text_delta\""));
        assert!(json.contains("\"delta\":\"hello\""));

        let de: LlmStreamEvent = serde_json::from_str(&json).unwrap();
        assert!(matches!(de, LlmStreamEvent::TextDelta { .. }));
        if let LlmStreamEvent::TextDelta { delta } = de {
            assert_eq!(delta, "hello");
        }
    }

    #[test]
    fn message_stop_serialization() {
        let event = LlmStreamEvent::MessageStop {
            usage: TokenUsage {
                input_tokens: 100,
                output_tokens: 50,
            },
            stop_reason: Some("end_turn".to_string()),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"message_stop\""));
        assert!(json.contains("\"input_tokens\":100"));
        assert!(json.contains("\"output_tokens\":50"));
        assert!(json.contains("\"stop_reason\":\"end_turn\""));

        let de: LlmStreamEvent = serde_json::from_str(&json).unwrap();
        if let LlmStreamEvent::MessageStop { usage, stop_reason } = de {
            assert_eq!(usage.input_tokens, 100);
            assert_eq!(stop_reason, Some("end_turn".to_string()));
        } else {
            panic!("Expected MessageStop variant");
        }
    }

    #[test]
    fn error_event_serialization() {
        let event = LlmStreamEvent::Error {
            message: "rate limited".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"error\""));
        assert!(json.contains("\"message\":\"rate limited\""));

        let de: LlmStreamEvent = serde_json::from_str(&json).unwrap();
        if let LlmStreamEvent::Error { message } = de {
            assert_eq!(message, "rate limited");
        } else {
            panic!("Expected Error variant");
        }
    }

    #[test]
    fn tool_use_start_serialization() {
        let event = LlmStreamEvent::ToolUseStart {
            id: "toolu_123".to_string(),
            name: "read_file".to_string(),
            index: 0,
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"tool_use_start\""));
        assert!(json.contains("\"id\":\"toolu_123\""));
        assert!(json.contains("\"name\":\"read_file\""));

        let de: LlmStreamEvent = serde_json::from_str(&json).unwrap();
        if let LlmStreamEvent::ToolUseStart { id, name, .. } = de {
            assert_eq!(id, "toolu_123");
            assert_eq!(name, "read_file");
        } else {
            panic!("Expected ToolUseStart variant");
        }
    }

    #[test]
    fn tool_use_input_delta_serialization() {
        let event = LlmStreamEvent::ToolUseInputDelta {
            id: "0".to_string(),
            partial_input: r#"{"path":"/tmp"#.to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"tool_use_input_delta\""));
        assert!(json.contains("\"partial_input\":"));

        let de: LlmStreamEvent = serde_json::from_str(&json).unwrap();
        if let LlmStreamEvent::ToolUseInputDelta { id, partial_input } = de {
            assert_eq!(id, "0");
            assert_eq!(partial_input, r#"{"path":"/tmp"#);
        } else {
            panic!("Expected ToolUseInputDelta variant");
        }
    }

    #[test]
    fn tool_use_end_serialization() {
        let event = LlmStreamEvent::ToolUseEnd {
            id: "toolu_123".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"tool_use_end\""));
        assert!(json.contains("\"id\":\"toolu_123\""));

        let de: LlmStreamEvent = serde_json::from_str(&json).unwrap();
        if let LlmStreamEvent::ToolUseEnd { id } = de {
            assert_eq!(id, "toolu_123");
        } else {
            panic!("Expected ToolUseEnd variant");
        }
    }

    #[test]
    fn message_stop_without_stop_reason() {
        let event = LlmStreamEvent::MessageStop {
            usage: TokenUsage { input_tokens: 0, output_tokens: 0 },
            stop_reason: None,
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"stop_reason\":null"));

        let de: LlmStreamEvent = serde_json::from_str(&json).unwrap();
        if let LlmStreamEvent::MessageStop { stop_reason, .. } = de {
            assert!(stop_reason.is_none());
        } else {
            panic!("Expected MessageStop variant");
        }
    }
}
