use crate::engine::task_tree::*;
use crate::engine::tools::{ToolExecutionContext};
use crate::engine::tools::orchestrate::OrchestrateTool;
use crate::types::event::*;

/// idle Agent 管理：标记 idle、复用激活、超时清理
#[allow(dead_code)]
impl OrchestrateTool {
    pub async fn mark_idle_and_notify(ctx: &ToolExecutionContext, node_id: &str) {
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

    pub async fn get_idle_agents(ctx: &ToolExecutionContext, _owner_id: &str) -> Vec<String> {
        let tree = ctx.task_tree.lock().await;
        tree.all_orchestrate_nodes().iter()
            .filter(|n| n.status == OrchestrateStatus::Idle)
            .map(|n| n.node_id.clone())
            .collect()
    }

    pub async fn cleanup_idle(ctx: &ToolExecutionContext, timeout_secs: u64) -> Vec<String> {
        let now = chrono::Utc::now();
        let mut tree = ctx.task_tree.lock().await;

        let stale_ids: Vec<String> = tree.all_orchestrate_nodes().iter()
            .filter(|n| n.status == OrchestrateStatus::Idle)
            .filter_map(|n| {
                let last_active = chrono::DateTime::parse_from_rfc3339(&n.last_active_at).ok()?;
                let last_active_utc = last_active.with_timezone(&chrono::Utc);
                let elapsed = (now - last_active_utc).num_seconds() as u64;
                if elapsed > timeout_secs { Some(n.node_id.clone()) } else { None }
            })
            .collect();

        for node_id in &stale_ids {
            if let Some(n) = tree.get_orchestrate_node_mut(node_id) {
                n.status = OrchestrateStatus::Completed;
            }
        }
        // 释放锁后再发送事件，避免死锁
        drop(tree);

        let mut cleaned = Vec::new();
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
    use crate::engine::concurrency::ConcurrencyManager;
    use crate::engine::agent_spawner::DefaultAgentSpawner;
    use crate::engine::llm::test_utils::MockLlmProvider;
    use crate::engine::config::AgentConfig;
    use crate::engine::agent_template::AgentTemplateRegistry;
    use std::sync::Arc;

    #[tokio::test]
    async fn test_get_idle_agents_and_cleanup() {
        let tree = Arc::new(tokio::sync::Mutex::new(TaskTree::new()));
        let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel();

        let spawner = Arc::new(DefaultAgentSpawner {
            provider: Arc::new(MockLlmProvider::new(vec![])),
            model: "test".into(),
            config: Arc::new(AgentConfig::default()),
            tool_registry: Arc::new(crate::engine::tools::ToolRegistry::new()),
            task_tree: tree.clone(),
            concurrency_manager: Arc::new(ConcurrencyManager::new(3)),
            data_dir: std::path::PathBuf::from("/tmp/test"),
        });

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
            agent_spawner: spawner,
            orchestrate_depth: 0,
            parent_cancel_token: None,
        };

        // 创建 idle 节点
        {
            let mut t = tree.lock().await;
            t.create_orchestrate_node(
                "or_test_idle1".into(), None, "test-session", NodeRole::Executor, 0,
                "test task", "do something", "agent-1",
                std::path::PathBuf::from("/tmp/test.jsonl"), None,
            );
            let nid = t.all_orchestrate_nodes()[0].node_id.clone();
            if let Some(n) = t.get_orchestrate_node_mut(&nid) {
                n.status = OrchestrateStatus::Idle;
                n.last_active_at = "2020-01-01T00:00:00Z".into();
            }
        }

        let idle = OrchestrateTool::get_idle_agents(&ctx, "test-session").await;
        assert_eq!(idle.len(), 1);

        let cleaned = OrchestrateTool::cleanup_idle(&ctx, 1).await;
        assert_eq!(cleaned.len(), 1);

        {
            let t = tree.lock().await;
            assert_eq!(t.all_orchestrate_nodes()[0].status, OrchestrateStatus::Completed);
        }

        let event = event_rx.recv().await;
        assert!(matches!(event, Some(AgentEvent::OrchestrateNodeCompleted { .. })));

        // reactivate running 节点应失败
        {
            let mut t = tree.lock().await;
            t.create_orchestrate_node(
                "or_test_running2".into(), None, "test-session", NodeRole::Executor, 0,
                "test task 2", "do something else", "agent-2",
                std::path::PathBuf::from("/tmp/test2.jsonl"), None,
            );
            let nid = t.all_orchestrate_nodes()[1].node_id.clone();
            if let Some(n) = t.get_orchestrate_node_mut(&nid) {
                n.status = OrchestrateStatus::Running;
            }
        }
        let rid = tree.lock().await.all_orchestrate_nodes()[1].node_id.clone();
        assert!(OrchestrateTool::reactivate_agent(
            &ctx, &rid, "new directive",
            TaskBudget { max_tokens: 1000, max_turns: 5, max_tool_calls: 10 },
        ).await.is_err());

        drop(event_rx);
    }
}
