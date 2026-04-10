use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsage {
    pub input_tokens: u32,
    pub output_tokens: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AssistantContentBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "tool_use")]
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum UserContentBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "tool_result")]
    ToolResult {
        tool_use_id: String,
        content: String,
        is_error: bool,
    },
}

fn deserialize_assistant_content<'de, D>(
    deserializer: D,
) -> Result<Vec<AssistantContentBlock>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum ContentOrString {
        Blocks(Vec<AssistantContentBlock>),
        String(String),
    }

    match ContentOrString::deserialize(deserializer)? {
        ContentOrString::Blocks(blocks) => Ok(blocks),
        ContentOrString::String(s) => Ok(vec![AssistantContentBlock::Text { text: s }]),
    }
}

fn deserialize_user_content<'de, D>(
    deserializer: D,
) -> Result<Vec<UserContentBlock>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum ContentOrString {
        Blocks(Vec<UserContentBlock>),
        String(String),
    }

    match ContentOrString::deserialize(deserializer)? {
        ContentOrString::Blocks(blocks) => Ok(blocks),
        ContentOrString::String(s) => Ok(vec![UserContentBlock::Text { text: s }]),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum TranscriptEntry {
    #[serde(rename = "user")]
    User {
        uuid: String,
        parent_uuid: Option<String>,
        timestamp: String,
        session_id: String,
        #[serde(deserialize_with = "deserialize_user_content")]
        content: Vec<UserContentBlock>,
    },
    #[serde(rename = "assistant")]
    Assistant {
        uuid: String,
        parent_uuid: Option<String>,
        timestamp: String,
        session_id: String,
        #[serde(deserialize_with = "deserialize_assistant_content")]
        content: Vec<AssistantContentBlock>,
        usage: Option<TokenUsage>,
    },
    #[serde(rename = "system")]
    System {
        uuid: String,
        parent_uuid: Option<String>,
        timestamp: String,
        session_id: String,
        content: String,
    },
    #[serde(rename = "custom_title")]
    CustomTitle {
        session_id: String,
        title: String,
    },
    #[serde(rename = "summary")]
    Summary {
        session_id: String,
        leaf_uuid: String,
        summary: String,
    },
    #[serde(rename = "task_node")]
    TaskNode {
        uuid: String,
        parent_uuid: Option<String>,
        timestamp: String,
        session_id: String,
        task_id: String,
        parent_id: Option<String>,
        description: String,
        status: String,
        mode: String,
        subagent_type: Option<String>,
        created_at: String,
        completed_at: Option<String>,
        budget: crate::engine::task_tree::TaskBudget,
        usage: crate::engine::task_tree::TaskUsage,
    },
    #[serde(rename = "orchestrate_node")]
    OrchestrateNode {
        uuid: String,
        parent_uuid: Option<String>,
        timestamp: String,
        session_id: String,
        node_id: String,
        parent_id: Option<String>,
        role: String,
        depth: u32,
        description: String,
        status: String,
        directive: String,
        agent_id: String,
        budget: crate::engine::task_tree::TaskBudget,
        usage: crate::engine::task_tree::TaskUsage,
        children_ids: Vec<String>,
        feedback_history: Vec<crate::engine::task_tree::FeedbackMessage>,
        reuse_count: u32,
        last_active_at: String,
    },
    #[serde(rename = "feedback")]
    Feedback {
        uuid: String,
        parent_uuid: Option<String>,
        timestamp: String,
        session_id: String,
        task_id: String,
        message: String,
        severity: String,
    },
}

impl TranscriptEntry {
    #[allow(dead_code)]
    pub fn new_user(session_id: &str, content: &str, parent_uuid: Option<String>) -> Self {
        Self::User {
            uuid: Uuid::new_v4().to_string(),
            parent_uuid,
            timestamp: Utc::now().to_rfc3339(),
            session_id: session_id.to_string(),
            content: vec![UserContentBlock::Text {
                text: content.into(),
            }],
        }
    }

    #[allow(dead_code)]
    pub fn new_assistant(
        session_id: &str,
        content: &str,
        parent_uuid: Option<String>,
        usage: Option<TokenUsage>,
    ) -> Self {
        Self::Assistant {
            uuid: Uuid::new_v4().to_string(),
            parent_uuid,
            timestamp: Utc::now().to_rfc3339(),
            session_id: session_id.to_string(),
            content: vec![AssistantContentBlock::Text {
                text: content.into(),
            }],
            usage,
        }
    }

    pub fn uuid(&self) -> &str {
        match self {
            TranscriptEntry::User { uuid, .. } => uuid,
            TranscriptEntry::Assistant { uuid, .. } => uuid,
            TranscriptEntry::System { uuid, .. } => uuid,
            TranscriptEntry::CustomTitle { .. } => "",
            TranscriptEntry::Summary { .. } => "",
            TranscriptEntry::TaskNode { uuid, .. } => uuid,
            TranscriptEntry::OrchestrateNode { uuid, .. } => uuid,
            TranscriptEntry::Feedback { uuid, .. } => uuid,
        }
    }

    #[allow(dead_code)]
    pub fn parent_uuid(&self) -> Option<&str> {
        match self {
            TranscriptEntry::User { parent_uuid, .. } => parent_uuid.as_deref(),
            TranscriptEntry::Assistant { parent_uuid, .. } => parent_uuid.as_deref(),
            TranscriptEntry::System { parent_uuid, .. } => parent_uuid.as_deref(),
            TranscriptEntry::CustomTitle { .. } => None,
            TranscriptEntry::Summary { .. } => None,
            TranscriptEntry::TaskNode { parent_uuid, .. } => parent_uuid.as_deref(),
            TranscriptEntry::OrchestrateNode { parent_uuid, .. } => parent_uuid.as_deref(),
            TranscriptEntry::Feedback { parent_uuid, .. } => parent_uuid.as_deref(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_user_entry_serialization_roundtrip() {
        let entry = TranscriptEntry::User {
            uuid: "u1".to_string(),
            parent_uuid: None,
            timestamp: "2026-01-01T00:00:00Z".to_string(),
            session_id: "s1".to_string(),
            content: vec![UserContentBlock::Text {
                text: "hello".to_string(),
            }],
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("\"type\":\"user\""));
        assert!(json.contains("\"type\":\"text\""));
        assert!(json.contains("\"text\":\"hello\""));

        let de: TranscriptEntry = serde_json::from_str(&json).unwrap();
        assert!(matches!(de, TranscriptEntry::User { .. }));
    }

    #[test]
    fn test_user_entry_old_format_deserialization() {
        let json = r#"{"type":"user","uuid":"u1","parent_uuid":null,"timestamp":"2026-01-01T00:00:00Z","session_id":"s1","content":"hello"}"#;
        let de: TranscriptEntry = serde_json::from_str(json).unwrap();
        if let TranscriptEntry::User { content, .. } = de {
            assert_eq!(content.len(), 1);
            assert!(matches!(content[0], UserContentBlock::Text { ref text } if text == "hello"));
        } else {
            panic!("Expected User variant");
        }
    }

    #[test]
    fn test_assistant_entry_with_usage() {
        let entry = TranscriptEntry::Assistant {
            uuid: "a1".to_string(),
            parent_uuid: Some("u1".to_string()),
            timestamp: "2026-01-01T00:00:00Z".to_string(),
            session_id: "s1".to_string(),
            content: vec![AssistantContentBlock::Text {
                text: "response".to_string(),
            }],
            usage: Some(TokenUsage {
                input_tokens: 100,
                output_tokens: 50,
            }),
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("\"type\":\"assistant\""));
        assert!(json.contains("\"input_tokens\":100"));

        let de: TranscriptEntry = serde_json::from_str(&json).unwrap();
        if let TranscriptEntry::Assistant { usage, .. } = de {
            assert_eq!(usage.unwrap().input_tokens, 100);
        } else {
            panic!("Expected Assistant variant");
        }
    }

    #[test]
    fn test_assistant_entry_old_format_deserialization() {
        let json = r#"{"type":"assistant","uuid":"a1","parent_uuid":"u1","timestamp":"2026-01-01T00:00:00Z","session_id":"s1","content":"response","usage":null}"#;
        let de: TranscriptEntry = serde_json::from_str(json).unwrap();
        if let TranscriptEntry::Assistant { content, .. } = de {
            assert_eq!(content.len(), 1);
            assert!(matches!(content[0], AssistantContentBlock::Text { ref text } if text == "response"));
        } else {
            panic!("Expected Assistant variant");
        }
    }

    #[test]
    fn test_assistant_tool_use_block() {
        let json = r#"{"type":"assistant","uuid":"a1","parent_uuid":null,"timestamp":"2026-01-01T00:00:00Z","session_id":"s1","content":[{"type":"tool_use","id":"t1","name":"Read","input":{}}],"usage":null}"#;
        let de: TranscriptEntry = serde_json::from_str(json).unwrap();
        if let TranscriptEntry::Assistant { content, .. } = de {
            assert_eq!(content.len(), 1);
            assert!(matches!(content[0], AssistantContentBlock::ToolUse { ref id, ref name, .. } if id == "t1" && name == "Read"));
        } else {
            panic!("Expected Assistant variant");
        }
    }

    #[test]
    fn test_custom_title_no_uuid_fields() {
        let entry = TranscriptEntry::CustomTitle {
            session_id: "s1".to_string(),
            title: "My Chat".to_string(),
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("\"type\":\"custom_title\""));
        assert!(!json.contains("uuid"));

        let de: TranscriptEntry = serde_json::from_str(&json).unwrap();
        assert!(matches!(de, TranscriptEntry::CustomTitle { .. }));
    }

    #[test]
    fn test_summary_entry_serialization() {
        let entry = TranscriptEntry::Summary {
            session_id: "s1".to_string(),
            leaf_uuid: "leaf-1".to_string(),
            summary: "conversation about X".to_string(),
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("\"type\":\"summary\""));

        let de: TranscriptEntry = serde_json::from_str(&json).unwrap();
        assert!(matches!(de, TranscriptEntry::Summary { .. }));
    }

    #[test]
    fn test_new_user_helper() {
        let entry = TranscriptEntry::new_user("s1", "hi", None);
        assert!(matches!(entry, TranscriptEntry::User { .. }));
        assert_eq!(entry.parent_uuid(), None);
        assert!(!entry.uuid().is_empty());
    }

    #[test]
    fn test_new_assistant_helper() {
        let entry = TranscriptEntry::new_assistant(
            "s1",
            "hello!",
            Some("parent-uuid".to_string()),
            None,
        );
        assert!(matches!(entry, TranscriptEntry::Assistant { .. }));
        assert_eq!(entry.parent_uuid(), Some("parent-uuid"));
    }

    #[test]
    fn test_parent_uuid_chain() {
        let user = TranscriptEntry::new_user("s1", "q", None);
        let user_uuid = user.uuid().to_string();
        let assistant = TranscriptEntry::new_assistant(
            "s1",
            "a",
            Some(user_uuid.clone()),
            None,
        );
        assert_eq!(assistant.parent_uuid(), Some(user_uuid.as_str()));
    }

    #[test]
    fn test_task_node_entry_serialization() {
        let entry = TranscriptEntry::TaskNode {
            uuid: "u1".to_string(),
            parent_uuid: None,
            timestamp: "2026-04-11T00:00:00Z".to_string(),
            session_id: "s1".to_string(),
            task_id: "da_abc12345".to_string(),
            parent_id: None,
            description: "test".to_string(),
            status: "pending".to_string(),
            mode: "preset".to_string(),
            subagent_type: None,
            created_at: "2026-04-11T00:00:00Z".to_string(),
            completed_at: None,
            budget: crate::engine::task_tree::TaskBudget::default(),
            usage: crate::engine::task_tree::TaskUsage::default(),
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("\"type\":\"task_node\""));
        assert!(json.contains("\"task_id\":\"da_abc12345\""));

        let de: TranscriptEntry = serde_json::from_str(&json).unwrap();
        assert!(matches!(de, TranscriptEntry::TaskNode { .. }));
    }

    #[test]
    fn test_orchestrate_node_entry_serialization() {
        let entry = TranscriptEntry::OrchestrateNode {
            uuid: "u2".to_string(),
            parent_uuid: None,
            timestamp: "2026-04-11T00:00:00Z".to_string(),
            session_id: "s1".to_string(),
            node_id: "or_xyz98765".to_string(),
            parent_id: None,
            role: "orchestrator".to_string(),
            depth: 0,
            description: "orchestrator".to_string(),
            status: "idle".to_string(),
            directive: "coordinate".to_string(),
            agent_id: "agent-1".to_string(),
            budget: crate::engine::task_tree::TaskBudget::default(),
            usage: crate::engine::task_tree::TaskUsage::default(),
            children_ids: vec![],
            feedback_history: vec![],
            reuse_count: 0,
            last_active_at: "2026-04-11T00:00:00Z".to_string(),
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("\"type\":\"orchestrate_node\""));
        assert!(json.contains("\"node_id\":\"or_xyz98765\""));

        let de: TranscriptEntry = serde_json::from_str(&json).unwrap();
        assert!(matches!(de, TranscriptEntry::OrchestrateNode { .. }));
    }

    #[test]
    fn test_feedback_entry_serialization() {
        let entry = TranscriptEntry::Feedback {
            uuid: "u3".to_string(),
            parent_uuid: Some("p1".to_string()),
            timestamp: "2026-04-11T00:00:00Z".to_string(),
            session_id: "s1".to_string(),
            task_id: "da_abc12345".to_string(),
            message: "task completed".to_string(),
            severity: "info".to_string(),
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("\"type\":\"feedback\""));
        assert!(json.contains("\"task_id\":\"da_abc12345\""));

        let de: TranscriptEntry = serde_json::from_str(&json).unwrap();
        assert!(matches!(de, TranscriptEntry::Feedback { .. }));
    }

    #[test]
    fn test_p2_entries_uuid_and_parent() {
        let task = TranscriptEntry::TaskNode {
            uuid: "t1".to_string(),
            parent_uuid: Some("p1".to_string()),
            timestamp: "2026-04-11T00:00:00Z".to_string(),
            session_id: "s1".to_string(),
            task_id: "da_x".to_string(),
            parent_id: None,
            description: "d".to_string(),
            status: "pending".to_string(),
            mode: "preset".to_string(),
            subagent_type: None,
            created_at: "2026-04-11T00:00:00Z".to_string(),
            completed_at: None,
            budget: crate::engine::task_tree::TaskBudget::default(),
            usage: crate::engine::task_tree::TaskUsage::default(),
        };
        assert_eq!(task.uuid(), "t1");
        assert_eq!(task.parent_uuid(), Some("p1"));

        let feedback = TranscriptEntry::Feedback {
            uuid: "f1".to_string(),
            parent_uuid: None,
            timestamp: "2026-04-11T00:00:00Z".to_string(),
            session_id: "s1".to_string(),
            task_id: "da_x".to_string(),
            message: "m".to_string(),
            severity: "info".to_string(),
        };
        assert_eq!(feedback.uuid(), "f1");
        assert_eq!(feedback.parent_uuid(), None);
    }
}
