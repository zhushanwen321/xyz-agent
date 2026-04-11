use crate::engine::task_tree::*;
use crate::engine::tools::{Tool, ToolExecutionContext, ToolResult};
use crate::types::event::*;
use async_trait::async_trait;

const MAX_DEPTH: u32 = 5;

pub struct OrchestrateTool;

/// 根据请求类型和深度确定实际角色（深度超限自动降级为 executor）
pub fn resolve_effective_type(requested: &str, depth: u32) -> &'static str {
    if requested == "orchestrator" && depth >= MAX_DEPTH {
        "executor"
    } else if requested == "orchestrator" {
        "orchestrator"
    } else {
        "executor"
    }
}

#[async_trait]
impl Tool for OrchestrateTool {
    fn name(&self) -> &str {
        "orchestrate"
    }

    fn description(&self) -> &str {
        "创建编排节点。Orchestrator 可递归调用本工具，Executor 为叶节点执行者。"
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
                "task_description": { "type": "string", "description": "任务描述" },
                "agent_type": {
                    "enum": ["orchestrator", "executor"],
                    "description": "节点角色"
                },
                "target_agent_id": { "type": "string", "description": "复用的 Agent ID（可选）" },
                "directive": { "type": "string", "description": "执行指令" },
                "sync": { "type": "boolean", "default": true },
                "token_budget": { "type": "integer" },
                "max_turns": { "type": "integer" }
            },
            "required": ["task_description", "agent_type", "directive"]
        })
    }

    async fn call(
        &self,
        input: serde_json::Value,
        ctx: Option<&ToolExecutionContext>,
    ) -> ToolResult {
        let Some(ctx) = ctx else {
            return ToolResult::Error(
                "orchestrate requires ToolExecutionContext".into(),
            );
        };

        let task_description = input["task_description"]
            .as_str()
            .unwrap_or("")
            .to_string();
        let requested_type = input["agent_type"].as_str().unwrap_or("executor");
        let _directive = input["directive"].as_str().unwrap_or("").to_string();
        let target_agent_id = input["target_agent_id"].as_str().map(String::from);
        let is_sync = input["sync"].as_bool().unwrap_or(true);

        // 深度计算（P2-D stub：当前从 0 开始，后续从 calling context 获取）
        let current_depth = 0u32;
        let effective_type = resolve_effective_type(requested_type, current_depth);
        let node_depth = current_depth + 1;

        // 基于角色的默认预算
        let default_budget = match effective_type {
            "orchestrator" => TaskBudget {
                max_tokens: 80_000,
                max_turns: 15,
                max_tool_calls: 50,
            },
            _ => TaskBudget {
                max_tokens: 50_000,
                max_turns: 20,
                max_tool_calls: 100,
            },
        };
        let budget = TaskBudget {
            max_tokens: input["token_budget"]
                .as_u64()
                .unwrap_or(default_budget.max_tokens as u64) as u32,
            max_turns: input["max_turns"]
                .as_u64()
                .unwrap_or(default_budget.max_turns as u64) as u32,
            max_tool_calls: default_budget.max_tool_calls,
        };

        // 复用检查：如果指定了 target_agent_id，验证状态
        if let Some(ref agent_id) = target_agent_id {
            let tree = ctx.task_tree.lock().await;
            if let Some(node) = tree.get_orchestrate_node(agent_id) {
                if node.status != OrchestrateStatus::Idle {
                    return ToolResult::Error(format!(
                        "Agent {} is not idle (status: {:?})",
                        agent_id, node.status
                    ));
                }
            } else {
                return ToolResult::Error(format!("Agent {} not found", agent_id));
            }
        }

        // 生成 node_id
        let node_id = generate_task_id("orchestrate");
        let agent_id = target_agent_id
            .unwrap_or_else(|| format!("agent_{}", &node_id[3..11]));

        // TaskTree 注册留到 AgentSpawner 集成（避免 ID 不一致）
        let _ = budget; // 后续传给 AgentSpawner

        // 发送 OrchestrateNodeCreated 事件
        let _ = ctx.event_tx.send(AgentEvent::OrchestrateNodeCreated {
            session_id: ctx.session_id.clone(),
            node_id: node_id.clone(),
            parent_id: None,
            role: effective_type.to_string(),
            depth: node_depth,
            description: task_description.clone(),
        });

        // 基于角色的工具过滤（P2-D stub：后续传给 AgentSpawner）
        let _tool_filter = match effective_type {
            "orchestrator" => vec!["orchestrate", "feedback", "read", "bash"],
            _ => vec!["feedback", "read", "write", "bash"],
        };

        // P2-D stub：实际执行留到 AgentSpawner 集成
        let status_str = if is_sync { "sync stub" } else { "async stub" };
        let result_summary = format!(
            "orchestrate {} stub — pending AgentSpawner implementation (node_id: {}, agent_id: {})",
            status_str, node_id, agent_id
        );

        // 发送 OrchestrateNodeCompleted 事件
        let _ = ctx.event_tx.send(AgentEvent::OrchestrateNodeCompleted {
            session_id: ctx.session_id.clone(),
            node_id: node_id.clone(),
            status: "completed".into(),
            result_summary: result_summary.clone(),
            usage: TaskUsageSummary {
                total_tokens: 0,
                tool_uses: 0,
                duration_ms: 0,
            },
        });

        ToolResult::Text(result_summary)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_requires_task_and_type() {
        let tool = OrchestrateTool;
        let schema = tool.input_schema();
        let required = schema.get("required").unwrap().as_array().unwrap();
        assert!(required.iter().any(|r| r.as_str() == Some("task_description")));
        assert!(required.iter().any(|r| r.as_str() == Some("agent_type")));
        assert!(required.iter().any(|r| r.as_str() == Some("directive")));
    }

    #[test]
    fn is_not_concurrent_safe() {
        let tool = OrchestrateTool;
        assert!(!tool.is_concurrent_safe());
    }

    #[test]
    fn depth_auto_downgrade() {
        assert_eq!(resolve_effective_type("orchestrator", 5), "executor");
        assert_eq!(resolve_effective_type("orchestrator", 4), "orchestrator");
        assert_eq!(resolve_effective_type("executor", 5), "executor");
    }

    #[tokio::test]
    async fn requires_context() {
        let tool = OrchestrateTool;
        let result = tool.call(serde_json::json!({}), None).await;
        assert!(matches!(result, ToolResult::Error(ref e) if e.contains("requires ToolExecutionContext")));
    }
}
