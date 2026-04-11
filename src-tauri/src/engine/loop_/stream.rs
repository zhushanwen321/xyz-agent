use crate::engine::tools::PendingToolCall;
use crate::types::{AgentEvent, AppError, AssistantContentBlock, TokenUsage};
use futures::StreamExt;
use std::collections::HashMap;
use std::pin::Pin;

use crate::engine::llm::LlmStreamEvent;

/// consume_stream 的返回结果
pub(super) struct StreamResult {
    pub content_blocks: Vec<AssistantContentBlock>,
    pub tool_calls: Vec<PendingToolCall>,
    pub stop_reason: String,
    pub usage: TokenUsage,
}

/// 将 LLM 流式响应聚合为结构化 StreamResult，同时向 event_tx 转发前端事件。
/// 支持 CancellationToken 中断：cancel 时 flush 已缓冲内容并发送 MessageComplete。
pub(super) async fn consume_stream(
    stream: Pin<Box<dyn futures::Stream<Item = Result<LlmStreamEvent, AppError>> + Send>>,
    event_tx: &tokio::sync::mpsc::UnboundedSender<AgentEvent>,
    session_id: &str,
    cancel_token: &tokio_util::sync::CancellationToken,
) -> Result<StreamResult, AppError> {
    let mut text_buf = String::new();
    let mut tool_buf: HashMap<String, (String, String)> = HashMap::new();
    let mut index_to_tool_id: HashMap<String, String> = HashMap::new();
    let mut content_blocks: Vec<AssistantContentBlock> = Vec::new();
    let mut tool_calls: Vec<PendingToolCall> = Vec::new();
    let mut stop_reason = String::new();
    let mut usage = TokenUsage { input_tokens: 0, output_tokens: 0 };
    let mut current_tool_id: Option<String> = None;
    let mut tool_index: usize = 0;

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

    let mut stream = std::pin::pin!(stream);

    loop {
        tokio::select! {
            biased;
            _ = cancel_token.cancelled() => {
                // flush 已缓冲内容，保留已输出文本
                flush_current_tool(&mut current_tool_id, &mut tool_buf, &mut content_blocks, &mut tool_calls);
                flush_all_tools(&mut tool_buf, &mut content_blocks, &mut tool_calls);
                if !text_buf.is_empty() {
                    content_blocks.push(AssistantContentBlock::Text {
                        text: std::mem::take(&mut text_buf),
                    });
                }
                // 发送 MessageComplete 让前端清空 streamingText
                let text: String = content_blocks.iter()
                    .filter_map(|b| match b {
                        AssistantContentBlock::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect();
                let _ = event_tx.send(AgentEvent::MessageComplete {
                    session_id: session_id.to_string(),
                    role: "assistant".to_string(),
                    content: text,
                    usage: TokenUsage { input_tokens: 0, output_tokens: 0 },
                });
                // 区分用户主动取消和正常结束，避免上层误判为 tool_use 循环
                stop_reason = "cancelled".to_string();
                break;
            }
            item = stream.next() => {
                let Some(item) = item else { break };
                match item {
            Ok(LlmStreamEvent::TextDelta { delta }) => {
                if delta.is_empty() {
                    continue;
                }
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
                flush_current_tool(
                    &mut current_tool_id,
                    &mut tool_buf,
                    &mut content_blocks,
                    &mut tool_calls,
                );
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
                let real_id = index_to_tool_id.get(&id).cloned().unwrap_or(id);
                if let Some(entry) = tool_buf.get_mut(&real_id) {
                    entry.1.push_str(&partial_input);
                }
            }
            Ok(LlmStreamEvent::ToolUseEnd { id }) => {
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
                flush_current_tool(
                    &mut current_tool_id,
                    &mut tool_buf,
                    &mut content_blocks,
                    &mut tool_calls,
                );
                flush_all_tools(&mut tool_buf, &mut content_blocks, &mut tool_calls);
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
        }
    }

    // 仅在流自然结束（stream.next() 返回 None）且未设置 stop_reason 时回退
    // "cancelled" 和正常 stop_reason（"end_turn"/"tool_use"）不应被覆盖
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::llm::LlmProvider;
    use crate::engine::llm::test_utils::MockLlmProvider;
    use std::sync::Arc;

    /// consume_stream 的纯文本响应测试
    #[tokio::test]
    async fn test_consume_stream_text_only() {
        let provider = Arc::new(MockLlmProvider::new(vec![
            MockLlmProvider::text_response("hello world"),
        ]));

        let stream = provider
            .chat_stream(vec![], vec![], "test-model", None)
            .await
            .unwrap();
        let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel();

        let result = consume_stream(stream, &event_tx, "test-session", &tokio_util::sync::CancellationToken::new()).await.unwrap();

        assert_eq!(result.content_blocks.len(), 1);
        assert!(matches!(&result.content_blocks[0], AssistantContentBlock::Text { text } if text == "hello world"));
        assert!(result.tool_calls.is_empty());
        assert_eq!(result.stop_reason, "end_turn");

        event_tx.send(AgentEvent::TextDelta {
            session_id: "test-session".to_string(),
            delta: "hello world".to_string(),
        }).unwrap();
        let event = event_rx.recv().await.unwrap();
        assert!(matches!(event, AgentEvent::TextDelta { .. }));
    }

    /// consume_stream 的工具调用响应测试
    #[tokio::test]
    async fn test_consume_stream_tool_use() {
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

        let result = consume_stream(stream, &event_tx, "test-session", &tokio_util::sync::CancellationToken::new()).await.unwrap();

        assert_eq!(result.content_blocks.len(), 2);
        assert!(matches!(&result.content_blocks[0], AssistantContentBlock::Text { text } if text == "let me read that"));
        assert!(matches!(&result.content_blocks[1], AssistantContentBlock::ToolUse { id, name, .. } if id == "toolu_1" && name == "Read"));
        assert_eq!(result.tool_calls.len(), 1);
        assert_eq!(result.stop_reason, "tool_use");
    }

    /// CancellationToken 中断测试：流挂起时触发 cancel，验证 stop_reason 和缓冲区 flush
    #[tokio::test]
    async fn test_consume_stream_cancelled() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        // 构造一个先发 TextDelta 再挂起（直到 cancel）的流
        let sent_text = Arc::new(AtomicBool::new(false));
        let stream = futures::stream::unfold(
            sent_text.clone(),
            |sent| async move {
                if !sent.swap(true, Ordering::Relaxed) {
                    Some((
                        Ok(LlmStreamEvent::TextDelta { delta: "partial".to_string() }),
                        sent,
                    ))
                } else {
                    // 挂起直到 cancel 导致 select! 中断
                    std::future::pending().await
                }
            },
        );
        let stream: Pin<Box<dyn futures::Stream<Item = Result<LlmStreamEvent, AppError>> + Send>> =
            Box::pin(stream);

        let (event_tx, _event_rx) = tokio::sync::mpsc::unbounded_channel();
        let cancel_token = Arc::new(tokio_util::sync::CancellationToken::new());
        let cancel_clone = cancel_token.clone();

        let handle = tokio::spawn(async move {
            consume_stream(stream, &event_tx, "test-session", &cancel_clone).await
        });

        // 等 TextDelta 被处理
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        cancel_token.cancel();

        let result = handle.await.unwrap().unwrap();
        assert_eq!(result.stop_reason, "cancelled");
        assert_eq!(result.content_blocks.len(), 1);
        assert!(matches!(&result.content_blocks[0], AssistantContentBlock::Text { text } if text == "partial"));
        assert_eq!(result.usage.input_tokens, 0);
        assert_eq!(result.usage.output_tokens, 0);
    }
}
