use async_trait::async_trait;
use std::time::Instant;

use crate::engine::agent_spawner::SpawnConfig;
use crate::engine::context::prompt::DynamicContext;
use crate::engine::task_tree::*;
use crate::engine::tools::{PermissionContext, Tool, ToolExecutionContext, ToolResult};
use crate::types::event::*;
use crate::types::transcript::{AssistantContentBlock, TranscriptEntry, UserContentBlock};

/// 构建 Fork 模式的 API messages（byte-identical system prompt + unified placeholder tool_result）
#[allow(dead_code)]
pub fn build_fork_messages(
    api_messages: &[serde_json::Value],
    current_assistant_content: &[AssistantContentBlock],
    prompt: &str,
) -> Vec<serde_json::Value> {
    let mut fork_messages = api_messages.to_vec();

    let mut result_blocks: Vec<serde_json::Value> = current_assistant_content
        .iter()
        .filter_map(|block| {
            if let AssistantContentBlock::ToolUse { id, .. } = block {
                Some(serde_json::json!({
                    "type": "tool_result",
                    "tool_use_id": id,
                    "content": "Fork started — processing in background"
                }))
            } else {
                None
            }
        })
        .collect();

    result_blocks.push(serde_json::json!({
        "type": "text",
        "text": format!("<fork-context>\n{}\n</fork-context>", prompt)
    }));

    fork_messages.push(serde_json::json!({
        "role": "user",
        "content": result_blocks
    }));

    fork_messages
}

/// 检查是否已在 Fork 子 Agent 中（防递归）
#[allow(dead_code)]
pub fn is_in_fork_child(history: &[TranscriptEntry]) -> bool {
    history.iter().any(|entry| {
        let TranscriptEntry::User { content, .. } = entry else {
            return false;
        };
        content.iter().any(|block| {
            let UserContentBlock::Text { text } = block else {
                return false;
            };
            text.contains("<fork-context>")
        })
    })
}

pub struct DispatchAgentTool;

#[async_trait]
impl Tool for DispatchAgentTool {
    fn name(&self) -> &str {
        "dispatch_agent"
    }

