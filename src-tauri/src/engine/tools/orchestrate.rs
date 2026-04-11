use crate::engine::agent_spawner::SpawnConfig;
use crate::engine::context::prompt::DynamicContext;
use crate::engine::task_tree::*;
use crate::engine::tools::{PermissionContext, Tool, ToolExecutionContext, ToolResult};
use crate::types::event::*;
use crate::types::transcript::{AssistantContentBlock, TranscriptEntry};
use async_trait::async_trait;
use std::time::Instant;

const MAX_DEPTH: u32 = 5;

pub struct OrchestrateTool;

/// 深度超限时 orchestrator 自动降级为 executor
pub fn resolve_effective_type(requested: &str, depth: u32) -> &'static str {
    match requested {
        "orchestrator" if depth < MAX_DEPTH => "orchestrator",
        _ => "executor",
    }
}

fn send_completed_event(
    ctx: &ToolExecutionContext,
    node_id: &str,
    status: &str,
    summary: &str,
    tokens: u32,
    tool_uses: u32,
    duration_ms: u64,
) {
    let _ = ctx.event_tx.send(AgentEvent::OrchestrateNodeCompleted {
        session_id: ctx.session_id.clone(),
        node_id: node_id.to_string(),
        status: status.to_string(),
        result_summary: summary.to_string(),
        usage: TaskUsageSummary {
            total_tokens: tokens,
            tool_uses,
            duration_ms,
        },
    });
}

