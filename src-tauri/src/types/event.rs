use serde::{Deserialize, Serialize};

use super::transcript::TokenUsage;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskBudgetSummary {
    pub max_tokens: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskUsageSummary {
    pub total_tokens: u32,
    pub tool_uses: u32,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AgentEvent {
    TextDelta {
        session_id: String,
        delta: String,
        source_task_id: Option<String>,
    },
    ThinkingDelta {
        session_id: String,
        delta: String,
        source_task_id: Option<String>,
    },
    MessageComplete {
        session_id: String,
        role: String,
        content: String,
        usage: TokenUsage,
        source_task_id: Option<String>,
    },
    Error {
        session_id: String,
        message: String,
        source_task_id: Option<String>,
    },
    ToolCallStart {
        session_id: String,
        tool_name: String,
        tool_use_id: String,
        input: serde_json::Value,
        source_task_id: Option<String>,
    },
    ToolCallEnd {
        session_id: String,
        tool_use_id: String,
        is_error: bool,
        output: String,
        source_task_id: Option<String>,
    },
    TurnComplete {
        session_id: String,
        source_task_id: Option<String>,
    },
    TaskCreated {
        session_id: String,
        task_id: String,
        description: String,
        mode: String,
        subagent_type: String,
        budget: TaskBudgetSummary,
        tool_use_id: Option<String>,
    },
    TaskProgress {
        session_id: String,
        task_id: String,
        usage: TaskUsageSummary,
    },
    TaskCompleted {
        session_id: String,
        task_id: String,
        status: String,
        result_summary: String,
        usage: TaskUsageSummary,
    },
    BudgetWarning {
        session_id: String,
        task_id: String,
        usage_percent: u32,
    },
    TaskFeedback {
        session_id: String,
        task_id: String,
        message: String,
        severity: String,
    },

    OrchestrateNodeCreated {
        session_id: String,
        node_id: String,
        parent_id: Option<String>,
        role: String,
        depth: u32,
        description: String,
    },
    OrchestrateNodeProgress {
        session_id: String,
        node_id: String,
        usage: TaskUsageSummary,
    },
    OrchestrateNodeCompleted {
        session_id: String,
        node_id: String,
        status: String,
        result_summary: String,
        usage: TaskUsageSummary,
    },
    OrchestrateNodeIdle {
        session_id: String,
        node_id: String,
    },
    OrchestrateFeedback {
        session_id: String,
        node_id: String,
        direction: String,
        message: String,
        severity: String,
    },
}

impl AgentEvent {
    pub fn session_id(&self) -> &str {
        match self {
            AgentEvent::TextDelta { session_id, .. } => session_id,
            AgentEvent::ThinkingDelta { session_id, .. } => session_id,
            AgentEvent::MessageComplete { session_id, .. } => session_id,
            AgentEvent::Error { session_id, .. } => session_id,
            AgentEvent::ToolCallStart { session_id, .. } => session_id,
            AgentEvent::ToolCallEnd { session_id, .. } => session_id,
            AgentEvent::TurnComplete { session_id, .. } => session_id,
            AgentEvent::TaskCreated { session_id, .. } => session_id,
            AgentEvent::TaskProgress { session_id, .. } => session_id,
            AgentEvent::TaskCompleted { session_id, .. } => session_id,
            AgentEvent::BudgetWarning { session_id, .. } => session_id,
            AgentEvent::TaskFeedback { session_id, .. } => session_id,
            AgentEvent::OrchestrateNodeCreated { session_id, .. } => session_id,
            AgentEvent::OrchestrateNodeProgress { session_id, .. } => session_id,
            AgentEvent::OrchestrateNodeCompleted { session_id, .. } => session_id,
            AgentEvent::OrchestrateNodeIdle { session_id, .. } => session_id,
            AgentEvent::OrchestrateFeedback { session_id, .. } => session_id,
        }
    }

    pub fn variant_name(&self) -> &'static str {
        match self {
            AgentEvent::TextDelta { .. } => "TextDelta",
            AgentEvent::ThinkingDelta { .. } => "ThinkingDelta",
            AgentEvent::MessageComplete { .. } => "MessageComplete",
            AgentEvent::Error { .. } => "Error",
            AgentEvent::ToolCallStart { .. } => "ToolCallStart",
            AgentEvent::ToolCallEnd { .. } => "ToolCallEnd",
            AgentEvent::TurnComplete { .. } => "TurnComplete",
            AgentEvent::TaskCreated { .. } => "TaskCreated",
            AgentEvent::TaskProgress { .. } => "TaskProgress",
            AgentEvent::TaskCompleted { .. } => "TaskCompleted",
            AgentEvent::BudgetWarning { .. } => "BudgetWarning",
            AgentEvent::TaskFeedback { .. } => "TaskFeedback",
            AgentEvent::OrchestrateNodeCreated { .. } => "OrchestrateNodeCreated",
            AgentEvent::OrchestrateNodeProgress { .. } => "OrchestrateNodeProgress",
            AgentEvent::OrchestrateNodeCompleted { .. } => "OrchestrateNodeCompleted",
            AgentEvent::OrchestrateNodeIdle { .. } => "OrchestrateNodeIdle",
            AgentEvent::OrchestrateFeedback { .. } => "OrchestrateFeedback",
        }
    }

    /// 为可路由事件附加 source_task_id，保留已有的 source_task_id（嵌套场景）
    pub fn with_source_task_id(self, task_id: &str) -> Self {
        match self {
            AgentEvent::TextDelta { session_id, delta, source_task_id: existing } => AgentEvent::TextDelta {
                session_id, delta, source_task_id: existing.or_else(|| Some(task_id.to_string())),
            },
            AgentEvent::ThinkingDelta { session_id, delta, source_task_id: existing } => AgentEvent::ThinkingDelta {
                session_id, delta, source_task_id: existing.or_else(|| Some(task_id.to_string())),
            },
            AgentEvent::ToolCallStart { session_id, tool_name, tool_use_id, input, source_task_id: existing } => AgentEvent::ToolCallStart {
                session_id, tool_name, tool_use_id, input, source_task_id: existing.or_else(|| Some(task_id.to_string())),
            },
            AgentEvent::ToolCallEnd { session_id, tool_use_id, is_error, output, source_task_id: existing } => AgentEvent::ToolCallEnd {
                session_id, tool_use_id, is_error, output, source_task_id: existing.or_else(|| Some(task_id.to_string())),
            },
            AgentEvent::MessageComplete { session_id, role, content, usage, source_task_id: existing } => AgentEvent::MessageComplete {
                session_id, role, content, usage, source_task_id: existing.or_else(|| Some(task_id.to_string())),
            },
            AgentEvent::TurnComplete { session_id, source_task_id: existing } => AgentEvent::TurnComplete {
                session_id, source_task_id: existing.or_else(|| Some(task_id.to_string())),
            },
            AgentEvent::Error { session_id, message, source_task_id: existing } => AgentEvent::Error {
                session_id, message, source_task_id: existing.or_else(|| Some(task_id.to_string())),
            },
            other => other,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_text_delta_serialization() {
        let event = AgentEvent::TextDelta {
            session_id: "s1".to_string(),
            delta: "Hello".to_string(),
            source_task_id: None,
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
            source_task_id: None,
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
            source_task_id: None,
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
            source_task_id: None,
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

    #[test]
    fn test_tool_call_start_serialization() {
        let event = AgentEvent::ToolCallStart {
            session_id: "s1".to_string(),
            tool_name: "search_web".to_string(),
            tool_use_id: "tool_123".to_string(),
            input: serde_json::json!({"query": "test"}),
            source_task_id: None,
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"ToolCallStart\""));
        assert!(json.contains("\"tool_name\":\"search_web\""));
        assert!(json.contains("\"tool_use_id\":\"tool_123\""));
        assert!(json.contains("\"input\""));

        let de: AgentEvent = serde_json::from_str(&json).unwrap();
        assert!(matches!(de, AgentEvent::ToolCallStart { .. }));
    }

    #[test]
    fn test_tool_call_end_serialization() {
        let event = AgentEvent::ToolCallEnd {
            session_id: "s1".to_string(),
            tool_use_id: "tool_123".to_string(),
            is_error: false,
            output: "result data".to_string(),
            source_task_id: None,
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"ToolCallEnd\""));
        assert!(json.contains("\"is_error\":false"));
        assert!(json.contains("\"output\":\"result data\""));

        let de: AgentEvent = serde_json::from_str(&json).unwrap();
        if let AgentEvent::ToolCallEnd {
            is_error, output, ..
        } = de
        {
            assert_eq!(is_error, false);
            assert_eq!(output, "result data");
        } else {
            panic!("Expected ToolCallEnd");
        }
    }

    #[test]
    fn test_turn_complete_serialization() {
        let event = AgentEvent::TurnComplete {
            session_id: "s1".to_string(),
            source_task_id: None,
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"TurnComplete\""));

        let de: AgentEvent = serde_json::from_str(&json).unwrap();
        assert!(matches!(de, AgentEvent::TurnComplete { .. }));
    }

    #[test]
    fn test_task_event_serialization() {
        let event = AgentEvent::TaskCreated {
            session_id: "s1".into(),
            task_id: "da_3x7k9m2".into(),
            description: "探索代码".into(),
            mode: "preset".into(),
            subagent_type: "Explore".into(),
            budget: TaskBudgetSummary { max_tokens: 50000 },
            tool_use_id: None,
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"TaskCreated\""));
        let de: AgentEvent = serde_json::from_str(&json).unwrap();
        assert!(matches!(de, AgentEvent::TaskCreated { .. }));
    }

    #[test]
    fn test_orchestrate_event_serialization() {
        let event = AgentEvent::OrchestrateNodeCreated {
            session_id: "s1".into(),
            node_id: "or_5q8w1n4".into(),
            parent_id: None,
            role: "executor".into(),
            depth: 1,
            description: "分析代码".into(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"OrchestrateNodeCreated\""));
        let de: AgentEvent = serde_json::from_str(&json).unwrap();
        if let AgentEvent::OrchestrateNodeCreated { depth, .. } = de {
            assert_eq!(depth, 1);
        } else {
            panic!("Expected OrchestrateNodeCreated");
        }
    }

    #[test]
    fn test_budget_warning_event() {
        let event = AgentEvent::BudgetWarning {
            session_id: "s1".into(),
            task_id: "da_abc123".into(),
            usage_percent: 90,
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"usage_percent\":90"));
    }

    #[test]
    fn test_text_delta_with_source_task_id() {
        let event = AgentEvent::TextDelta {
            session_id: "s1".into(),
            delta: "Hello".into(),
            source_task_id: Some("task_abc".into()),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"source_task_id\":\"task_abc\""));
        let de: AgentEvent = serde_json::from_str(&json).unwrap();
        if let AgentEvent::TextDelta { source_task_id, .. } = de {
            assert_eq!(source_task_id, Some("task_abc".into()));
        } else {
            panic!("Expected TextDelta");
        }
    }

    #[test]
    fn test_source_task_id_defaults_to_none() {
        let json = r#"{"type":"TextDelta","session_id":"s1","delta":"x"}"#;
        let event: AgentEvent = serde_json::from_str(json).unwrap();
        if let AgentEvent::TextDelta { source_task_id, .. } = event {
            assert_eq!(source_task_id, None);
        }
    }
}
