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
        "Launch a sub-agent to execute a task, with optional recursive decomposition into sub-tasks.\n\
         \n\
         Usage:\n\
         - agent_type='executor': performs the task directly using Bash/Read/Write. Use for well-defined, self-contained work.\n\
         - agent_type='orchestrator': can recursively call orchestrate to break tasks into smaller sub-tasks. Use for complex, multi-step work.\n\
         - Orchestration depth is limited to 5 levels. Beyond that, orchestrator auto-downgrades to executor.\n\
         - sync=true (default): block until completion. sync=false: run in background.\n\
         \n\
         When to use orchestrate vs dispatch_agent:\n\
         - orchestrate: tasks that may need recursive decomposition (task → sub-tasks → sub-sub-tasks).\n\
         - dispatch_agent: simple, independent tasks that don't need decomposition.\n\
         \n\
         When NOT to use:\n\
         - If the task can be done with a single Bash/Read/Write call, do it directly.\n\
         - If the task is a simple lookup (read a file, search a pattern), use Read or Bash.\n\
         - If the task is independent and doesn't need decomposition, use dispatch_agent.\n\
         \n\
         <example>\n\
         user: \"Refactor the authentication module\"\n\
         assistant: orchestrate({\"task_description\": \"Refactor auth module\", \"agent_type\": \"orchestrator\", \"directive\": \"Break the auth module refactor into sub-tasks: 1) Extract token validation into a separate service, 2) Consolidate auth middleware, 3) Update integration tests. Execute each sub-task using orchestrate with agent_type='executor'.\"})\n\
         </example>"
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
                    "description": "Short summary of the task for display/logging, 3-10 words. e.g. 'Analyze error logs', 'Refactor auth module', 'Update integration tests'"
                },
                "agent_type": {
                    "enum": ["orchestrator", "executor"],
                    "description": "'executor': performs work directly with Bash/Read/Write. Use for self-contained tasks. 'orchestrator': breaks the task into sub-tasks by calling orchestrate recursively. Use for complex, multi-step tasks that need decomposition."
                },
                "directive": {
                    "type": "string",
                    "description": "Full instructions for the sub-agent. Be specific: what to do, where, and expected output format. e.g. 'Search for ERROR lines in logs/*.log, count by type, and list the top 3 patterns with file names and line numbers'"
                },
                "sync": {
                    "type": "boolean",
                    "default": true,
                    "description": "true (default): wait for result. false: run in background and return task_id immediately."
                },
                "target_agent_id": {
                    "type": "string",
                    "description": "Reuse an existing idle agent by its node_id. Only use when you have previously received an idle agent notification for this ID. Omit to create a new agent."
                },
                "token_budget": {
                    "type": "integer",
                    "description": "Max tokens the sub-agent may consume. The agent stops when this limit is reached. Default: 80000 (orchestrator), 50000 (executor)."
                },
                "max_turns": {
                    "type": "integer",
                    "description": "Max tool-use turns for the sub-agent. Each tool call counts as one turn. Default: 15 (orchestrator), 20 (executor)."
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
                node_id.clone(),
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

        // 子 Agent 使用独立 event channel，避免 TextDelta/ToolCallStart 等事件泄漏到父 Agent 消息流
        let (sub_event_tx, _sub_event_rx) = tokio::sync::mpsc::unbounded_channel();

        let spawn_config = SpawnConfig {
            prompt: directive.clone(),
            history: vec![],
            system_prompt_override: None,
            tool_filter: Some(tool_filter),
            budget: Some(budget),
            event_tx: sub_event_tx,
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
            orchestrate_depth: node_depth,
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
