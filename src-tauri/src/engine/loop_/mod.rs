pub mod history;
pub mod stream;

use crate::engine::budget_guard::BudgetGuard;
use crate::engine::config::AgentConfig;
use crate::engine::context::data::DataContext;
use crate::engine::context::prompt::{DynamicContext, PromptManager};
use crate::engine::context::{ContextConfig, ContextManager, TokenBudget, trim_old_tool_results};
use crate::engine::llm::LlmProvider;
use crate::engine::tools::{PermissionContext, ToolRegistry, execute_batch};
use crate::types::{AgentEvent, AppError, TranscriptEntry, UserContentBlock};
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
        _user_message: String,
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
            // Kill/pause check (P2 SubAgent user intervention)
            if let (Some(ref tree), Some(ref nid)) = (&task_tree, &node_id) {
                let tree_guard = tree.lock().await;
                if tree_guard.should_kill(nid) {
                    log::info!("[agent_loop] kill requested for node {}", nid);
                    drop(tree_guard);
                    break;
                }
                if tree_guard.should_pause(nid) {
                    let nid_clone = nid.clone();
                    drop(tree_guard);
                    // Non-blocking pause loop: check every 1 second
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                        let tg = task_tree.as_ref().unwrap().lock().await;
                        if !tg.should_pause(&nid_clone) {
                            break;
                        }
                        if tg.should_kill(&nid_clone) {
                            break;
                        }
                    }
                }
            }

            let mut all = history.clone();
            all.extend(entries.iter().cloned());

            let estimated = context_manager.token_budget.estimate_entries(&all);
            let mut api_messages = history::history_to_api_messages(&all);

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

            let result = consume_stream(stream, &event_tx, session_id).await?;

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
                });
                break;
            }

            log::info!(
                "[agent_loop] executing {} tool calls",
                result.tool_calls.len()
            );

            let call_map: HashMap<String, _> = result
                .tool_calls
                .iter()
                .map(|c| (c.id.clone(), c.clone()))
                .collect();

            for call in &result.tool_calls {
                let _ = event_tx.send(AgentEvent::ToolCallStart {
                    session_id: session_id.clone(),
                    tool_name: call.name.clone(),
                    tool_use_id: call.id.clone(),
                    input: call.input.clone(),
                });
            }

            let tool_results =
                execute_batch(result.tool_calls.clone(), tool_registry, tool_perms, None)
                    .await;

            for tr in &tool_results {
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
            }

            let mut user_blocks = Vec::new();
            for tr in &tool_results {
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
            .run_turn("read test.txt".into(), vec![], None, event_tx, &registry, &perms, &prompt_manager, &dynamic_context, &test_agent_config(), None, None, None)
            .await
            .unwrap();

        assert_eq!(entries.len(), 3);

        assert!(matches!(&entries[0], TranscriptEntry::Assistant { content, .. } if content.iter().any(|b| matches!(b, AssistantContentBlock::ToolUse { .. }))));
        assert!(matches!(&entries[1], TranscriptEntry::User { content, .. } if content.iter().any(|b| matches!(b, UserContentBlock::ToolResult { .. }))));
        assert!(matches!(&entries[2], TranscriptEntry::Assistant { content, .. } if content.iter().any(|b| matches!(b, AssistantContentBlock::Text { .. }))));
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
            .run_turn("hello".into(), vec![], None, event_tx, &registry, &perms, &prompt_manager, &dynamic_context, &test_agent_config(), None, None, None)
            .await
            .unwrap();

        assert_eq!(entries.len(), 1);
        assert!(matches!(&entries[0], TranscriptEntry::Assistant { content, .. } if matches!(&content[0], AssistantContentBlock::Text { text } if text == "just a greeting")));
    }
}