fn extract_text(entries: &[TranscriptEntry]) -> String {
    entries.iter()
        .filter_map(|e| match e {
            TranscriptEntry::Assistant { content, .. } => Some(
                content.iter()
                    .filter_map(|b| match b {
                        AssistantContentBlock::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            ),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[async_trait]
impl Tool for OrchestrateTool {
    fn name(&self) -> &str {
        "orchestrate"
    }

    fn description(&self) -> &str {
        "Create an orchestration node for multi-agent coordination.\n\
         \n\
         - agent_type='orchestrator': Can recursively call this tool to delegate sub-tasks.\n\
         - agent_type='executor': Leaf node that performs the actual work.\n\
         \n\
         Use orchestrators to break complex tasks into sub-tasks,\n\
         and executors to carry out individual sub-tasks.\n\
         Orchestration depth is limited to 5 levels."
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
                "task_description": {
                    "type": "string",
                    "description": "What this node should accomplish, e.g. 'Analyze error logs for root cause'"
                },
                "agent_type": {
                    "enum": ["orchestrator", "executor"],
                    "description": "'orchestrator' can delegate sub-tasks via this tool; 'executor' performs the work directly."
                },
                "target_agent_id": {
                    "type": "string",
                    "description": "Reuse an existing idle agent by its ID. Omit to create a new agent."
                },
                "directive": {
                    "type": "string",
                    "description": "Specific instructions for the agent, e.g. 'Search for ERROR lines in logs/*.log and summarize patterns'"
                },
                "sync": {
                    "type": "boolean",
                    "default": true,
                    "description": "If true, wait for completion. If false, run in background."
                },
                "token_budget": {
                    "type": "integer",
                    "description": "Maximum tokens. Default: 80000 (orchestrator) or 50000 (executor)"
                },
                "max_turns": {
                    "type": "integer",
                    "description": "Maximum tool-use turns. Default: 15 (orchestrator) or 20 (executor)"
                }
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

        let task_description = match input["task_description"].as_str() {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => {
                return ToolResult::Error(
                    "Missing required parameter 'task_description'. \
                     Example: {\"task_description\": \"Analyze error logs\", \
                     \"agent_type\": \"executor\", \"directive\": \"Search for ERROR in logs/*.log\"}"
                        .into(),
                );
            }
        };
        let requested_type = input["agent_type"].as_str().unwrap_or("executor");
        let directive = match input["directive"].as_str() {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => {
                return ToolResult::Error(
                    "Missing required parameter 'directive'. \
                     Provide specific instructions for the agent, e.g. \
                     \"Search for ERROR lines in logs/*.log and summarize patterns\""
                        .into(),
                );
            }
        };
        let target_agent_id = input["target_agent_id"].as_str().map(String::from);
        let is_sync = input["sync"].as_bool().unwrap_or(true);

        let current_depth = ctx.orchestrate_depth;
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

        // TaskTree 注册
        let sidechain = crate::store::jsonl::orchestrate_path(
            &ctx.data_dir, &ctx.session_id, &node_id,
        );
        {
            let mut tree = ctx.task_tree.lock().await;
            tree.create_orchestrate_node(
                None,
                &ctx.session_id,
                if effective_type == "orchestrator" { NodeRole::Orchestrator } else { NodeRole::Executor },
                node_depth,
                &task_description,
                &directive,
                &agent_id,
                sidechain,
                Some(budget.clone()),
            );
        }

        let _ = ctx.event_tx.send(AgentEvent::OrchestrateNodeCreated {
            session_id: ctx.session_id.clone(),
            node_id: node_id.clone(),
            parent_id: None,
            role: effective_type.to_string(),
            depth: node_depth,
            description: task_description.clone(),
        });

        let tool_filter: Vec<String> = match effective_type {
            "orchestrator" => vec!["orchestrate", "feedback", "read", "bash"],
            _ => vec!["feedback", "read", "write", "bash"],
        }.into_iter().map(String::from).collect();

        let start = Instant::now();

        let spawn_config = SpawnConfig {
            prompt: directive.clone(),
            history: vec![],
            system_prompt_override: None,
            tool_filter: Some(tool_filter),
            budget: Some(budget),
            event_tx: ctx.event_tx.clone(),
            sync: is_sync,
            fork_api_messages: None,
            fork_assistant_content: None,
            dynamic_context: DynamicContext {
                cwd: std::env::current_dir().unwrap_or_default().to_string_lossy().to_string(),
                os: std::env::consts::OS.to_string(),
                model: String::new(),
                git_branch: None,
                tool_names: ctx.tool_registry.tool_names(),
                data_context_summary: None,
                conversation_summary: None,
            },
            permission_context: PermissionContext::default(),
            session_id: ctx.session_id.clone(),
            task_id: node_id.clone(),
            node_id: Some(node_id.clone()),
        };

        let mut spawn_handle = match ctx.agent_spawner.spawn_agent(spawn_config).await {
            Ok(h) => h,
            Err(e) => {
                let ms = start.elapsed().as_millis() as u64;
                send_completed_event(ctx, &node_id, "failed", &e.to_string(), 0, 0, ms);
                return ToolResult::Error(e.to_string());
            }
        };

        if is_sync {
            let join = spawn_handle.join_handle.take().unwrap();
            let result = match join.await {
                Ok(Ok(r)) => r,
                Ok(Err(e)) => {
                    let ms = start.elapsed().as_millis() as u64;
                    send_completed_event(ctx, &node_id, "failed", &e.to_string(), 0, 0, ms);
                    return ToolResult::Error(e.to_string());
                }
                Err(e) => {
                    let ms = start.elapsed().as_millis() as u64;
                    send_completed_event(ctx, &node_id, "failed", &format!("task panicked: {e}"), 0, 0, ms);
                    return ToolResult::Error(format!("task panicked: {e}"));
                }
            };

            let result_text = extract_text(&result.entries);
            let elapsed = start.elapsed().as_millis() as u64;
            let summary: String = result_text.chars().take(2000).collect();
            send_completed_event(
                ctx, &node_id, "completed",
                &summary,
                result.usage.total_tokens, result.usage.tool_uses,
                elapsed,
            );

            let mut tree = ctx.task_tree.lock().await;
            tree.set_task_result(&node_id, result_text.chars().take(100_000).collect());

            ToolResult::Text(result_text)
        } else {
            let join = spawn_handle.join_handle.take().unwrap();
            let bg_tasks = ctx.background_tasks.clone();
            let handle = tokio::spawn(async move { let _ = join.await; });

            let mut tasks = bg_tasks.lock().await;
            tasks.retain(|_, h| !h.is_finished());
            tasks.insert(node_id.clone(), handle);

            ToolResult::Text(format!(
                "<task_notification><task_id>{}</task_id><status>pending</status><message>Orchestration node started in background</message></task_notification>",
                node_id
            ))
        }
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
        use crate::engine::agent_spawner::DefaultAgentSpawner;
        use crate::engine::llm::test_utils::MockLlmProvider;
        use crate::engine::config::AgentConfig;
        use std::sync::Arc;

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
