use serde::{Deserialize, Serialize};

use super::transcript::TokenUsage;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AgentEvent {
    TextDelta {
        session_id: String,
        delta: String,
    },
    ThinkingDelta {
        session_id: String,
        delta: String,
    },
    MessageComplete {
        session_id: String,
        role: String,
        content: String,
        usage: TokenUsage,
    },
    Error {
        session_id: String,
        message: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_text_delta_serialization() {
        let event = AgentEvent::TextDelta {
            session_id: "s1".to_string(),
            delta: "Hello".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"TextDelta\""));
        assert!(json.contains("\"delta\":\"Hello\""));

        let de: AgentEvent = serde_json::from_str(&json).unwrap();
        assert!(matches!(de, AgentEvent::TextDelta { .. }));
    }

    #[test]
    fn test_thinking_delta_serialization() {
        let event = AgentEvent::ThinkingDelta {
            session_id: "s1".to_string(),
            delta: "thinking...".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"ThinkingDelta\""));
    }

    #[test]
    fn test_message_complete_serialization() {
        let event = AgentEvent::MessageComplete {
            session_id: "s1".to_string(),
            role: "assistant".to_string(),
            content: "full response".to_string(),
            usage: TokenUsage {
                input_tokens: 200,
                output_tokens: 100,
            },
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"MessageComplete\""));
        assert!(json.contains("\"input_tokens\":200"));

        let de: AgentEvent = serde_json::from_str(&json).unwrap();
        if let AgentEvent::MessageComplete { usage, .. } = de {
            assert_eq!(usage.input_tokens, 200);
        } else {
            panic!("Expected MessageComplete");
        }
    }

    #[test]
    fn test_error_event_serialization() {
        let event = AgentEvent::Error {
            session_id: "s1".to_string(),
            message: "API key missing".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"Error\""));
        assert!(json.contains("\"message\":\"API key missing\""));
    }

    #[test]
    fn test_event_deserialization_from_json_str() {
        let json = r#"{"type":"TextDelta","session_id":"abc","delta":"x"}"#;
        let event: AgentEvent = serde_json::from_str(json).unwrap();
        if let AgentEvent::TextDelta {
            session_id,
            delta,
            ..
        } = event
        {
            assert_eq!(session_id, "abc");
            assert_eq!(delta, "x");
        } else {
            panic!("Expected TextDelta");
        }
    }
}
