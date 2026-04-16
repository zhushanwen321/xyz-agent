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
        "Orchestrate"
    }

    fn description(&self) -> &str {
        "Launch a sub-agent to execute a task, with optional recursive decomposition into sub-tasks.\n\
         \n\
         agent_type determines behavior and available tools:\n\
         - 'orchestrator': breaks the task into sub-tasks by calling Orchestrate recursively.\n\
           Available tools: Orchestrate, Communication, Read, Bash (no Write — orchestrators plan, not execute).\n\
         - 'executor': performs the task directly using Read, Write, Bash.\n\
           Available tools: Communication, Read, Write, Bash.\n\
         - Depth is limited to 5 levels. Beyond that, orchestrator auto-downgrades to executor.\n\
         - sync=true (default): block until completion. sync=false: run in background.\n\
         \n\
         When to use Orchestrate vs Subagent:\n\
         - Orchestrate: tasks that need recursive decomposition (task → sub-tasks → sub-sub-tasks).\n\
         - Subagent: simple, independent tasks that don't need decomposition.\n\
         \n\
         When NOT to use:\n\
         - If the task can be done with a single Bash/Read/Write call, do it directly.\n\
         - If the task is a simple lookup (read a file, search a pattern), use Read or Bash.\n\
         - If the task is independent and doesn't need decomposition, use Subagent.\n\
         \n\
         Writing the directive:\n\
         - For orchestrator: describe the decomposition strategy. Break into 2-5 sub-tasks,\n\
           each independently executable. Each sub-task's directive must be self-contained.\n\
         - For executor: include file paths, function names, what you've already learned,\n\
           and expected output format. The executor hasn't seen this conversation.\n\
         - Terse directives produce shallow results. Be specific about scope and expectations.\n\
         \n\
         <example>\n\
         user: \"Refactor the authentication module\"\n\
         assistant: Orchestrate({\"task_description\": \"Refactor auth module\", \"agent_type\": \"orchestrator\", \"directive\": \"Break the auth module refactor into sub-tasks: 1) Extract token validation into a separate service, 2) Consolidate auth middleware, 3) Update integration tests. Execute each sub-task using Orchestrate with agent_type='executor'.\"})\n\
         </example>\n\
         \n\
         <example>\n\
         user: \"Fix the failing tests in the login module\"\n\
         assistant: Orchestrate({\"task_description\": \"Fix login tests\", \"agent_type\": \"executor\", \"directive\": \"Run cargo test and identify all failing tests in the login module. For each failure: read the test and source file, identify root cause, apply fix. Report which tests were fixed and any remaining failures.\"})\n\
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
                "Orchestrate requires ToolExecutionContext".into(),
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

        let node_id = generate_task_id("Orchestrate");
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
                ctx.node_id.clone(),
                &ctx.session_id,
                if effective_type == "orchestrator" { NodeRole::Orchestrator } else { NodeRole::Executor },
                node_depth,
                &task_description,
                &directive,
                &agent_id,
                sidechain,
                Some(budget.clone()),
            );
            // 用 parent token 派生 child token，实现级联取消
            // 安全性：set_cancel_token 在 spawn_agent（run_subagent → get_cancel_token）之前执行，
            // 因为 spawn_agent 的 tokio::spawn 会在当前 .await 点之后才被调度
            let child_token = ctx.parent_cancel_token
                .as_ref()
                .map(|p| p.child_token())
                .unwrap_or_else(tokio_util::sync::CancellationToken::new);
            tree.set_cancel_token(node_id.clone(), child_token);
            // 持久化初始状态到 session transcript
            if let Some(onode) = tree.get_orchestrate_node(&node_id) {
                let _ = crate::store::jsonl::persist_orchestrate_node(&ctx.data_dir, &ctx.session_id, onode);
            }
        }

        let _ = ctx.event_tx.send(AgentEvent::OrchestrateNodeCreated {
            session_id: ctx.session_id.clone(),
            node_id: node_id.clone(),
            parent_id: ctx.node_id.clone(),
            role: effective_type.to_string(),
            depth: node_depth,
            description: task_description.clone(),
        });

        let tool_filter: Vec<String> = match effective_type {
            "orchestrator" => vec!["Orchestrate", "Communication", "Read", "Bash"],
            _ => vec!["Communication", "Read", "Write", "Bash"],
        }.into_iter().map(String::from).collect();

        let start = Instant::now();

        // 子节点事件通过父 channel 转发，携带 source_task_id 标识
        let parent_tx = ctx.event_tx.clone();
        let node_id_for_forward = node_id.clone();
        let (sub_event_tx, mut sub_event_rx) = tokio::sync::mpsc::unbounded_channel::<AgentEvent>();
        tokio::spawn(async move {
            while let Some(event) = sub_event_rx.recv().await {
                let _ = parent_tx.send(event.with_source_task_id(&node_id_for_forward));
            }
        });

        let spawn_config = SpawnConfig {
            prompt: directive.clone(),
            history: vec![],
            system_prompt_override: None,
            prompt_key: None,
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
                disabled_tools: vec![],
            },
            permission_context: PermissionContext::default(),
            session_id: ctx.session_id.clone(),
            task_id: node_id.clone(),
            node_id: Some(node_id.clone()),
            orchestrate_depth: node_depth,
            parent_cancel_token: ctx.parent_cancel_token.clone(),
            model_ref: None,
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

            // 将子 Agent transcript 写入 sidechain JSONL，供前端 Tab 加载历史
            {
                let sc_path = crate::store::jsonl::orchestrate_path(
                    &ctx.data_dir, &ctx.session_id, &node_id,
                );
                for entry in &result.entries {
                    if let Err(e) = crate::store::jsonl::append_sidechain_entry(&sc_path, entry) {
                        log::warn!("[sidechain] failed to append entry: {e}");
                    }
                }
            }

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
            // 持久化最终状态到 session transcript
            if let Some(onode) = tree.get_orchestrate_node(&node_id) {
                let _ = crate::store::jsonl::persist_orchestrate_node(&ctx.data_dir, &ctx.session_id, onode);
            }

            ToolResult::Text(result_text)
        } else {
            let join = spawn_handle.join_handle.take().unwrap();

            let session_id_bg = ctx.session_id.clone();
            let node_id_bg = node_id.clone();
            let event_tx_bg = ctx.event_tx.clone();
            let task_tree_bg = ctx.task_tree.clone();
            let data_dir_bg = ctx.data_dir.clone();
            let bg_tasks = ctx.background_tasks.clone();

            let handle = tokio::spawn(async move {
                let result = join.await;
                if let Ok(Ok(r)) = &result {
                    // 写入 sidechain JSONL
                    {
                        let sc_path = crate::store::jsonl::orchestrate_path(
                            &data_dir_bg, &session_id_bg, &node_id_bg,
                        );
                        for entry in &r.entries {
                            if let Err(e) = crate::store::jsonl::append_sidechain_entry(&sc_path, entry) {
                                log::warn!("[sidechain] failed to append entry: {e}");
                            }
                        }
                    }
                    let text = extract_text(&r.entries);
                    let summary: String = text.chars().take(2000).collect();
                    let _ = event_tx_bg.send(AgentEvent::OrchestrateNodeCompleted {
                        session_id: session_id_bg.clone(),
                        node_id: node_id_bg.clone(),
                        status: "completed".into(),
                        result_summary: summary,
                        usage: TaskUsageSummary {
                            total_tokens: r.usage.total_tokens,
                            tool_uses: r.usage.tool_uses,
                            duration_ms: 0,
                        },
                    });
                    let mut tree = task_tree_bg.lock().await;
                    tree.set_task_result(&node_id_bg, text.chars().take(100_000).collect());
                    // 持久化最终状态到 session transcript
                    if let Some(onode) = tree.get_orchestrate_node(&node_id_bg) {
                        let _ = crate::store::jsonl::persist_orchestrate_node(&data_dir_bg, &session_id_bg, onode);
                    }
                }
            });

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
