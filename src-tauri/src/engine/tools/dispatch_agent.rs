use async_trait::async_trait;
use std::time::{Duration, Instant};

use crate::engine::task_tree::*;
use crate::engine::tools::{Tool, ToolExecutionContext, ToolResult};
use crate::types::event::*;
use crate::types::transcript::{AssistantContentBlock, TranscriptEntry, UserContentBlock};

/// 构建 Fork 模式的 API messages（byte-identical system prompt + unified placeholder tool_result）
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
        let is_sync = input["sync"].as_bool().unwrap_or(true);

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

        // 从 assistant content 中查找 dispatch_agent 调用对应的 tool_use_id
        let tool_use_id = ctx.current_assistant_content.iter().rev()
            .find_map(|block| {
                if let crate::types::transcript::AssistantContentBlock::ToolUse { id, name, .. } = block {
                    if name == "dispatch_agent" { return Some(id.clone()) }
                }
                None
            });

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
            tool_use_id,
        });

        if is_sync {
            // 同步模式：在当前任务中执行（stub — 等待 P2-C AgentSpawner）
            let result: Result<String, String> = Err(
                "dispatch_agent sync execution not yet implemented — pending AgentSpawner".into(),
            );

            let elapsed = start.elapsed().as_millis() as u64;
            let status_str = if result.is_ok() { "completed" } else { "failed" };

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
        } else {
            // 异步模式：后台执行，立即返回
            let session_id = ctx.session_id.clone();
            let event_tx = ctx.event_tx.clone();
            let bg_tasks = ctx.background_tasks.clone();

            let task_id_bg = task_id.clone();
            let handle = tokio::spawn(async move {
                // P2-B stub: 实际执行推迟到 AgentSpawner
                tokio::time::sleep(Duration::from_millis(100)).await;

                let _ = event_tx.send(AgentEvent::TaskCompleted {
                    session_id: session_id.clone(),
                    task_id: task_id_bg.clone(),
                    status: "completed".into(),
                    result_summary: "async stub — pending AgentSpawner implementation".into(),
                    usage: TaskUsageSummary {
                        total_tokens: 0,
                        tool_uses: 0,
                        duration_ms: 100,
                    },
                });
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

/// 事件通道桥接：将子 Agent 的事件转发到主 Agent，带节流
pub fn bridge_events(
    sub_rx: tokio::sync::mpsc::UnboundedReceiver<AgentEvent>,
    main_tx: tokio::sync::mpsc::UnboundedSender<AgentEvent>,
    _task_id: String,
    _session_id: String,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut rx = sub_rx;
        let mut last_progress = Instant::now();
        let throttle = Duration::from_secs(2);

        while let Some(event) = rx.recv().await {
            match &event {
                AgentEvent::TaskProgress { .. } => {
                    if last_progress.elapsed() >= throttle {
                        last_progress = Instant::now();
                        let _ = main_tx.send(event);
                    }
                }
                AgentEvent::TaskCompleted { .. }
                | AgentEvent::BudgetWarning { .. }
                | AgentEvent::TaskFeedback { .. } => {
                    let _ = main_tx.send(event);
                }
                _ => {}
            }
        }
    })
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
    async fn async_dispatch_returns_notification() {
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
