use crate::error::AppError;
use crate::models::{AgentEvent, AssistantContentBlock, TokenUsage, TranscriptEntry, UserContentBlock};
use crate::services::llm::{LlmProvider, LlmStreamEvent};
use crate::services::tool_executor::PendingToolCall;
use crate::services::tool_registry::{PermissionContext, ToolRegistry};
use futures::StreamExt;
use std::pin::Pin;
use std::sync::Arc;

pub struct AgentLoop {
    provider: Arc<dyn LlmProvider>,
    session_id: String,
    model: String,
}

/// consume_stream 的返回结果
struct StreamResult {
    content_blocks: Vec<AssistantContentBlock>,
    tool_calls: Vec<PendingToolCall>,
    stop_reason: String,
    usage: TokenUsage,
}

/// 将 LLM 流式响应聚合为结构化 StreamResult，同时向 event_tx 转发前端事件。
///
/// Anthropic SSE 的 ToolUseInputDelta.id 是 content_block index（数字），不是真实 tool_use id。
/// 通过 tool_order 列表做 index -> real_id 映射。
/// ToolUseEnd 不会从真实 SSE 流中发出（content_block_stop 被映射为空 TextDelta），
/// 所以在收到非 tool 事件时自动 flush 当前活跃的 tool。
async fn consume_stream(
    stream: Pin<Box<dyn futures::Stream<Item = Result<LlmStreamEvent, AppError>> + Send>>,
    event_tx: &tokio::sync::mpsc::UnboundedSender<AgentEvent>,
    session_id: &str,
) -> Result<StreamResult, AppError> {
    use std::collections::HashMap;

    let mut text_buf = String::new();
    // id -> (name, accumulated_json)
    let mut tool_buf: HashMap<String, (String, String)> = HashMap::new();
    // index -> real tool id（SSE content_block index -> tool_use id）
    let mut index_to_tool_id: HashMap<String, String> = HashMap::new();
    let mut content_blocks: Vec<AssistantContentBlock> = Vec::new();
    let mut tool_calls: Vec<PendingToolCall> = Vec::new();
    let mut stop_reason = String::new();
    let mut usage = TokenUsage { input_tokens: 0, output_tokens: 0 };
    let mut current_tool_id: Option<String> = None;
    let mut tool_index: usize = 0;

    let mut stream = std::pin::pin!(stream);

    // flush 当前活跃 tool：从 tool_buf 移入 content_blocks + tool_calls
    let flush_current_tool = |tool_id: &mut Option<String>,
                                  tool_buf: &mut HashMap<String, (String, String)>,
                                  content_blocks: &mut Vec<AssistantContentBlock>,
                                  tool_calls: &mut Vec<PendingToolCall>| {
        if let Some(id) = tool_id.take() {
            if let Some((name, json_str)) = tool_buf.remove(&id) {
                let input: serde_json::Value = serde_json::from_str(&json_str)
                    .unwrap_or(serde_json::Value::Object(Default::default()));
                content_blocks.push(AssistantContentBlock::ToolUse {
                    id: id.clone(),
                    name: name.clone(),
                    input: input.clone(),
                });
                tool_calls.push(PendingToolCall { id, name, input });
            }
        }
    };

    // flush tool_buf 中所有剩余 tool
    let flush_all_tools = |tool_buf: &mut HashMap<String, (String, String)>,
                                content_blocks: &mut Vec<AssistantContentBlock>,
                                tool_calls: &mut Vec<PendingToolCall>| {
        let ids: Vec<String> = tool_buf.keys().cloned().collect();
        for id in ids {
            if let Some((name, json_str)) = tool_buf.remove(&id) {
                let input: serde_json::Value = serde_json::from_str(&json_str)
                    .unwrap_or(serde_json::Value::Object(Default::default()));
                content_blocks.push(AssistantContentBlock::ToolUse {
                    id: id.clone(),
                    name: name.clone(),
                    input: input.clone(),
                });
                tool_calls.push(PendingToolCall { id, name, input });
            }
        }
    };

    while let Some(item) = stream.next().await {
        match item {
            Ok(LlmStreamEvent::TextDelta { delta }) => {
                if delta.is_empty() {
                    // 空 TextDelta 可能来自 content_block_stop，不处理
                    continue;
                }
                // 收到非空 text，flush 之前的 tool
                flush_current_tool(
                    &mut current_tool_id,
                    &mut tool_buf,
                    &mut content_blocks,
                    &mut tool_calls,
                );
                flush_all_tools(&mut tool_buf, &mut content_blocks, &mut tool_calls);
                text_buf.push_str(&delta);
                let _ = event_tx.send(AgentEvent::TextDelta {
                    session_id: session_id.to_string(),
                    delta,
                });
            }
            Ok(LlmStreamEvent::ThinkingDelta { delta }) => {
                let _ = event_tx.send(AgentEvent::ThinkingDelta {
                    session_id: session_id.to_string(),
                    delta,
                });
            }
            Ok(LlmStreamEvent::ToolUseStart { id, name }) => {
                // 新 tool 开始，flush 之前未关闭的 tool
                flush_current_tool(
                    &mut current_tool_id,
                    &mut tool_buf,
                    &mut content_blocks,
                    &mut tool_calls,
                );
                // Flush accumulated text as Text block
                if !text_buf.is_empty() {
                    content_blocks.push(AssistantContentBlock::Text {
                        text: std::mem::take(&mut text_buf),
                    });
                }
                index_to_tool_id.insert(tool_index.to_string(), id.clone());
                tool_index += 1;
                tool_buf.insert(id.clone(), (name, String::new()));
                current_tool_id = Some(id);
            }
            Ok(LlmStreamEvent::ToolUseInputDelta { id, partial_input }) => {
                // id 是 content_block index，映射到真实 tool_use id
                let real_id = index_to_tool_id.get(&id).cloned().unwrap_or(id);
                if let Some(entry) = tool_buf.get_mut(&real_id) {
                    entry.1.push_str(&partial_input);
                }
            }
            Ok(LlmStreamEvent::ToolUseEnd { id }) => {
                // MockLlmProvider 会发出此事件；真实 SSE 不会。兼容两种来源。
                if let Some((name, json_str)) = tool_buf.remove(&id) {
                    let input: serde_json::Value = serde_json::from_str(&json_str)
                        .unwrap_or(serde_json::Value::Object(Default::default()));
                    content_blocks.push(AssistantContentBlock::ToolUse {
                        id: id.clone(),
                        name: name.clone(),
                        input: input.clone(),
                    });
                    tool_calls.push(PendingToolCall {
                        id: id.clone(),
                        name,
                        input,
                    });
                }
                if current_tool_id.as_deref() == Some(&id) {
                    current_tool_id = None;
                }
            }
            Ok(LlmStreamEvent::MessageStop { usage: u, stop_reason: sr }) => {
                usage = u;
                if let Some(sr) = sr {
                    stop_reason = sr;
                }
                // Flush 所有未关闭的 tool
                flush_current_tool(
                    &mut current_tool_id,
                    &mut tool_buf,
                    &mut content_blocks,
                    &mut tool_calls,
                );
                flush_all_tools(&mut tool_buf, &mut content_blocks, &mut tool_calls);
                // Flush remaining text
                if !text_buf.is_empty() {
                    content_blocks.push(AssistantContentBlock::Text {
                        text: std::mem::take(&mut text_buf),
                    });
                }
                let _ = event_tx.send(AgentEvent::MessageComplete {
                    session_id: session_id.to_string(),
                    role: "assistant".to_string(),
                    content: content_blocks
                        .iter()
                        .filter_map(|b| match b {
                            AssistantContentBlock::Text { text } => Some(text.as_str()),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join(""),
                    usage: usage.clone(),
                });
            }
            Ok(LlmStreamEvent::Error { message }) => {
                return Err(AppError::Llm(message));
            }
            Err(e) => {
                return Err(e);
            }
        }
    }

    if stop_reason.is_empty() {
        stop_reason = "end_turn".to_string();
    }

    Ok(StreamResult {
        content_blocks,
        tool_calls,
        stop_reason,
        usage,
    })
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
    ///
    /// `history` 已包含当前用户消息（由 chat.rs 追加）。
    /// 返回所有新增的 TranscriptEntry（assistant + tool_result），不含用户消息。
    pub async fn run_turn(
        &self,
        _user_message: String,
        history: Vec<TranscriptEntry>,
        parent_uuid: Option<String>,
        event_tx: tokio::sync::mpsc::UnboundedSender<AgentEvent>,
        tool_registry: &ToolRegistry,
        tool_perms: &PermissionContext,
    ) -> Result<Vec<TranscriptEntry>, AppError> {
        let session_id = &self.session_id;
        let max_turns: usize = 50;
        let mut entries: Vec<TranscriptEntry> = Vec::new();
        let mut current_parent = parent_uuid;

        let tool_schemas = tool_registry.tool_schemas(tool_perms);

        for iteration in 1..=max_turns {
            // history 已包含用户消息 + 本次循环产生的 assistant/tool_result entries
            let mut all = history.clone();
            all.extend(entries.iter().cloned());
            let api_messages = history_to_api_messages(&all);

            log::info!(
                "[agent_loop] iteration {iteration}, model={}, messages={}",
                self.model,
                api_messages.len()
            );

            let stream = self
                .provider
                .chat_stream(
                    vec![], // TODO: Plan C - system prompt from PromptManager
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

            // 创建 assistant entry
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

            // 执行工具
            log::info!(
                "[agent_loop] executing {} tool calls",
                result.tool_calls.len()
            );

            let tool_results =
                crate::services::tool_executor::execute_batch(result.tool_calls, tool_registry, tool_perms)
                    .await;

            // 创建 tool_result user entry
            let mut user_blocks = Vec::new();
            for tr in &tool_results {
                let _ = event_tx.send(AgentEvent::ToolCallStart {
                    session_id: session_id.clone(),
                    tool_name: String::new(),
                    tool_use_id: tr.id.clone(),
                });

                user_blocks.push(UserContentBlock::ToolResult {
                    tool_use_id: tr.id.clone(),
                    content: tr.output.clone(),
                    is_error: tr.is_error,
                });

                let _ = event_tx.send(AgentEvent::ToolCallEnd {
                    session_id: session_id.clone(),
                    tool_use_id: tr.id.clone(),
                    is_error: tr.is_error,
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

fn history_to_api_messages(history: &[TranscriptEntry]) -> Vec<serde_json::Value> {
    history
        .iter()
        .filter_map(|entry| match entry {
            TranscriptEntry::User { content, .. } => {
                if content.is_empty() {
                    None
                } else {
                    Some(serde_json::json!({
                        "role": "user",
                        "content": content,
                    }))
                }
            }
            TranscriptEntry::Assistant { content, .. } => {
                if content.is_empty() {
                    None
                } else {
                    Some(serde_json::json!({
                        "role": "assistant",
                        "content": content,
                    }))
                }
            }
            _ => None,
        })
        .collect()
}

/// LLM 配置：从 .env 文件、环境变量、~/.xyz-agent/config.toml 读取
pub struct LlmConfig {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
}

/// 加载 LLM 配置，优先级：环境变量 > .env 文件 > config.toml
pub fn load_llm_config() -> Result<LlmConfig, AppError> {
    let _ = dotenvy::dotenv();

    let api_key = std::env::var("ANTHROPIC_API_KEY")
        .or_else(|_| read_api_key_from_config_file())
        .map_err(|_| {
            AppError::Config(
                "ANTHROPIC_API_KEY not found in .env, env, or ~/.xyz-agent/config.toml"
                    .to_string(),
            )
        })?;

    let base_url = std::env::var("ANTHROPIC_BASE_URL")
        .unwrap_or_else(|_| "https://api.anthropic.com".to_string());

    let model =
        std::env::var("LLM_MODEL").unwrap_or_else(|_| "claude-sonnet-4-20250514".to_string());

    Ok(LlmConfig {
        api_key,
        base_url,
        model,
    })
}

fn read_api_key_from_config_file() -> Result<String, ()> {
    let config_path = dirs::home_dir()
        .ok_or(())?
        .join(".xyz-agent")
        .join("config.toml");

    if !config_path.exists() {
        return Err(());
    }

    let content = std::fs::read_to_string(&config_path).map_err(|_| ())?;
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(key) = trimmed.strip_prefix("anthropic_api_key") {
            let key = key.trim_start_matches(['=', ' ']).trim();
            if !key.is_empty() {
                return Ok(key.to_string());
            }
        }
    }

    Err(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::UserContentBlock;

    #[test]
    fn history_to_api_messages_filters_system_entries() {
        let history = vec![
            TranscriptEntry::System {
                uuid: "sys-1".to_string(),
                parent_uuid: None,
                timestamp: "2026-01-01T00:00:00Z".to_string(),
                session_id: "s1".to_string(),
                content: "system prompt".to_string(),
            },
            TranscriptEntry::User {
                uuid: "u1".to_string(),
                parent_uuid: None,
                timestamp: "2026-01-01T00:00:00Z".to_string(),
                session_id: "s1".to_string(),
                content: vec![UserContentBlock::Text {
                    text: "hello".to_string(),
                }],
            },
            TranscriptEntry::CustomTitle {
                session_id: "s1".to_string(),
                title: "My Chat".to_string(),
            },
            TranscriptEntry::Summary {
                session_id: "s1".to_string(),
                leaf_uuid: "leaf-1".to_string(),
                summary: "summary text".to_string(),
            },
            TranscriptEntry::Assistant {
                uuid: "a1".to_string(),
                parent_uuid: Some("u1".to_string()),
                timestamp: "2026-01-01T00:00:01Z".to_string(),
                session_id: "s1".to_string(),
                content: vec![AssistantContentBlock::Text {
                    text: "response".to_string(),
                }],
                usage: None,
            },
        ];

        let messages = history_to_api_messages(&history);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[0]["content"][0]["type"], "text");
        assert_eq!(messages[0]["content"][0]["text"], "hello");
        assert_eq!(messages[1]["role"], "assistant");
        assert_eq!(messages[1]["content"][0]["type"], "text");
        assert_eq!(messages[1]["content"][0]["text"], "response");
    }

    #[test]
    fn history_to_api_messages_empty() {
        let history: Vec<TranscriptEntry> = vec![];
        let messages = history_to_api_messages(&history);
        assert!(messages.is_empty());
    }

    #[test]
    fn history_to_api_messages_preserves_order() {
        let history = vec![
            TranscriptEntry::User {
                uuid: "u1".to_string(),
                parent_uuid: None,
                timestamp: "2026-01-01T00:00:00Z".to_string(),
                session_id: "s1".to_string(),
                content: vec![UserContentBlock::Text {
                    text: "first".to_string(),
                }],
            },
            TranscriptEntry::Assistant {
                uuid: "a1".to_string(),
                parent_uuid: Some("u1".to_string()),
                timestamp: "2026-01-01T00:00:01Z".to_string(),
                session_id: "s1".to_string(),
                content: vec![AssistantContentBlock::Text {
                    text: "second".to_string(),
                }],
                usage: None,
            },
            TranscriptEntry::User {
                uuid: "u2".to_string(),
                parent_uuid: Some("a1".to_string()),
                timestamp: "2026-01-01T00:00:02Z".to_string(),
                session_id: "s1".to_string(),
                content: vec![UserContentBlock::Text {
                    text: "third".to_string(),
                }],
            },
        ];

        let messages = history_to_api_messages(&history);
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["content"][0]["text"], "first");
        assert_eq!(messages[1]["content"][0]["text"], "second");
        assert_eq!(messages[2]["content"][0]["text"], "third");

        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[1]["role"], "assistant");
        assert_eq!(messages[2]["role"], "user");
    }

    #[test]
    fn history_to_api_messages_preserves_tool_use_blocks() {
        let history = vec![
            TranscriptEntry::Assistant {
                uuid: "a1".to_string(),
                parent_uuid: None,
                timestamp: "2026-01-01T00:00:00Z".to_string(),
                session_id: "s1".to_string(),
                content: vec![
                    AssistantContentBlock::Text {
                        text: "let me read that".to_string(),
                    },
                    AssistantContentBlock::ToolUse {
                        id: "toolu_123".to_string(),
                        name: "read_file".to_string(),
                        input: serde_json::json!({"path": "/tmp/test"}),
                    },
                ],
                usage: None,
            },
            TranscriptEntry::User {
                uuid: "u1".to_string(),
                parent_uuid: Some("a1".to_string()),
                timestamp: "2026-01-01T00:00:01Z".to_string(),
                session_id: "s1".to_string(),
                content: vec![UserContentBlock::ToolResult {
                    tool_use_id: "toolu_123".to_string(),
                    content: "file content here".to_string(),
                    is_error: false,
                }],
            },
        ];

        let messages = history_to_api_messages(&history);
        assert_eq!(messages.len(), 2);

        // assistant 消息包含 text + tool_use 两个 content block
        assert_eq!(messages[0]["role"], "assistant");
        let assistant_content = messages[0]["content"].as_array().unwrap();
        assert_eq!(assistant_content.len(), 2);
        assert_eq!(assistant_content[0]["type"], "text");
        assert_eq!(assistant_content[1]["type"], "tool_use");
        assert_eq!(assistant_content[1]["id"], "toolu_123");
        assert_eq!(assistant_content[1]["name"], "read_file");

        // user 消息包含 tool_result content block
        assert_eq!(messages[1]["role"], "user");
        let user_content = messages[1]["content"].as_array().unwrap();
        assert_eq!(user_content.len(), 1);
        assert_eq!(user_content[0]["type"], "tool_result");
        assert_eq!(user_content[0]["tool_use_id"], "toolu_123");
    }

    #[test]
    fn load_llm_config_reads_from_env() {
        let saved_key = std::env::var("ANTHROPIC_API_KEY").ok();
        let saved_url = std::env::var("ANTHROPIC_BASE_URL").ok();
        let saved_model = std::env::var("LLM_MODEL").ok();

        std::env::set_var("ANTHROPIC_API_KEY", "env-test-key");
        std::env::set_var("ANTHROPIC_BASE_URL", "https://custom.api.com");
        std::env::set_var("LLM_MODEL", "claude-opus-4");

        let config = load_llm_config().unwrap();
        assert_eq!(config.api_key, "env-test-key");
        assert_eq!(config.base_url, "https://custom.api.com");
        assert_eq!(config.model, "claude-opus-4");

        match saved_key {
            Some(v) => std::env::set_var("ANTHROPIC_API_KEY", v),
            None => std::env::remove_var("ANTHROPIC_API_KEY"),
        }
        match saved_url {
            Some(v) => std::env::set_var("ANTHROPIC_BASE_URL", v),
            None => std::env::remove_var("ANTHROPIC_BASE_URL"),
        }
        match saved_model {
            Some(v) => std::env::set_var("LLM_MODEL", v),
            None => std::env::remove_var("LLM_MODEL"),
        }
    }

    /// consume_stream 的纯文本响应测试
    #[tokio::test]
    async fn test_consume_stream_text_only() {
        use crate::services::test_utils::MockLlmProvider;

        let provider = Arc::new(MockLlmProvider::new(vec![
            MockLlmProvider::text_response("hello world"),
        ]));

        let stream = provider
            .chat_stream(vec![], vec![], "test-model", None)
            .await
            .unwrap();
        let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel();

        let result = consume_stream(stream, &event_tx, "test-session").await.unwrap();

        assert_eq!(result.content_blocks.len(), 1);
        assert!(matches!(&result.content_blocks[0], AssistantContentBlock::Text { text } if text == "hello world"));
        assert!(result.tool_calls.is_empty());
        assert_eq!(result.stop_reason, "end_turn");

        // 验证事件转发
        event_tx.send(AgentEvent::TextDelta {
            session_id: "test-session".to_string(),
            delta: "hello world".to_string(),
        }).unwrap();
        let event = event_rx.recv().await.unwrap();
        assert!(matches!(event, AgentEvent::TextDelta { .. }));
    }

    /// consume_stream 的工具调用响应测试（MockLlmProvider 发出 ToolUseEnd）
    #[tokio::test]
    async fn test_consume_stream_tool_use() {
        use crate::services::test_utils::MockLlmProvider;

        let provider = Arc::new(MockLlmProvider::new(vec![
            MockLlmProvider::tool_use_response(
                "let me read that",
                vec![("toolu_1", "Read", serde_json::json!({"file_path": "test.txt"}))],
            ),
        ]));

        let stream = provider
            .chat_stream(vec![], vec![], "test-model", None)
            .await
            .unwrap();
        let (event_tx, _event_rx) = tokio::sync::mpsc::unbounded_channel();

        let result = consume_stream(stream, &event_tx, "test-session").await.unwrap();

        // 应该有 text + tool_use 两个 content block
        assert_eq!(result.content_blocks.len(), 2);
        assert!(matches!(&result.content_blocks[0], AssistantContentBlock::Text { text } if text == "let me read that"));
        assert!(matches!(&result.content_blocks[1], AssistantContentBlock::ToolUse { id, name, .. } if id == "toolu_1" && name == "Read"));
        assert_eq!(result.tool_calls.len(), 1);
        assert_eq!(result.stop_reason, "tool_use");
    }

    /// 多轮工具调用循环的集成测试
    #[tokio::test]
    async fn test_multi_turn_tool_calling() {
        use crate::services::test_utils::MockLlmProvider;

        // 第一次响应：工具调用 Read
        // 第二次响应：纯文本（看到工具结果后回复）
        let provider = Arc::new(MockLlmProvider::new(vec![
            MockLlmProvider::tool_use_response(
                "",
                vec![("toolu_1", "Read", serde_json::json!({"file_path": "test.txt"}))],
            ),
            MockLlmProvider::text_response("The file contains: hello world"),
        ]));

        let registry = ToolRegistry::new(); // 空 registry，工具会返回 "Unknown tool" 错误
        let perms = PermissionContext::default();
        let (event_tx, _event_rx) = tokio::sync::mpsc::unbounded_channel();

        let agent_loop = AgentLoop::new(provider, "test-session".into(), "test-model".into());

        let entries = agent_loop
            .run_turn("read test.txt".into(), vec![], None, event_tx, &registry, &perms)
            .await
            .unwrap();

        // 应该有 3 个 entries:
        // [0] Assistant(tool_use) — LLM 决定调用工具
        // [1] User(tool_result) — 工具执行结果
        // [2] Assistant(text) — LLM 看到结果后回复
        assert_eq!(entries.len(), 3);

        // [0] assistant with tool_use
        assert!(matches!(&entries[0], TranscriptEntry::Assistant { content, .. } if content.iter().any(|b| matches!(b, AssistantContentBlock::ToolUse { .. }))));

        // [1] user with tool_result
        assert!(matches!(&entries[1], TranscriptEntry::User { content, .. } if content.iter().any(|b| matches!(b, UserContentBlock::ToolResult { .. }))));

        // [2] assistant with text
        assert!(matches!(&entries[2], TranscriptEntry::Assistant { content, .. } if content.iter().any(|b| matches!(b, AssistantContentBlock::Text { .. }))));
    }

    /// 单轮纯文本（不触发工具调用）
    #[tokio::test]
    async fn test_single_turn_text_response() {
        use crate::services::test_utils::MockLlmProvider;

        let provider = Arc::new(MockLlmProvider::new(vec![
            MockLlmProvider::text_response("just a greeting"),
        ]));

        let registry = ToolRegistry::new();
        let perms = PermissionContext::default();
        let (event_tx, _event_rx) = tokio::sync::mpsc::unbounded_channel();

        let agent_loop = AgentLoop::new(provider, "test-session".into(), "test-model".into());

        let entries = agent_loop
            .run_turn("hello".into(), vec![], None, event_tx, &registry, &perms)
            .await
            .unwrap();

        // 单轮应该只有 1 个 entry（assistant text）
        assert_eq!(entries.len(), 1);
        assert!(matches!(&entries[0], TranscriptEntry::Assistant { content, .. } if matches!(&content[0], AssistantContentBlock::Text { text } if text == "just a greeting")));
    }
}
