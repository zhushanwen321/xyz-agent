use crate::types::AppError;
use crate::types::TokenUsage;
use async_trait::async_trait;
use eventsource_stream::Eventsource;
use futures::stream::{Stream, StreamExt};
use std::pin::Pin;

use super::{LlmProvider, LlmStreamEvent};

pub struct AnthropicProvider {
    client: reqwest::Client,
    api_key: String,
    base_url: String,
    max_tokens: u32,
    thinking_enabled: bool,
    thinking_budget_tokens: u32,
}

impl AnthropicProvider {
    pub fn new(api_key: String) -> Self {
        Self {
            client: reqwest::Client::new(),
            api_key,
            base_url: "https://api.anthropic.com".to_string(),
            max_tokens: 4096,
            thinking_enabled: false,
            thinking_budget_tokens: 10_000,
        }
    }

    pub fn with_base_url(mut self, url: String) -> Self {
        self.base_url = url;
        self
    }

    pub fn with_max_tokens(mut self, max_tokens: u32) -> Self {
        self.max_tokens = max_tokens;
        self
    }

    pub fn with_thinking(mut self, enabled: bool, budget: u32) -> Self {
        self.thinking_enabled = enabled;
        self.thinking_budget_tokens = budget;
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
            "max_tokens": self.max_tokens,
        });
        if let Some(tools) = tools {
            body["tools"] = serde_json::json!(tools);
        }

        // Extended Thinking: 需要调高 max_tokens 并注入 thinking 参数
        if self.thinking_enabled {
            let effective_max = std::cmp::max(
                self.max_tokens,
                self.thinking_budget_tokens + 1024,
            );
            body["max_tokens"] = serde_json::json!(effective_max);
            body["thinking"] = serde_json::json!({
                "type": "enabled",
                "budget_tokens": self.thinking_budget_tokens
            });
        }

        // 打印完整请求参数
        let other_params = serde_json::json!({
            "model": body["model"],
            "stream": body["stream"],
            "max_tokens": body["max_tokens"],
            "tools": body.get("tools"),
        });
        log::info!("[llm] request system: {}", serde_json::to_string(&body["system"]).unwrap_or_default());
        log::info!("[llm] request params: {}", serde_json::to_string(&other_params).unwrap_or_default());
        log::info!("[llm] request messages ({}): {}", messages.len(), serde_json::to_string(&messages).unwrap_or_default());

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
            let block_type = data["content_block"]["type"].as_str().unwrap_or("");
            match block_type {
                "tool_use" => {
                    let id = data["content_block"]["id"]
                        .as_str()
                        .unwrap_or("")
                        .to_string();
                    let name = data["content_block"]["name"]
                        .as_str()
                        .unwrap_or("")
                        .to_string();
                    let index = data["index"].as_u64().unwrap_or(0);
                    Ok(LlmStreamEvent::ToolUseStart { id, name, index })
                }
                // thinking block 开始时发出 ThinkingDelta，避免前端产生空 text segment
                "thinking" => Ok(LlmStreamEvent::ThinkingDelta {
                    delta: String::new(),
                }),
                _ => Ok(LlmStreamEvent::TextDelta { delta: String::new() }),
            }
        }
        "content_block_delta" => {
            let delta: serde_json::Value = serde_json::from_str(&event.data)
                .map_err(|e| AppError::Llm(format!("invalid JSON in content_block_delta: {e}")))?;

            if let Some(partial) = delta["delta"]["partial_json"].as_str() {
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
        _ => Ok(LlmStreamEvent::TextDelta {
            delta: String::new(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_thinking_disabled_does_not_inject() {
        let provider = AnthropicProvider::new("test-key".into())
            .with_max_tokens(4096);
        assert!(!provider.thinking_enabled);
        assert_eq!(provider.thinking_budget_tokens, 10_000);
    }

    #[test]
    fn test_thinking_enabled_builder() {
        let provider = AnthropicProvider::new("test-key".into())
            .with_max_tokens(4096)
            .with_thinking(true, 5000);
        assert!(provider.thinking_enabled);
        assert_eq!(provider.thinking_budget_tokens, 5000);
    }

    #[test]
    fn test_thinking_max_tokens_adjustment() {
        // 当 budget + 1024 > max_tokens 时，effective_max 应取较大值
        let provider = AnthropicProvider::new("test-key".into())
            .with_max_tokens(2048)
            .with_thinking(true, 10_000);

        let effective_max = std::cmp::max(
            provider.max_tokens,
            provider.thinking_budget_tokens + 1024,
        );
        assert_eq!(effective_max, 11_024);
    }

    #[test]
    fn test_thinking_max_tokens_no_adjustment_needed() {
        // 当 max_tokens 已经足够大时，不需要调整
        let provider = AnthropicProvider::new("test-key".into())
            .with_max_tokens(16_384)
            .with_thinking(true, 10_000);

        let effective_max = std::cmp::max(
            provider.max_tokens,
            provider.thinking_budget_tokens + 1024,
        );
        assert_eq!(effective_max, 16_384);
    }
}
