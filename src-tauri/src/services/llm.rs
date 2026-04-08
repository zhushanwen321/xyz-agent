use crate::error::AppError;
use crate::models::TokenUsage;
use async_trait::async_trait;
use eventsource_stream::Eventsource;
use futures::stream::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use std::pin::Pin;

// ── Stream event ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum LlmStreamEvent {
    #[serde(rename = "text_delta")]
    TextDelta { delta: String },
    #[serde(rename = "thinking_delta")]
    ThinkingDelta { delta: String },
    #[serde(rename = "message_stop")]
    MessageStop { usage: TokenUsage },
    #[serde(rename = "error")]
    Error { message: String },
}

// ── Provider trait ────────────────────────────────────────────

#[async_trait]
pub trait LlmProvider: Send + Sync {
    async fn chat_stream(
        &self,
        messages: Vec<serde_json::Value>,
        model: &str,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<LlmStreamEvent, AppError>> + Send>>, AppError>;
}

// ── Anthropic provider ────────────────────────────────────────

pub struct AnthropicProvider {
    client: reqwest::Client,
    api_key: String,
    base_url: String,
}

impl AnthropicProvider {
    pub fn new(api_key: String) -> Self {
        Self {
            client: reqwest::Client::new(),
            api_key,
            base_url: "https://api.anthropic.com".to_string(),
        }
    }

    pub fn with_base_url(mut self, url: String) -> Self {
        self.base_url = url;
        self
    }
}

#[async_trait]
impl LlmProvider for AnthropicProvider {
    async fn chat_stream(
        &self,
        messages: Vec<serde_json::Value>,
        model: &str,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<LlmStreamEvent, AppError>> + Send>>, AppError>
    {
        let resp = self
            .client
            .post(format!("{}/v1/messages", self.base_url))
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&serde_json::json!({
                "model": model,
                "messages": messages,
                "stream": true,
                "max_tokens": 4096,
            }))
            .send()
            .await
            .map_err(|e| AppError::Llm(format!("request failed: {e}")))?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(AppError::Llm(format!(
                "API returned {status}: {body}"
            )));
        }

        let stream = resp
            .bytes_stream()
            .eventsource()
            .map(move |result| match result {
                Ok(event) => map_sse_event(event),
                Err(e) => Err(AppError::Llm(format!("SSE parse error: {e}"))),
            });

        Ok(Box::pin(stream))
    }
}

// ── SSE → LlmStreamEvent 映射 ────────────────────────────────

fn map_sse_event(event: eventsource_stream::Event) -> Result<LlmStreamEvent, AppError> {
    match event.event.as_str() {
        "content_block_delta" => {
            let delta: serde_json::Value = serde_json::from_str(&event.data)
                .map_err(|e| AppError::Llm(format!("invalid JSON in content_block_delta: {e}")))?;
            let text = delta["delta"]["text"]
                .as_str()
                .unwrap_or("");
            let thinking = delta["delta"]["thinking"]
                .as_str()
                .unwrap_or("");

            if !thinking.is_empty() {
                Ok(LlmStreamEvent::ThinkingDelta {
                    delta: thinking.to_string(),
                })
            } else {
                Ok(LlmStreamEvent::TextDelta {
                    delta: text.to_string(),
                })
            }
        }
        "message_delta" => {
            let delta: serde_json::Value = serde_json::from_str(&event.data)
                .map_err(|e| AppError::Llm(format!("invalid JSON in message_delta: {e}")))?;
            let usage = &delta["usage"];
            Ok(LlmStreamEvent::MessageStop {
                usage: TokenUsage {
                    input_tokens: usage["input_tokens"].as_u64().unwrap_or(0) as u32,
                    output_tokens: usage["output_tokens"].as_u64().unwrap_or(0) as u32,
                },
            })
        }
        "error" => {
            let err: serde_json::Value = serde_json::from_str(&event.data)
                .map_err(|e| AppError::Llm(format!("invalid JSON in error event: {e}")))?;
            let msg = err["error"]["message"]
                .as_str()
                .unwrap_or("unknown error")
                .to_string();
            Ok(LlmStreamEvent::Error { message: msg })
        }
        // 忽略 ping / message_start 等不需要的事件
        _ => Ok(LlmStreamEvent::TextDelta {
            delta: String::new(),
        }),
    }
}

// ── 带指数退避的重试封装 ──────────────────────────────────────

pub async fn chat_stream_with_retry(
    provider: &dyn LlmProvider,
    messages: Vec<serde_json::Value>,
    model: &str,
    max_retries: usize,
) -> Result<Pin<Box<dyn Stream<Item = Result<LlmStreamEvent, AppError>> + Send>>, AppError> {
    let mut attempt = 0;
    loop {
        match provider.chat_stream(messages.clone(), model).await {
            Ok(stream) => return Ok(stream),
            Err(e) if attempt < max_retries => {
                let delay = std::time::Duration::from_secs(1u64 << attempt);
                tokio::time::sleep(delay).await;
                attempt += 1;
                let _ = &e; // 消除 unused 警告
            }
            Err(e) => return Err(e),
        }
    }
}

// ── 单元测试 ──────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_delta_serialization_roundtrip() {
        let event = LlmStreamEvent::TextDelta {
            delta: "hello".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"text_delta\""));
        assert!(json.contains("\"delta\":\"hello\""));

        let de: LlmStreamEvent = serde_json::from_str(&json).unwrap();
        assert!(matches!(de, LlmStreamEvent::TextDelta { .. }));
        if let LlmStreamEvent::TextDelta { delta } = de {
            assert_eq!(delta, "hello");
        }
    }

    #[test]
    fn message_stop_serialization() {
        let event = LlmStreamEvent::MessageStop {
            usage: TokenUsage {
                input_tokens: 100,
                output_tokens: 50,
            },
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"message_stop\""));
        assert!(json.contains("\"input_tokens\":100"));
        assert!(json.contains("\"output_tokens\":50"));
    }

    #[test]
    fn error_event_serialization() {
        let event = LlmStreamEvent::Error {
            message: "rate limited".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"error\""));
        assert!(json.contains("\"message\":\"rate limited\""));

        let de: LlmStreamEvent = serde_json::from_str(&json).unwrap();
        if let LlmStreamEvent::Error { message } = de {
            assert_eq!(message, "rate limited");
        } else {
            panic!("Expected Error variant");
        }
    }
}
