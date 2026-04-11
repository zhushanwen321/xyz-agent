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
        "Launch a sub-agent to handle an independent task.\n\
         \n\
         The sub-agent runs in isolation with its own context. Use it to:\n\
         - Delegate independent work that can run in parallel\n\
         - Isolate long-running tasks from the main conversation\n\
         \n\
         The sub-agent has access to the same tools (Bash, Read, Write).\n\
         Set sync=true to block until completion, sync=false for fire-and-forget.\n\
         \n\
         Example: {\"description\": \"list files in src\", \"prompt\": \"Run ls -la in the src/ directory and report the results\", \"sync\": true}"
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
                    "description": "Short 3-5 word summary of the task, e.g. 'list files in src'"
                },
                "prompt": {
                    "type": "string",
                    "description": "Full task instruction for the sub-agent. Be specific about what to do and where, e.g. 'Run ls -la in the src/ directory and list all files found'"
                },
                "mode": {
                    "enum": ["preset", "fork"],
                    "default": "preset",
                    "description": "Agent launch mode. Use 'preset' (default) for template-based agents, 'fork' to clone current context."
                },
                "subagent_type": {
                    "type": "string",
                    "description": "Agent template name. Optional — defaults to general-purpose if omitted."
                },
                "sync": {
                    "type": "boolean",
                    "default": true,
                    "description": "If true, wait for the sub-agent to finish and return its result. If false, return immediately and run in background."
                },
                "token_budget": {
                    "type": "integer",
                    "description": "Maximum tokens the sub-agent may consume. Default: 50000"
                },
                "max_turns": {
                    "type": "integer",
                    "description": "Maximum tool-use turns for the sub-agent. Default: 20"
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
        let spawn_config = SpawnConfig {
            prompt: prompt.clone(),
            history: vec![],
            system_prompt_override: None,
            tool_filter,
            budget: Some(budget),
            event_tx: ctx.event_tx.clone(),
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

            // 包装为 JoinHandle<()> 以匹配 background_tasks 类型
            let bg_tasks = ctx.background_tasks.clone();
            let handle = tokio::spawn(async move {
                let _ = join.await;
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
        let history = vec![TranscriptEntry::User {
            uuid: "u1".into(),
            parent_uuid: None,
            timestamp: "2026-01-01T00:00:00Z".into(),
            session_id: "s1".into(),
            content: vec![UserContentBlock::Text {
                text: "<fork-context>\ndo something\n</fork-context>".into(),
            }],
        }];
        assert!(is_in_fork_child(&history));

        let normal = vec![TranscriptEntry::User {
            uuid: "u1".into(),
            parent_uuid: None,
            timestamp: "2026-01-01T00:00:00Z".into(),
            session_id: "s1".into(),
            content: vec![UserContentBlock::Text {
                text: "normal message".into(),
            }],
        }];
        assert!(!is_in_fork_child(&normal));
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
