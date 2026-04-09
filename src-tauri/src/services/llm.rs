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
    MessageStop {
        usage: TokenUsage,
        stop_reason: Option<String>,
    },
    #[serde(rename = "error")]
    Error { message: String },
    // tool_use 生命周期事件，用于 agent loop 驱动工具调用
    #[serde(rename = "tool_use_start")]
    ToolUseStart { id: String, name: String },
    #[serde(rename = "tool_use_input_delta")]
    ToolUseInputDelta { id: String, partial_input: String },
    #[serde(rename = "tool_use_end")]
    ToolUseEnd { id: String },
}

// ── Provider trait ────────────────────────────────────────────

#[async_trait]
pub trait LlmProvider: Send + Sync {
    async fn chat_stream(
        &self,
        system: Vec<serde_json::Value>,
        messages: Vec<serde_json::Value>,
        model: &str,
        tools: Option<Vec<serde_json::Value>>,
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
        system: Vec<serde_json::Value>,
        messages: Vec<serde_json::Value>,
        model: &str,
        tools: Option<Vec<serde_json::Value>>,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<LlmStreamEvent, AppError>> + Send>>, AppError>
    {
        let mut body = serde_json::json!({
            "model": model,
            "system": system,
            "messages": messages,
            "stream": true,
            "max_tokens": 4096,
        });
        if let Some(tools) = tools {
            body["tools"] = serde_json::json!(tools);
        }

        let resp = self
            .client
            .post(format!("{}/v1/messages", self.base_url))
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("user-agent", "claude-code/2.1.88")
            .header("content-type", "application/json")
            .json(&body)
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
        "content_block_start" => {
            let data: serde_json::Value = serde_json::from_str(&event.data)
                .map_err(|e| AppError::Llm(format!("invalid JSON in content_block_start: {e}")))?;
            if data["content_block"]["type"] == "tool_use" {
                let id = data["content_block"]["id"]
                    .as_str()
                    .unwrap_or("")
                    .to_string();
                let name = data["content_block"]["name"]
                    .as_str()
                    .unwrap_or("")
                    .to_string();
                Ok(LlmStreamEvent::ToolUseStart { id, name })
            } else {
                // text/thinking block start 不需要处理
                Ok(LlmStreamEvent::TextDelta { delta: String::new() })
            }
        }
        "content_block_delta" => {
            let delta: serde_json::Value = serde_json::from_str(&event.data)
                .map_err(|e| AppError::Llm(format!("invalid JSON in content_block_delta: {e}")))?;

            // tool input delta（partial_json）
            if let Some(partial) = delta["delta"]["partial_json"].as_str() {
                // Anthropic SSE 中 content_block_delta 不直接携带 tool_use id，
                // 用 index 占位，consume_stream 会通过 ToolUseStart 追踪真实 id
                let id = delta["index"]
                    .as_u64()
                    .unwrap_or(0)
                    .to_string();
                return Ok(LlmStreamEvent::ToolUseInputDelta {
                    id,
                    partial_input: partial.to_string(),
                });
            }

            let text = delta["delta"]["text"].as_str().unwrap_or("");
            let thinking = delta["delta"]["thinking"].as_str().unwrap_or("");

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
        "content_block_stop" => {
            // content_block_stop 只有 index 没有 tool_use id，
            // consume_stream 通过追踪 ToolUseStart 来处理 ToolUseEnd
            Ok(LlmStreamEvent::TextDelta { delta: String::new() })
        }
        "message_delta" => {
            let delta: serde_json::Value = serde_json::from_str(&event.data)
                .map_err(|e| AppError::Llm(format!("invalid JSON in message_delta: {e}")))?;
            let usage = &delta["usage"];
            let stop_reason = delta["delta"]["stop_reason"]
                .as_str()
                .map(String::from);
            Ok(LlmStreamEvent::MessageStop {
                usage: TokenUsage {
                    input_tokens: usage["input_tokens"].as_u64().unwrap_or(0) as u32,
                    output_tokens: usage["output_tokens"].as_u64().unwrap_or(0) as u32,
                },
                stop_reason,
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

// ── 带指数退避的重试封装（网络不稳定时启用） ──────────────────

#[allow(dead_code)]
pub async fn chat_stream_with_retry(
    provider: &dyn LlmProvider,
    system: Vec<serde_json::Value>,
    messages: Vec<serde_json::Value>,
    model: &str,
    tools: Option<Vec<serde_json::Value>>,
    max_retries: usize,
) -> Result<Pin<Box<dyn Stream<Item = Result<LlmStreamEvent, AppError>> + Send>>, AppError> {
    let mut attempt = 0;
    loop {
        match provider.chat_stream(system.clone(), messages.clone(), model, tools.clone()).await {
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
            stop_reason: Some("end_turn".to_string()),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"message_stop\""));
        assert!(json.contains("\"input_tokens\":100"));
        assert!(json.contains("\"output_tokens\":50"));
        assert!(json.contains("\"stop_reason\":\"end_turn\""));

        let de: LlmStreamEvent = serde_json::from_str(&json).unwrap();
        if let LlmStreamEvent::MessageStop { usage, stop_reason } = de {
            assert_eq!(usage.input_tokens, 100);
            assert_eq!(stop_reason, Some("end_turn".to_string()));
        } else {
            panic!("Expected MessageStop variant");
        }
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

    #[test]
    fn tool_use_start_serialization() {
        let event = LlmStreamEvent::ToolUseStart {
            id: "toolu_123".to_string(),
            name: "read_file".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"tool_use_start\""));
        assert!(json.contains("\"id\":\"toolu_123\""));
        assert!(json.contains("\"name\":\"read_file\""));

        let de: LlmStreamEvent = serde_json::from_str(&json).unwrap();
        if let LlmStreamEvent::ToolUseStart { id, name } = de {
            assert_eq!(id, "toolu_123");
            assert_eq!(name, "read_file");
        } else {
            panic!("Expected ToolUseStart variant");
        }
    }

    #[test]
    fn tool_use_input_delta_serialization() {
        let event = LlmStreamEvent::ToolUseInputDelta {
            id: "0".to_string(),
            partial_input: r#"{"path":"/tmp"#.to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"tool_use_input_delta\""));
        assert!(json.contains("\"partial_input\":"));

        let de: LlmStreamEvent = serde_json::from_str(&json).unwrap();
        if let LlmStreamEvent::ToolUseInputDelta { id, partial_input } = de {
            assert_eq!(id, "0");
            assert_eq!(partial_input, r#"{"path":"/tmp"#);
        } else {
            panic!("Expected ToolUseInputDelta variant");
        }
    }

    #[test]
    fn tool_use_end_serialization() {
        let event = LlmStreamEvent::ToolUseEnd {
            id: "toolu_123".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"tool_use_end\""));
        assert!(json.contains("\"id\":\"toolu_123\""));

        let de: LlmStreamEvent = serde_json::from_str(&json).unwrap();
        if let LlmStreamEvent::ToolUseEnd { id } = de {
            assert_eq!(id, "toolu_123");
        } else {
            panic!("Expected ToolUseEnd variant");
        }
    }

    #[test]
    fn message_stop_without_stop_reason() {
        let event = LlmStreamEvent::MessageStop {
            usage: TokenUsage { input_tokens: 0, output_tokens: 0 },
            stop_reason: None,
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"stop_reason\":null"));

        let de: LlmStreamEvent = serde_json::from_str(&json).unwrap();
        if let LlmStreamEvent::MessageStop { stop_reason, .. } = de {
            assert!(stop_reason.is_none());
        } else {
            panic!("Expected MessageStop variant");
        }
    }
}
