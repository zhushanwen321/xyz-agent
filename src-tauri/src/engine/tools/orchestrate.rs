use crate::engine::task_tree::*;
use crate::engine::tools::{Tool, ToolExecutionContext, ToolResult};
use crate::types::event::*;
use async_trait::async_trait;

const MAX_DEPTH: u32 = 5;

pub struct OrchestrateTool;

/// 深度超限时 orchestrator 自动降级为 executor
pub fn resolve_effective_type(requested: &str, depth: u32) -> &'static str {
    match requested {
        "orchestrator" if depth < MAX_DEPTH => "orchestrator",
        _ => "executor",
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

        // P2-D stub: 深度从 calling context 获取
        let current_depth = 0u32;
        let effective_type = resolve_effective_type(requested_type, current_depth);
        let node_depth = current_depth + 1;

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

        let node_id = generate_task_id("orchestrate");
        let agent_id = target_agent_id
            .unwrap_or_else(|| format!("agent_{}", &node_id[3..11]));

        // TaskTree 注册留到 AgentSpawner 集成
        let _ = budget;

        let _ = ctx.event_tx.send(AgentEvent::OrchestrateNodeCreated {
            session_id: ctx.session_id.clone(),
            node_id: node_id.clone(),
            parent_id: None,
            role: effective_type.to_string(),
            depth: node_depth,
            description: task_description.clone(),
        });

        // P2-D stub: 后续传给 AgentSpawner
        let _tool_filter = match effective_type {
            "orchestrator" => vec!["orchestrate", "feedback", "read", "bash"],
            _ => vec!["feedback", "read", "write", "bash"],
        };

        // P2-D stub
        let status_str = if is_sync { "sync stub" } else { "async stub" };
        let result_summary = format!(
            "orchestrate {} stub — pending AgentSpawner implementation (node_id: {}, agent_id: {})",
            status_str, node_id, agent_id
        );

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

#[allow(dead_code)]
impl OrchestrateTool {
    /// 标记节点为 idle 并发送事件
    pub async fn mark_idle_and_notify(
        ctx: &ToolExecutionContext,
        node_id: &str,
    ) {
        {
            let mut tree = ctx.task_tree.lock().await;
            if let Some(node) = tree.get_orchestrate_node_mut(node_id) {
                node.status = OrchestrateStatus::Idle;
                node.last_active_at = chrono::Utc::now().to_rfc3339();
            }
        }
        let _ = ctx.event_tx.send(AgentEvent::OrchestrateNodeIdle {
            session_id: ctx.session_id.clone(),
            node_id: node_id.to_string(),
        });
    }

    /// 复用激活：将 idle 的 Agent 重新激活
    pub async fn reactivate_agent(
        ctx: &ToolExecutionContext,
        node_id: &str,
        new_directive: &str,
        new_budget: TaskBudget,
    ) -> Result<(), String> {
        let mut tree = ctx.task_tree.lock().await;
        let node = tree.get_orchestrate_node_mut(node_id)
            .ok_or_else(|| format!("Agent {} not found", node_id))?;

        if node.status != OrchestrateStatus::Idle {
            return Err(format!("Agent {} is not idle (status: {:?})", node_id, node.status));
        }

        node.status = OrchestrateStatus::Running;
        node.directive = new_directive.to_string();
        node.budget = new_budget;
        node.reuse_count += 1;
        Ok(())
    }

    /// 获取当前所有 idle agents
    pub async fn get_idle_agents(
        ctx: &ToolExecutionContext,
        _owner_id: &str,
    ) -> Vec<String> {
        let tree = ctx.task_tree.lock().await;
        tree.all_orchestrate_nodes().iter()
            .filter(|n| n.status == OrchestrateStatus::Idle)
            .map(|n| n.node_id.clone())
            .collect()
    }

    /// 清理超时空闲 Agent
    pub async fn cleanup_idle(
        ctx: &ToolExecutionContext,
        timeout_secs: u64,
    ) -> Vec<String> {
        let now = chrono::Utc::now();
        let mut cleaned = Vec::new();

        let mut tree = ctx.task_tree.lock().await;
        // 先收集超时节点 ID，再逐个修改，避免借用冲突
        let stale_ids: Vec<String> = tree.all_orchestrate_nodes().iter()
            .filter(|n| n.status == OrchestrateStatus::Idle)
            .filter_map(|n| {
                let last_active = chrono::DateTime::parse_from_rfc3339(&n.last_active_at).ok()?;
                let last_active_utc = last_active.with_timezone(&chrono::Utc);
                let elapsed = (now - last_active_utc).num_seconds() as u64;
                if elapsed > timeout_secs {
                    Some(n.node_id.clone())
                } else {
                    None
                }
            })
            .collect();

        // 在锁内批量修改状态
        for node_id in &stale_ids {
            if let Some(n) = tree.get_orchestrate_node_mut(node_id) {
                n.status = OrchestrateStatus::Completed;
            }
        }
        // 释放锁后再发送事件，避免死锁（事件消费者可能需要获取 task_tree 锁）
        drop(tree);

        for node_id in stale_ids {
            cleaned.push(node_id.clone());
            let _ = ctx.event_tx.send(AgentEvent::OrchestrateNodeCompleted {
                session_id: ctx.session_id.clone(),
                node_id: node_id.clone(),
                status: "completed".into(),
                result_summary: "idle timeout — auto cleanup".into(),
                usage: TaskUsageSummary { total_tokens: 0, tool_uses: 0, duration_ms: 0 },
            });
        }

        cleaned
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

    #[tokio::test]
    async fn test_get_idle_agents_and_cleanup() {
        use crate::engine::task_tree::TaskTree;
        use crate::engine::concurrency::ConcurrencyManager;
        use crate::engine::agent_template::AgentTemplateRegistry;
        use std::sync::Arc;

        let tree = Arc::new(tokio::sync::Mutex::new(TaskTree::new()));
        let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel();

        let ctx = ToolExecutionContext {
            task_tree: tree.clone(),
            concurrency_manager: Arc::new(ConcurrencyManager::new(3)),
            agent_templates: Arc::new(AgentTemplateRegistry::new()),
            data_dir: std::path::PathBuf::from("/tmp/test"),
            session_id: "test-session".into(),
            event_tx: event_tx.clone(),
            api_messages: vec![],
            current_assistant_content: vec![],
            tool_registry: Arc::new(crate::engine::tools::ToolRegistry::new()),
            background_tasks: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
        };

        // Create a node and set it to idle with a timestamp far in the past
        {
            let mut t = tree.lock().await;
            t.create_orchestrate_node(
                None, "test-session", NodeRole::Executor, 0,
                "test task", "do something", "agent-1",
                std::path::PathBuf::from("/tmp/test.jsonl"), None,
            );
            let node_id = t.all_orchestrate_nodes()[0].node_id.clone();
            if let Some(n) = t.get_orchestrate_node_mut(&node_id) {
                n.status = OrchestrateStatus::Idle;
                n.last_active_at = "2020-01-01T00:00:00Z".to_string();
            }
        }

        // Verify idle agents before cleanup
        let idle = OrchestrateTool::get_idle_agents(&ctx, "test-session").await;
        assert_eq!(idle.len(), 1);

        // Cleanup with 1-second timeout — should clean up the old idle node
        let cleaned = OrchestrateTool::cleanup_idle(&ctx, 1).await;
        assert_eq!(cleaned.len(), 1);

        // Verify node is now Completed, not Idle
        {
            let t = tree.lock().await;
            let node = t.all_orchestrate_nodes()[0];
            assert_eq!(node.status, OrchestrateStatus::Completed);
        }

        // Verify the completion event was sent
        let event = event_rx.recv().await;
        assert!(matches!(event, Some(AgentEvent::OrchestrateNodeCompleted { .. })));

        // Test reactivate on a running node should fail
        {
            let mut t = tree.lock().await;
            t.create_orchestrate_node(
                None, "test-session", NodeRole::Executor, 0,
                "test task 2", "do something else", "agent-2",
                std::path::PathBuf::from("/tmp/test2.jsonl"), None,
            );
            let node_id = t.all_orchestrate_nodes()[1].node_id.clone();
            if let Some(n) = t.get_orchestrate_node_mut(&node_id) {
                n.status = OrchestrateStatus::Running;
            }
        }
        let running_id = tree.lock().await.all_orchestrate_nodes()[1].node_id.clone();
        let result = OrchestrateTool::reactivate_agent(
            &ctx, &running_id, "new directive",
            TaskBudget { max_tokens: 1000, max_turns: 5, max_tool_calls: 10 },
        ).await;
        assert!(result.is_err());

        drop(event_rx);
    }
}
