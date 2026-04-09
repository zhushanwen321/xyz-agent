//! 测试工具：MockLlmProvider 提供预设的 LLM 流式响应，
//! 用于在不调用真实 API 的情况下测试 agent_loop。

use crate::error::AppError;
use crate::models::TokenUsage;
use async_trait::async_trait;
use futures::stream::{self, Stream};
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};

use super::llm::{LlmProvider, LlmStreamEvent};

#[cfg(test)]
pub struct MockLlmProvider {
    /// 预设的流式响应序列，每次 chat_stream 调用消费一个
    pub responses: Vec<Vec<LlmStreamEvent>>,
    pub call_count: AtomicUsize,
}

#[cfg(test)]
impl MockLlmProvider {
    pub fn new(responses: Vec<Vec<LlmStreamEvent>>) -> Self {
        Self {
            responses,
            call_count: AtomicUsize::new(0),
        }
    }

    /// 构造一个纯文本响应
    pub fn text_response(text: &str) -> Vec<LlmStreamEvent> {
        vec![
            LlmStreamEvent::TextDelta { delta: text.to_string() },
            LlmStreamEvent::MessageStop {
                usage: TokenUsage {
                    input_tokens: 10,
                    output_tokens: text.len() as u32,
                },
                stop_reason: Some("end_turn".to_string()),
            },
        ]
    }

    /// 构造一个包含工具调用的响应
    pub fn tool_use_response(
        text: &str,
        tool_calls: Vec<(&str, &str, serde_json::Value)>,
    ) -> Vec<LlmStreamEvent> {
        let mut events = Vec::new();
        if !text.is_empty() {
            events.push(LlmStreamEvent::TextDelta { delta: text.to_string() });
        }
        for (id, name, input) in tool_calls {
            events.push(LlmStreamEvent::ToolUseStart {
                id: id.to_string(),
                name: name.to_string(),
            });
            events.push(LlmStreamEvent::ToolUseInputDelta {
                id: id.to_string(),
                partial_input: serde_json::to_string(&input).unwrap(),
            });
            events.push(LlmStreamEvent::ToolUseEnd { id: id.to_string() });
        }
        events.push(LlmStreamEvent::MessageStop {
            usage: TokenUsage { input_tokens: 10, output_tokens: 50 },
            stop_reason: Some("tool_use".to_string()),
        });
        events
    }
}

#[cfg(test)]
#[async_trait]
impl LlmProvider for MockLlmProvider {
    async fn chat_stream(
        &self,
        _messages: Vec<serde_json::Value>,
        _model: &str,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<LlmStreamEvent, AppError>> + Send>>, AppError>
    {
        let idx = self.call_count.fetch_add(1, Ordering::SeqCst);
        let response = self.responses.get(idx).cloned().ok_or_else(|| {
            AppError::Llm(format!(
                "MockLlmProvider: 超出预设响应数量 (call {idx}, max {})",
                self.responses.len()
            ))
        })?;

        let s = stream::iter(response.into_iter().map(Ok));
        Ok(Box::pin(s))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::StreamExt;

    #[tokio::test]
    async fn mock_returns_preset_text_response() {
        let provider = MockLlmProvider::new(vec![
            MockLlmProvider::text_response("hello world"),
        ]);

        let mut stream = provider.chat_stream(vec![], "test-model").await.unwrap();
        let events: Vec<_> = stream.by_ref().collect().await;

        assert_eq!(events.len(), 2);
        assert!(matches!(
            &events[0],
            Ok(LlmStreamEvent::TextDelta { delta }) if delta == "hello world"
        ));
        assert!(matches!(
            &events[1],
            Ok(LlmStreamEvent::MessageStop { stop_reason, .. }) if stop_reason.as_deref() == Some("end_turn")
        ));
    }

    #[tokio::test]
    async fn mock_returns_tool_use_response() {
        let provider = MockLlmProvider::new(vec![MockLlmProvider::tool_use_response(
            "",
            vec![("toolu_1", "read_file", serde_json::json!({"path": "/tmp"}))],
        )]);

        let mut stream = provider.chat_stream(vec![], "test-model").await.unwrap();
        let events: Vec<_> = stream.by_ref().collect().await;

        assert_eq!(events.len(), 4); // start + input_delta + end + message_stop
        assert!(matches!(&events[0], Ok(LlmStreamEvent::ToolUseStart { id, name }) if id == "toolu_1" && name == "read_file"));
        assert!(matches!(&events[1], Ok(LlmStreamEvent::ToolUseInputDelta { .. })));
        assert!(matches!(&events[2], Ok(LlmStreamEvent::ToolUseEnd { id }) if id == "toolu_1"));
        assert!(matches!(&events[3], Ok(LlmStreamEvent::MessageStop { stop_reason, .. }) if stop_reason.as_deref() == Some("tool_use")));
    }

    #[tokio::test]
    async fn mock_errors_when_exhausted() {
        let provider = MockLlmProvider::new(vec![]);

        let result = provider.chat_stream(vec![], "test-model").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn mock_tracks_call_count() {
        let provider = MockLlmProvider::new(vec![
            MockLlmProvider::text_response("first"),
            MockLlmProvider::text_response("second"),
        ]);

        // 第一次调用
        let mut s1 = provider.chat_stream(vec![], "m").await.unwrap();
        let _: Vec<_> = s1.by_ref().collect().await;
        assert_eq!(provider.call_count.load(Ordering::SeqCst), 1);

        // 第二次调用
        let mut s2 = provider.chat_stream(vec![], "m").await.unwrap();
        let events: Vec<_> = s2.by_ref().collect().await;
        assert!(matches!(
            &events[0],
            Ok(LlmStreamEvent::TextDelta { delta }) if delta == "second"
        ));
        assert_eq!(provider.call_count.load(Ordering::SeqCst), 2);
    }
}
