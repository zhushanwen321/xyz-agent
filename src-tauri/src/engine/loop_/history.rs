use crate::types::TranscriptEntry;

/// 将 TranscriptEntry 列表转换为 LLM API messages
pub fn history_to_api_messages(history: &[TranscriptEntry]) -> Vec<serde_json::Value> {
    history
        .iter()
        .filter_map(|entry| match entry {
            TranscriptEntry::User { content, .. } => {
                if content.is_empty() {
                    None
                } else {
                    Some(serde_json::json!({
                        "role": "user",
                        "content": content,
                    }))
                }
            }
            TranscriptEntry::Assistant { content, .. } => {
                if content.is_empty() {
                    None
                } else {
                    Some(serde_json::json!({
                        "role": "assistant",
                        "content": content,
                    }))
                }
            }
            _ => None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AssistantContentBlock, UserContentBlock};

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
                content: vec![UserContentBlock::Text {
                    text: "hello".to_string(),
                }],
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
                content: vec![AssistantContentBlock::Text {
                    text: "response".to_string(),
                }],
                usage: None,
            },
        ];

        let messages = history_to_api_messages(&history);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[0]["content"][0]["type"], "text");
        assert_eq!(messages[0]["content"][0]["text"], "hello");
        assert_eq!(messages[1]["role"], "assistant");
        assert_eq!(messages[1]["content"][0]["type"], "text");
        assert_eq!(messages[1]["content"][0]["text"], "response");
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
                content: vec![UserContentBlock::Text {
                    text: "first".to_string(),
                }],
            },
            TranscriptEntry::Assistant {
                uuid: "a1".to_string(),
                parent_uuid: Some("u1".to_string()),
                timestamp: "2026-01-01T00:00:01Z".to_string(),
                session_id: "s1".to_string(),
                content: vec![AssistantContentBlock::Text {
                    text: "second".to_string(),
                }],
                usage: None,
            },
            TranscriptEntry::User {
                uuid: "u2".to_string(),
                parent_uuid: Some("a1".to_string()),
                timestamp: "2026-01-01T00:00:02Z".to_string(),
                session_id: "s1".to_string(),
                content: vec![UserContentBlock::Text {
                    text: "third".to_string(),
                }],
            },
        ];

        let messages = history_to_api_messages(&history);
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["content"][0]["text"], "first");
        assert_eq!(messages[1]["content"][0]["text"], "second");
        assert_eq!(messages[2]["content"][0]["text"], "third");

        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[1]["role"], "assistant");
        assert_eq!(messages[2]["role"], "user");
    }

    #[test]
    fn history_to_api_messages_preserves_tool_use_blocks() {
        let history = vec![
            TranscriptEntry::Assistant {
                uuid: "a1".to_string(),
                parent_uuid: None,
                timestamp: "2026-01-01T00:00:00Z".to_string(),
                session_id: "s1".to_string(),
                content: vec![
                    AssistantContentBlock::Text {
                        text: "let me read that".to_string(),
                    },
                    AssistantContentBlock::ToolUse {
                        id: "toolu_123".to_string(),
                        name: "read_file".to_string(),
                        input: serde_json::json!({"path": "/tmp/test"}),
                    },
                ],
                usage: None,
            },
            TranscriptEntry::User {
                uuid: "u1".to_string(),
                parent_uuid: Some("a1".to_string()),
                timestamp: "2026-01-01T00:00:01Z".to_string(),
                session_id: "s1".to_string(),
                content: vec![UserContentBlock::ToolResult {
                    tool_use_id: "toolu_123".to_string(),
                    content: "file content here".to_string(),
                    is_error: false,
                }],
            },
        ];

        let messages = history_to_api_messages(&history);
        assert_eq!(messages.len(), 2);

        assert_eq!(messages[0]["role"], "assistant");
        let assistant_content = messages[0]["content"].as_array().unwrap();
        assert_eq!(assistant_content.len(), 2);
        assert_eq!(assistant_content[0]["type"], "text");
        assert_eq!(assistant_content[1]["type"], "tool_use");
        assert_eq!(assistant_content[1]["id"], "toolu_123");
        assert_eq!(assistant_content[1]["name"], "read_file");

        assert_eq!(messages[1]["role"], "user");
        let user_content = messages[1]["content"].as_array().unwrap();
        assert_eq!(user_content.len(), 1);
        assert_eq!(user_content[0]["type"], "tool_result");
        assert_eq!(user_content[0]["tool_use_id"], "toolu_123");
    }
}
