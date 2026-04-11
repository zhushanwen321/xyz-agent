use async_trait::async_trait;

use crate::engine::tools::{Tool, ToolExecutionContext, ToolResult};

/// SubAgent 向父 Agent 发送中间报告的工具。
/// severity=error 时通过 TaskTree 触发非阻塞暂停。
pub struct FeedbackTool;

#[async_trait]
impl Tool for FeedbackTool {
    fn name(&self) -> &str {
        "feedback"
    }

    fn description(&self) -> &str {
        "向父 Agent 发送中间报告"
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "message": {
                    "type": "string",
                    "description": "反馈消息内容"
                },
                "severity": {
                    "enum": ["info", "warning", "error"],
                    "default": "info",
                    "description": "严重程度"
                },
                "task_id": {
                    "type": "string",
                    "description": "关联的任务 ID（severity=error 时用于触发暂停）"
                }
            },
            "required": ["message"]
        })
    }

    async fn call(&self, input: serde_json::Value, ctx: Option<&ToolExecutionContext>) -> ToolResult {
        let message = input["message"]
            .as_str()
            .unwrap_or("")
            .to_string();
        let severity = input["severity"]
            .as_str()
            .unwrap_or("info")
            .to_string();
        let task_id = input["task_id"]
            .as_str()
            .unwrap_or("")
            .to_string();

        if let Some(ctx) = ctx {
            let _ = ctx.event_tx.send(crate::types::AgentEvent::TaskFeedback {
                session_id: ctx.session_id.clone(),
                task_id: task_id.clone(),
                message,
                severity: severity.clone(),
            });

            // severity=error 触发非阻塞暂停
            if severity == "error" && !task_id.is_empty() {
                let mut tree = ctx.task_tree.lock().await;
                if tree.get_task_node(&task_id).is_some() {
                    tree.request_pause(&task_id);
                } else if tree.get_orchestrate_node(&task_id).is_some() {
                    if let Some(node) = tree.get_orchestrate_node_mut(&task_id) {
                        node.pause_requested = true;
                    }
                }
            }
        }

        ToolResult::Text("Feedback sent.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_has_required_fields() {
        let tool = FeedbackTool;
        let schema = tool.input_schema();
        let required = schema.get("required").unwrap().as_array().unwrap();
        assert!(required.iter().any(|r| r.as_str() == Some("message")));
    }

    #[test]
    fn is_concurrent_safe() {
        let tool = FeedbackTool;
        assert!(tool.is_concurrent_safe());
    }
}