    fn description(&self) -> &str {
        "Launch a sub-agent to execute an independent task in isolation.\n\
         \n\
         The sub-agent runs with its own context and has access to Bash, Read, Write tools.\n\
         Results are returned as text (sync) or tracked via task_id (async).\n\
         \n\
         Usage:\n\
         - sync=true (default): block until the sub-agent finishes, return its output.\n\
         - sync=false: launch in background, continue immediately. Returns a task_id for tracking.\n\
         - Multiple dispatch_agent calls can be made in parallel for independent tasks.\n\
         \n\
         Mode:\n\
         - 'preset' (default): fresh agent with no conversation history.\n\
         - 'fork': clones current conversation context into the sub-agent.\n\
         \n\
         When to use dispatch_agent vs orchestrate:\n\
         - dispatch_agent: simple, independent tasks that do NOT need decomposition into sub-tasks.\n\
         - orchestrate: complex tasks that may need recursive decomposition (task → sub-tasks → sub-sub-tasks).\n\
         \n\
         When NOT to use:\n\
         - If the task can be done with a single Bash/Read/Write call, do it directly.\n\
         - If the task needs recursive decomposition, use orchestrate instead.\n\
         - If you just need to read a known file, use Read. If you need to search, use Bash.\n\
         \n\
         <example>\n\
         user: \"Check the test results and also look at the lint output\"\n\
         assistant: Two independent checks — dispatch in parallel:\n\
         dispatch_agent({\"description\": \"check test results\", \"prompt\": \"Run cargo test in src-tauri/ and summarize any failures with file and line numbers\", \"sync\": true})\n\
         dispatch_agent({\"description\": \"check lint warnings\", \"prompt\": \"Run cargo clippy in src-tauri/ and list all warnings\", \"sync\": true})\n\
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
                "description": {
                    "type": "string",
                    "description": "Short 3-5 word summary of what the agent will do. e.g. 'list files in src', 'analyze error patterns', 'check test results'"
                },
                "prompt": {
                    "type": "string",
                    "description": "Full task instructions for the sub-agent. Be specific: what to do, where, and expected output format. e.g. 'Run ls -la in the src/ directory and list all files with their sizes sorted largest first'"
                },
                "sync": {
                    "type": "boolean",
                    "default": true,
                    "description": "true (default): wait for result. false: run in background and return task_id immediately."
                },
                "mode": {
                    "enum": ["preset", "fork"],
                    "default": "preset",
                    "description": "'preset' (default): fresh agent with no history. 'fork': clones current conversation context for tasks that need awareness of prior discussion."
                },
                "subagent_type": {
                    "type": "string",
                    "description": "Agent template name for specialized behavior. Omit to use the default general-purpose agent. e.g. 'code-reviewer', 'explorer'"
                },
                "token_budget": {
                    "type": "integer",
                    "description": "Max tokens the sub-agent may consume. The agent stops when this limit is reached. Default: 50000."
                },
                "max_turns": {
                    "type": "integer",
                    "description": "Max tool-use turns for the sub-agent. Each tool call counts as one turn. Default: 20."
                }
            },
            "required": ["description", "prompt"]
        })
    }

    async fn call(&self, input: serde_json::Value, ctx: Option<&ToolExecutionContext>) -> ToolResult {
        let Some(ctx) = ctx else {
            return ToolResult::Error("dispatch_agent requires ToolExecutionContext".into());
        };

        let description = match input["description"].as_str() {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => {
                return ToolResult::Error(
                    "Missing required parameter 'description'. \
                     You must provide: {\"description\": \"<3-5 word task summary>\", \"prompt\": \"<full task instruction>\"}"
                        .into(),
                );
            }
        };
        let prompt = match input["prompt"].as_str() {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => {
                return ToolResult::Error(
                    "Missing required parameter 'prompt'. \
                     You must provide: {\"description\": \"<summary>\", \"prompt\": \"<full task instruction>\"}"
                        .into(),
                );
            }
        };
        let subagent_type = input["subagent_type"]
            .as_str()
            .unwrap_or("")
            .to_string();
        let is_sync = input["sync"].as_bool().unwrap_or(true);

        // 查找模板
        let template = match ctx.agent_templates.get(&subagent_type) {
            Some(t) => Some(t),
            None if subagent_type.is_empty() => {
                ctx.agent_templates.get("general-purpose")
            }
            None => {
                return ToolResult::Error(format!("template '{}' not found", subagent_type));
            }
        };

        // 构建预算：用户指定优先，否则使用模板默认值
        let default_budget = template
            .map(|t| t.default_budget.clone())
            .unwrap_or(TaskBudget {
                max_tokens: 50_000,
                max_turns: 20,
                max_tool_calls: 100,
            });
        let budget = TaskBudget {
            max_tokens: input["token_budget"]
                .as_u64()
                .unwrap_or(default_budget.max_tokens as u64) as u32,
            max_turns: input["max_turns"]
                .as_u64()
                .unwrap_or(default_budget.max_turns as u64) as u32,
            max_tool_calls: default_budget.max_tool_calls,
        };

        let task_id = generate_task_id("dispatch_agent");
        let start = Instant::now();

        // B2: 在 TaskTree 中注册 TaskNode，使后续 set_task_result/completed_not_injected 能找到
        {
            let mut tree = ctx.task_tree.lock().await;
            let mode = match input["mode"].as_str() {
                Some("fork") => AgentMode::Fork,
                _ => AgentMode::Preset,
            };
            let node = tree.create_task_node(
                None,
                &ctx.session_id,
                &description,
                mode,
                if subagent_type.is_empty() { None } else { Some(subagent_type.clone()) },
                Some(budget.clone()),
            );
            let task_node_id = node.task_id.clone();
            // 用 parent token 派生 child token，实现级联取消
            // 安全性：set_cancel_token 在 spawn_agent（run_subagent → get_cancel_token）之前执行，
            // 因为 spawn_agent 的 tokio::spawn 会在当前 .await 点之后才被调度
            let child_token = ctx.parent_cancel_token
                .as_ref()
                .map(|p| p.child_token())
                .unwrap_or_else(tokio_util::sync::CancellationToken::new);
            tree.set_cancel_token(task_node_id, child_token);
        }

        let tool_use_id = ctx.current_assistant_content.iter().rev()
            .find_map(|block| {
                if let crate::types::transcript::AssistantContentBlock::ToolUse { id, name, .. } = block {
                    if name == "dispatch_agent" { return Some(id.clone()) }
                }
                None
            });

        let _ = ctx.event_tx.send(AgentEvent::TaskCreated {
            session_id: ctx.session_id.clone(),
            task_id: task_id.clone(),
            description: description.clone(),
            mode: input["mode"].as_str().unwrap_or("preset").into(),
            subagent_type: subagent_type.clone(),
            budget: TaskBudgetSummary {
                max_tokens: budget.max_tokens,
            },
            tool_use_id,
        });

        // 构建 SpawnConfig
        let tool_filter = template.map(|t| t.tools.clone());
        // 子 Agent 事件通过父 channel 转发，携带 source_task_id 标识
        let parent_tx = ctx.event_tx.clone();
        let task_id_for_forward = task_id.clone();
        let (sub_event_tx, mut sub_event_rx) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            while let Some(event) = sub_event_rx.recv().await {
                let forwarded = match event {
                    AgentEvent::TextDelta { session_id, delta, .. } => AgentEvent::TextDelta {
                        session_id,
                        delta,
                        source_task_id: Some(task_id_for_forward.clone()),
                    },
                    AgentEvent::ThinkingDelta { session_id, delta, .. } => AgentEvent::ThinkingDelta {
                        session_id,
                        delta,
                        source_task_id: Some(task_id_for_forward.clone()),
                    },
                    AgentEvent::ToolCallStart { session_id, tool_name, tool_use_id, input, .. } => AgentEvent::ToolCallStart {
                        session_id,
                        tool_name,
                        tool_use_id,
                        input,
                        source_task_id: Some(task_id_for_forward.clone()),
                    },
                    AgentEvent::ToolCallEnd { session_id, tool_use_id, is_error, output, .. } => AgentEvent::ToolCallEnd {
                        session_id,
                        tool_use_id,
                        is_error,
                        output,
                        source_task_id: Some(task_id_for_forward.clone()),
                    },
                    // 全局事件直接转发，不加 source_task_id
                    other => other,
                };
                let _ = parent_tx.send(forwarded);
            }
        });
        let spawn_config = SpawnConfig {
            prompt: prompt.clone(),
            history: vec![],
            system_prompt_override: None,
            tool_filter,
            budget: Some(budget),
            event_tx: sub_event_tx,
            sync: is_sync,
            fork_api_messages: None,
            fork_assistant_content: None,
            dynamic_context: DynamicContext {
                cwd: std::env::current_dir()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string(),
                os: std::env::consts::OS.to_string(),
                model: String::new(),
                git_branch: None,
                tool_names: ctx.tool_registry.tool_names(),
                data_context_summary: None,
                conversation_summary: None,
            },
            permission_context: PermissionContext::default(),
            session_id: ctx.session_id.clone(),
            task_id: task_id.clone(),
            node_id: Some(task_id.clone()),
            orchestrate_depth: ctx.orchestrate_depth,
            parent_cancel_token: ctx.parent_cancel_token.clone(),
        };

        let mut spawn_handle = match ctx.agent_spawner.spawn_agent(spawn_config).await {
            Ok(h) => h,
            Err(e) => {
                let _ = ctx.event_tx.send(AgentEvent::TaskCompleted {
                    session_id: ctx.session_id.clone(),
                    task_id: task_id.clone(),
                    status: "failed".into(),
                    result_summary: e.to_string().chars().take(2000).collect(),
                    usage: TaskUsageSummary {
                        total_tokens: 0,
                        tool_uses: 0,
                        duration_ms: start.elapsed().as_millis() as u64,
                    },
                });
                return ToolResult::Error(e.to_string());
            }
        };

        if is_sync {
            // 同步：await 子 Agent 执行完成
            let join = spawn_handle.join_handle.take().unwrap();
            let result = match join.await {
                Ok(Ok(r)) => r,
                Ok(Err(e)) => {
                    let _ = ctx.event_tx.send(AgentEvent::TaskCompleted {
                        session_id: ctx.session_id.clone(),
                        task_id: task_id.clone(),
                        status: "failed".into(),
                        result_summary: e.to_string().chars().take(2000).collect(),
                        usage: TaskUsageSummary {
                            total_tokens: 0,
                            tool_uses: 0,
                            duration_ms: start.elapsed().as_millis() as u64,
                        },
                    });
                    return ToolResult::Error(e.to_string());
                }
                Err(e) => {
                    let _ = ctx.event_tx.send(AgentEvent::TaskCompleted {
                        session_id: ctx.session_id.clone(),
                        task_id: task_id.clone(),
                        status: "failed".into(),
                        result_summary: format!("task panicked: {e}").chars().take(2000).collect(),
                        usage: TaskUsageSummary {
                            total_tokens: 0,
                            tool_uses: 0,
                            duration_ms: start.elapsed().as_millis() as u64,
                        },
                    });
                    return ToolResult::Error(format!("task panicked: {e}"));
                }
            };

            // 将子 Agent transcript 写入 sidechain JSONL
            {
                let sc_path = crate::store::jsonl::sidechain_path(
                    &ctx.data_dir, &ctx.session_id, &task_id,
                );
                for entry in &result.entries {
                    let _ = crate::store::jsonl::append_sidechain_entry(&sc_path, entry);
                }
            }

            let result_text: String = result.entries.iter()
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
                .join("\n");

            let summary: String = result_text.chars().take(2000).collect();
            let elapsed = start.elapsed().as_millis() as u64;

            let _ = ctx.event_tx.send(AgentEvent::TaskCompleted {
                session_id: ctx.session_id.clone(),
                task_id: task_id.clone(),
                status: "completed".into(),
                result_summary: summary.clone(),
                usage: TaskUsageSummary {
                    total_tokens: result.usage.total_tokens,
                    tool_uses: result.usage.tool_uses,
                    duration_ms: elapsed,
                },
            });

            // 写入 TaskTree
            {
                let mut tree = ctx.task_tree.lock().await;
                tree.set_task_result(&task_id, result_text.chars().take(100_000).collect());
            }

            ToolResult::Text(result_text)
        } else {
            // 异步：保存 join_handle，立即返回
            let join = spawn_handle.join_handle.take().unwrap();

            let session_id_bg = ctx.session_id.clone();
            let task_id_bg = task_id.clone();
            let event_tx_bg = ctx.event_tx.clone();
            let task_tree_bg = ctx.task_tree.clone();
            let bg_tasks = ctx.background_tasks.clone();
            let data_dir_bg = ctx.data_dir.clone();

            let handle = tokio::spawn(async move {
                let result = join.await;
                let (status, summary, tokens, tool_uses) = match &result {
                    Ok(Ok(r)) => {
                        let text: String = r.entries.iter()
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
                            .join("\n");
                        ("completed", text, r.usage.total_tokens, r.usage.tool_uses)
                    }
                    Ok(Err(e)) => ("failed", e.to_string(), 0, 0),
                    Err(e) => ("failed", format!("task panicked: {e}"), 0, 0),
                };

                // 将子 Agent transcript 写入 sidechain JSONL
                if status == "completed" {
                    if let Ok(Ok(r)) = &result {
                        let sc_path = crate::store::jsonl::sidechain_path(
                            &data_dir_bg, &session_id_bg, &task_id_bg,
                        );
                        for entry in &r.entries {
                            let _ = crate::store::jsonl::append_sidechain_entry(&sc_path, entry);
                        }
                    }
                }

                let summary_short: String = summary.chars().take(2000).collect();
                let _ = event_tx_bg.send(AgentEvent::TaskCompleted {
                    session_id: session_id_bg.clone(),
                    task_id: task_id_bg.clone(),
                    status: status.to_string(),
                    result_summary: summary_short,
                    usage: TaskUsageSummary {
                        total_tokens: tokens,
                        tool_uses,
                        duration_ms: 0,
                    },
                });

                let mut tree = task_tree_bg.lock().await;
                tree.set_task_result(&task_id_bg, summary.chars().take(100_000).collect());
            });

            {
                let mut tasks = bg_tasks.lock().await;
                tasks.retain(|_, h| !h.is_finished());
                tasks.insert(task_id.clone(), handle);
            }

            ToolResult::Text(format!(
                "<task_notification><task_id>{}</task_id><status>pending</status><message>Task started in background</message></task_notification>",
                task_id
            ))
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

    #[test]
    fn fork_detection_works() {
        let mk_user = |text: &str| TranscriptEntry::User {
            uuid: "u1".into(), parent_uuid: None,
            timestamp: "2026-01-01T00:00:00Z".into(), session_id: "s1".into(),
            content: vec![UserContentBlock::Text { text: text.into() }],
        };
        assert!(is_in_fork_child(&[mk_user("<fork-context>\ndo something\n</fork-context>")]));
        assert!(!is_in_fork_child(&[mk_user("normal message")]));
    }

    #[tokio::test]
    async fn requires_context() {
        let tool = DispatchAgentTool;
        let input = serde_json::json!({
            "description": "test task",
            "prompt": "do something",
            "sync": false
        });

        let result = tool.call(input, None).await;
        assert!(matches!(result, ToolResult::Error(ref e) if e.contains("requires ToolExecutionContext")));
    }
}
