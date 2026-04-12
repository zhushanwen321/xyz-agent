pub mod history;
pub mod stream;

use crate::engine::budget_guard::BudgetGuard;
use crate::engine::config::AgentConfig;
use crate::engine::context::data::DataContext;
use crate::engine::context::prompt::{DynamicContext, PromptManager};
use crate::engine::context::{ContextConfig, ContextManager, TokenBudget, trim_old_tool_results};
use crate::engine::llm::LlmProvider;
use crate::engine::tools::{PermissionContext, ToolExecutionContext, ToolRegistry, execute_batch};
use crate::types::{AgentEvent, AppError, AssistantContentBlock, TranscriptEntry, UserContentBlock};
use std::collections::HashMap;
use std::sync::Arc;

use stream::consume_stream;

pub struct AgentLoop {
    provider: Arc<dyn LlmProvider>,
    session_id: String,
    model: String,
}

impl AgentLoop {
    pub fn new(provider: Arc<dyn LlmProvider>, session_id: String, model: String) -> Self {
        Self {
            provider,
            session_id,
            model,
        }
    }

    /// 执行一轮用户请求，可能触发多次 LLM 调用（工具调用循环）。
    pub async fn run_turn(
        &self,
        user_message: String,
        history: Vec<TranscriptEntry>,
        parent_uuid: Option<String>,
        event_tx: tokio::sync::mpsc::UnboundedSender<AgentEvent>,
        tool_registry: &ToolRegistry,
        tool_perms: &PermissionContext,
        prompt_manager: &PromptManager,
        dynamic_context: &DynamicContext,
        agent_config: &AgentConfig,
        mut budget_guard: Option<&mut BudgetGuard>,
        task_tree: Option<Arc<tokio::sync::Mutex<crate::engine::task_tree::TaskTree>>>,
        node_id: Option<String>,
        mut tool_ctx: Option<ToolExecutionContext>,
        api_messages_override: Option<Vec<serde_json::Value>>,
        cancel_token: tokio_util::sync::CancellationToken,
    ) -> Result<Vec<TranscriptEntry>, AppError> {
        let session_id = &self.session_id;
        let max_turns: usize = agent_config.max_turns as usize;
        let keep_tool_results = agent_config.keep_tool_results;

        let token_budget = TokenBudget::new(agent_config.context_window, agent_config.max_output_tokens);
        let context_config = ContextConfig {
            auto_compact_buffer: agent_config.auto_compact_buffer,
            warning_buffer: agent_config.warning_buffer,
            hard_limit_buffer: agent_config.hard_limit_buffer,
            keep_tool_results: agent_config.keep_tool_results,
            compact_max_output_tokens: agent_config.compact_max_output_tokens,
            max_consecutive_failures: agent_config.max_consecutive_failures,
        };
        let mut context_manager = ContextManager::new(context_config, token_budget);

        let mut entries: Vec<TranscriptEntry> = Vec::new();
        let mut current_parent = parent_uuid;
        let mut data_context = DataContext::new();

        let tool_schemas = tool_registry.tool_schemas(tool_perms);

        for iteration in 1..=max_turns {
            // 主对话 cancel 检查
            if cancel_token.is_cancelled() {
                log::info!("[agent_loop] cancel requested for session {}", session_id);
                break;
            }

            // Kill/pause check (P2 SubAgent user intervention)
            if let (Some(ref tree), Some(ref nid)) = (&task_tree, &node_id) {
                let mut tree_guard = tree.lock().await;
                if tree_guard.should_kill(nid) {
                    log::info!("[agent_loop] kill requested for node {}", nid);
                    drop(tree_guard);
                    break;
                }
                if tree_guard.should_pause(nid) {
                    let notify = tree_guard.get_or_create_notifier(nid);
                    drop(tree_guard);
                    // 等待 resume/kill 的即时唤醒，不再轮询
                    notify.notified().await;
                }
            }

            let mut all = history.clone();
            all.extend(entries.iter().cloned());

            // 子 Agent history 为空时，将 prompt 作为首条 user 消息注入
            // 必须检查 history 而非 all：后续迭代 entries 非空会导致 all 非空，
            // 但缺少首条 user message 会使 API messages 以 assistant 开头，违反格式约束
            if history.is_empty() && !user_message.is_empty() {
                all.insert(0, TranscriptEntry::User {
                    uuid: uuid::Uuid::new_v4().to_string(),
                    parent_uuid: None,
                    timestamp: chrono::Utc::now().to_rfc3339(),
                    session_id: session_id.clone(),
                    content: vec![UserContentBlock::Text { text: user_message.clone() }],
                });
            }

            let estimated = context_manager.token_budget.estimate_entries(&all);
            let mut api_messages = match api_messages_override {
                Some(ref msgs) => msgs.clone(),
                None => history::history_to_api_messages(&all),
            };

            if context_manager.needs_compact(estimated) {
                log::info!(
                    "[agent_loop] context over threshold ({estimated} tokens), trimming old tool results"
                );
                trim_old_tool_results(&mut api_messages, keep_tool_results);

                let json_size = serde_json::to_string(&api_messages).unwrap_or_default();
                let re_estimated = context_manager.token_budget.estimate_text(&json_size);
                if context_manager.needs_compact(re_estimated) {
                    log::info!("[agent_loop] still over threshold, calling LLM compact");
                    match context_manager
                        .compact_with_llm(api_messages.clone(), &*self.provider, &self.model)
                        .await
                    {
                        Ok((compressed, _summary)) => api_messages = compressed,
                        Err(e) => log::warn!("[agent_loop] compact_with_llm failed: {e}"),
                    }
                }
            }

            log::info!(
                "[agent_loop] iteration {iteration}, model={}, messages={}",
                self.model,
                api_messages.len()
            );

            let mut ctx = dynamic_context.clone();
            ctx.data_context_summary = data_context.generate_summary();
            let system = prompt_manager.build_system_prompt(&ctx);

            // chat_stream 会消费 api_messages，先 clone 供 ctx 使用
            let api_messages_for_ctx = tool_ctx.as_ref().map(|_| api_messages.clone());

            let stream = self
                .provider
                .chat_stream(
                    system,
                    api_messages,
                    &self.model,
                    Some(tool_schemas.clone()),
                )
                .await
                .map_err(|e| {
                    log::error!("[agent_loop] chat_stream failed: {e}");
                    AppError::Llm(format!("chat_stream failed: {e}"))
                })?;

            let result = consume_stream(stream, &event_tx, session_id, &cancel_token).await?;

            context_manager.token_budget.last_input_tokens = Some(result.usage.input_tokens);

            // SubAgent 预算检查：token/turn 上限、diminishing returns、warning
            if let Some(ref mut bg) = budget_guard {
                let tokens = result.usage.output_tokens;
                if !bg.check_and_deduct_tokens(tokens) {
                    log::warn!("[agent_loop] budget exhausted (tokens)");
                    break;
                }
                if !bg.increment_turn() {
                    log::warn!("[agent_loop] budget exhausted (turns)");
                    break;
                }
                if bg.is_exhausted() {
                    log::warn!("[agent_loop] budget exhausted");
                    break;
                }
                if bg.is_diminishing() {
                    log::info!("[agent_loop] diminishing returns detected, stopping");
                    break;
                }
                if bg.should_warn() {
                    let _ = event_tx.send(AgentEvent::BudgetWarning {
                        session_id: session_id.clone(),
                        task_id: String::new(),
                        usage_percent: bg.usage_percent(),
                    });
                }
            }

            let uuid = uuid::Uuid::new_v4().to_string();
            let content_blocks_for_ctx = tool_ctx.as_ref().map(|_| result.content_blocks.clone());
            entries.push(TranscriptEntry::Assistant {
                uuid: uuid.clone(),
                parent_uuid: current_parent.clone(),
                timestamp: chrono::Utc::now().to_rfc3339(),
                session_id: session_id.clone(),
                content: result.content_blocks,
                usage: Some(result.usage),
            });
            current_parent = Some(uuid);

            if result.stop_reason != "tool_use" || result.tool_calls.is_empty() {
                log::info!(
                    "[agent_loop] turn complete, stop_reason={}",
                    result.stop_reason
                );
                break;
            }

            if iteration == max_turns {
                log::warn!("[agent_loop] max turns ({max_turns}) reached");
                let _ = event_tx.send(AgentEvent::Error {
                    session_id: session_id.clone(),
                    message: format!("已达到最大轮次限制 ({max_turns})"),
                    source_task_id: None,
                });
                break;
            }

            log::info!(
                "[agent_loop] executing {} tool calls",
                result.tool_calls.len()
            );

            let call_map: HashMap<String, _> = result
                .tool_calls
                .into_iter()
                .map(|c| (c.id.clone(), c))
                .collect();

            let calls: Vec<_> = call_map.values().cloned().collect();
            for call in &calls {
                let _ = event_tx.send(AgentEvent::ToolCallStart {
                    session_id: session_id.clone(),
                    tool_name: call.name.clone(),
                    tool_use_id: call.id.clone(),
                    input: call.input.clone(),
                    source_task_id: None,
                });
            }

            // 更新 ctx 中的迭代依赖字段，供 P2 工具使用
            if let (Some(ref mut ctx), Some(blocks), Some(api_msgs)) =
                (&mut tool_ctx, content_blocks_for_ctx, api_messages_for_ctx)
            {
                ctx.api_messages = api_msgs;
                ctx.current_assistant_content = blocks;
            }

            // 工具执行前检查 cancel
            if cancel_token.is_cancelled() {
                log::info!("[agent_loop] cancel before tool execution");
                break;
            }

            let tool_results =
                execute_batch(calls, tool_registry, tool_perms, tool_ctx.as_ref())
                    .await;

            // B5: 按实际工具调用次数递增预算计数器
            for _tr in &tool_results {
                if let Some(ref mut bg) = budget_guard {
                    if !bg.increment_tool_use() {
                        log::warn!("[agent_loop] budget exhausted (tool_calls)");
                        break;
                    }
                }
            }

            let mut user_blocks = Vec::with_capacity(tool_results.len());
            for tr in &tool_results {
                // DataContext tracking for Read calls
                if !tr.is_error {
                    if let Some(call) = call_map.get(&tr.id) {
                        if call.name == "Read" {
                            let file_path = call
                                .input
                                .get("file_path")
                                .and_then(|v| v.as_str())
                                .unwrap_or("unknown");
                            data_context.record_file_read(
                                file_path,
                                tr.output.len() as u64,
                                tr.output.lines().count() as u32,
                            );
                        }
                    }
                }

                user_blocks.push(UserContentBlock::ToolResult {
                    tool_use_id: tr.id.clone(),
                    content: tr.output.clone(),
                    is_error: tr.is_error,
                });

                let _ = event_tx.send(AgentEvent::ToolCallEnd {
                    session_id: session_id.clone(),
                    tool_use_id: tr.id.clone(),
                    is_error: tr.is_error,
                    output: tr.output.clone(),
                    source_task_id: None,
                });
            }

            let uuid = uuid::Uuid::new_v4().to_string();
            entries.push(TranscriptEntry::User {
                uuid: uuid.clone(),
                parent_uuid: current_parent.clone(),
                timestamp: chrono::Utc::now().to_rfc3339(),
                session_id: session_id.clone(),
                content: user_blocks,
            });
            current_parent = Some(uuid);
        }

        // cancel 后清理：移除尾部含 ToolUse 但无对应 ToolResult 的 Assistant 条目，
        // 避免 entries 序列化到 JSONL 后下次加载时因缺少 tool_result 导致 API 报错
        if cancel_token.is_cancelled() {
            while let Some(TranscriptEntry::Assistant { content, .. }) = entries.last() {
                let has_tool_use = content.iter().any(|b| matches!(b, AssistantContentBlock::ToolUse { .. }));
                if has_tool_use {
                    log::info!("[agent_loop] removing incomplete Assistant entry with ToolUse after cancel");
                    entries.pop();
                } else {
                    break;
                }
            }
        }

        Ok(entries)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::llm::test_utils::MockLlmProvider;
    use crate::types::AssistantContentBlock;

    fn test_agent_config() -> AgentConfig {
        AgentConfig::default()
    }

    fn test_prompt_ctx() -> (PromptManager, DynamicContext) {
        (
            PromptManager::new(),
            DynamicContext {
                cwd: "/test".to_string(),
                os: "test".to_string(),
                model: "test-model".to_string(),
                git_branch: None,
                tool_names: vec![],
                data_context_summary: None,
                conversation_summary: None,
            },
        )
    }

    /// 多轮工具调用循环的集成测试
    #[tokio::test]
    async fn test_multi_turn_tool_calling() {
        let provider = Arc::new(MockLlmProvider::new(vec![
            MockLlmProvider::tool_use_response(
                "",
                vec![("toolu_1", "Read", serde_json::json!({"file_path": "test.txt"}))],
            ),
            MockLlmProvider::text_response("The file contains: hello world"),
        ]));

        let registry = ToolRegistry::new();
        let perms = PermissionContext::default();
        let (event_tx, _event_rx) = tokio::sync::mpsc::unbounded_channel();
        let (prompt_manager, dynamic_context) = test_prompt_ctx();

        let agent_loop = AgentLoop::new(provider, "test-session".into(), "test-model".into());

        let entries = agent_loop
            .run_turn("read test.txt".into(), vec![], None, event_tx, &registry, &perms, &prompt_manager, &dynamic_context, &test_agent_config(), None, None, None, None, None, tokio_util::sync::CancellationToken::new())
            .await
            .unwrap();

        assert_eq!(entries.len(), 3);

        assert!(matches!(&entries[0], TranscriptEntry::Assistant { content, .. } if content.iter().any(|b| matches!(b, AssistantContentBlock::ToolUse { .. }))));
        assert!(matches!(&entries[1], TranscriptEntry::User { content, .. } if content.iter().any(|b| matches!(b, UserContentBlock::ToolResult { .. }))));
        assert!(matches!(&entries[2], TranscriptEntry::Assistant { content, .. } if content.iter().any(|b| matches!(b, AssistantContentBlock::Text { .. }))));
    }

    /// 子 Agent 多轮调用回归测试：验证每次 LLM 请求的 messages 都以 user 开头
    /// 修复前：第二次迭代 messages 为 [assistant, user]，违反 API 格式约束
    #[tokio::test]
    async fn test_subagent_messages_always_start_with_user() {
        let provider = Arc::new(MockLlmProvider::new(vec![
            MockLlmProvider::tool_use_response(
                "",
                vec![("toolu_1", "Read", serde_json::json!({"file_path": "test.txt"}))],
            ),
            MockLlmProvider::text_response("done"),
        ]));

        let registry = ToolRegistry::new();
        let perms = PermissionContext::default();
        let (event_tx, _event_rx) = tokio::sync::mpsc::unbounded_channel();
        let (prompt_manager, dynamic_context) = test_prompt_ctx();

        let agent_loop = AgentLoop::new(provider.clone(), "test-session".into(), "test-model".into());

        // 模拟子 Agent：空 history + prompt 作为 user_message
        let _ = agent_loop
            .run_turn("do something".into(), vec![], None, event_tx, &registry, &perms, &prompt_manager, &dynamic_context, &test_agent_config(), None, None, None, None, None, tokio_util::sync::CancellationToken::new())
            .await
            .unwrap();

        let captured = provider.captured_messages.lock().unwrap();
        assert_eq!(captured.len(), 2, "expect 2 LLM calls (tool_use + text)");

        // 第一次调用：[user]
        assert_eq!(captured[0][0]["role"], "user", "first call must start with user");

        // 第二次调用：[user, assistant, user] — 不能以 assistant 开头
        assert_eq!(captured[1][0]["role"], "user", "second call must start with user (regression: was assistant)");
    }

    /// 单轮纯文本（不触发工具调用）
    #[tokio::test]
    async fn test_single_turn_text_response() {
        let provider = Arc::new(MockLlmProvider::new(vec![
            MockLlmProvider::text_response("just a greeting"),
        ]));

        let registry = ToolRegistry::new();
        let perms = PermissionContext::default();
        let (event_tx, _event_rx) = tokio::sync::mpsc::unbounded_channel();
        let (prompt_manager, dynamic_context) = test_prompt_ctx();

        let agent_loop = AgentLoop::new(provider, "test-session".into(), "test-model".into());

        let entries = agent_loop
            .run_turn("hello".into(), vec![], None, event_tx, &registry, &perms, &prompt_manager, &dynamic_context, &test_agent_config(), None, None, None, None, None, tokio_util::sync::CancellationToken::new())
            .await
            .unwrap();

        assert_eq!(entries.len(), 1);
        assert!(matches!(&entries[0], TranscriptEntry::Assistant { content, .. } if matches!(&content[0], AssistantContentBlock::Text { text } if text == "just a greeting")));
    }
}
