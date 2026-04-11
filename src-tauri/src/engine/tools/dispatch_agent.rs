use async_trait::async_trait;
use std::time::Instant;

use crate::engine::task_tree::*;
use crate::engine::tools::{Tool, ToolExecutionContext, ToolResult};
use crate::types::event::*;

pub struct DispatchAgentTool;

#[async_trait]
impl Tool for DispatchAgentTool {
    fn name(&self) -> &str {
        "dispatch_agent"
    }

    fn description(&self) -> &str {
        "启动子 Agent 处理任务。sync=true 阻塞等待结果，sync=false 后台执行。"
    }

    fn is_concurrent_safe(&self) -> bool {
        false
    }

    fn timeout_secs(&self) -> u64 {
        600
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "description": {
                    "type": "string",
                    "description": "3-5 词任务摘要"
                },
                "prompt": {
                    "type": "string",
                    "description": "子 Agent 的任务指令"
                },
                "mode": {
                    "enum": ["preset", "fork"],
                    "default": "preset"
                },
                "subagent_type": {
                    "type": "string",
                    "description": "模板名（preset 必填）"
                },
                "sync": {
                    "type": "boolean",
                    "default": true
                },
                "token_budget": {
                    "type": "integer"
                },
                "max_turns": {
                    "type": "integer"
                }
            },
            "required": ["description", "prompt"]
        })
    }

    async fn call(&self, input: serde_json::Value, ctx: Option<&ToolExecutionContext>) -> ToolResult {
        let Some(ctx) = ctx else {
            return ToolResult::Error("dispatch_agent requires ToolExecutionContext".into());
        };

        let description = input["description"]
            .as_str()
            .unwrap_or("")
            .to_string();
        let _prompt = input["prompt"].as_str().unwrap_or("").to_string();
        let subagent_type = input["subagent_type"]
            .as_str()
            .unwrap_or("")
            .to_string();
        let _is_sync = input["sync"].as_bool().unwrap_or(true);

        // 查找模板（preset 模式必须指定）
        let _template = match ctx.agent_templates.get(&subagent_type) {
            Some(t) => Some(t),
            None if subagent_type.is_empty() => {
                // 未指定模板，尝试 fallback 到 general-purpose
                ctx.agent_templates.get("general-purpose")
            }
            None => {
                return ToolResult::Error(format!("template '{}' not found", subagent_type));
            }
        };

        // 构建预算
        let budget = TaskBudget {
            max_tokens: input["token_budget"].as_u64().unwrap_or(50_000) as u32,
            max_turns: input["max_turns"].as_u64().unwrap_or(20) as u32,
            max_tool_calls: 100,
        };

        // 生成 task_id 用于事件标识
        // 注意：不在此处调用 tree.create_task_node()，因为 ID 一致性问题
        // TaskTree 注册留到 P2-C AgentSpawner 处理
        let task_id = generate_task_id("dispatch_agent");
        let start = Instant::now();

        // 发送 TaskCreated 事件
        let _ = ctx.event_tx.send(AgentEvent::TaskCreated {
            session_id: ctx.session_id.clone(),
            task_id: task_id.clone(),
            description: description.clone(),
            mode: "preset".into(),
            subagent_type: subagent_type.clone(),
            budget: TaskBudgetSummary {
                max_tokens: budget.max_tokens,
            },
        });

        // P2-A: sync stub — 子 Agent 执行留到 P2-C AgentSpawner
        let result: Result<String, String> = Err(
            "dispatch_agent sync execution not yet implemented — pending AgentSpawner in P2-C".into(),
        );

        let elapsed = start.elapsed().as_millis() as u64;
        let status_str = match &result {
            Ok(_) => "completed",
            Err(_) => "failed",
        };

        // 发送 TaskCompleted 事件（即使失败也发送）
        let _ = ctx.event_tx.send(AgentEvent::TaskCompleted {
            session_id: ctx.session_id.clone(),
            task_id: task_id.clone(),
            status: status_str.into(),
            result_summary: result
                .as_deref()
                .unwrap_or("error")
                .chars()
                .take(2000)
                .collect(),
            usage: TaskUsageSummary {
                total_tokens: 0,
                tool_uses: 0,
                duration_ms: elapsed,
            },
        });

        match result {
            Ok(text) => ToolResult::Text(text),
            Err(e) => ToolResult::Error(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_validates_required_fields() {
        let tool = DispatchAgentTool;
        let schema = tool.input_schema();
        let required = schema.get("required").unwrap().as_array().unwrap();
        assert!(required.iter().any(|r| r.as_str() == Some("description")));
        assert!(required.iter().any(|r| r.as_str() == Some("prompt")));
    }

    #[test]
    fn is_not_concurrent_safe() {
        let tool = DispatchAgentTool;
        assert!(!tool.is_concurrent_safe());
    }

    #[test]
    fn timeout_is_600() {
        let tool = DispatchAgentTool;
        assert_eq!(tool.timeout_secs(), 600);
    }
}
