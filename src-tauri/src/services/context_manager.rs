use crate::error::AppError;
use crate::models::TranscriptEntry;

// ── Token budget estimation ─────────────────────────────────────

pub struct TokenBudget {
    pub context_window: u32,
    pub max_output_tokens: u32,
    pub last_input_tokens: Option<u32>,
}

impl TokenBudget {
    pub fn new(context_window: u32, max_output_tokens: u32) -> Self {
        Self {
            context_window,
            max_output_tokens,
            last_input_tokens: None,
        }
    }

    /// 可用于输入的最大 token 数
    pub fn effective_window(&self) -> u32 {
        self.context_window
            .saturating_sub(self.max_output_tokens)
    }

    /// 粗略估算：~4 字符 = 1 token
    pub fn estimate_text(&self, text: &str) -> u32 {
        (text.len() as u32) / 4
    }

    /// 估算 TranscriptEntry 列表的总 token 数
    pub fn estimate_entries(&self, entries: &[TranscriptEntry]) -> u32 {
        let mut total: u32 = 0;
        for entry in entries {
            let text = match entry {
                TranscriptEntry::User { content, .. } => content
                    .iter()
                    .map(|b| match b {
                        crate::models::UserContentBlock::Text { text } => text.clone(),
                        crate::models::UserContentBlock::ToolResult { content, .. } => {
                            content.clone()
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(""),
                TranscriptEntry::Assistant { content, .. } => content
                    .iter()
                    .map(|b| match b {
                        crate::models::AssistantContentBlock::Text { text } => text.clone(),
                        crate::models::AssistantContentBlock::ToolUse { input, .. } => {
                            input.to_string()
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(""),
                TranscriptEntry::System { content, .. } => content.as_str().to_string(),
                TranscriptEntry::CustomTitle { .. } | TranscriptEntry::Summary { .. } => continue,
            };
            total += self.estimate_text(&text);
        }
        total
    }
}

// ── Context compression config ──────────────────────────────────

pub struct ContextConfig {
    /// 低于此 buffer 时触发自动压缩
    pub auto_compact_buffer: u32,
    /// 低于此 buffer 时发出警告
    pub warning_buffer: u32,
    /// 硬限制 buffer（不允许超出）
    pub hard_limit_buffer: u32,
    /// trim 时保留的最近 tool_result 数量
    pub keep_tool_results: usize,
    /// 压缩 LLM 的最大输出 token
    pub compact_max_output_tokens: u32,
    /// 连续压缩失败熔断阈值
    pub max_consecutive_failures: u32,
}

impl Default for ContextConfig {
    fn default() -> Self {
        Self {
            auto_compact_buffer: 13_000,
            warning_buffer: 20_000,
            hard_limit_buffer: 3_000,
            keep_tool_results: 10,
            compact_max_output_tokens: 20_000,
            max_consecutive_failures: 3,
        }
    }
}

// ── 第一层裁剪：保留最近 K 个 tool_result ──────────────────────

/// 保留最近 K 个 tool_result，更早的替换为引用标记
pub fn trim_old_tool_results(messages: &mut Vec<serde_json::Value>, keep: usize) {
    // 收集所有 tool_result 位置 (msg_idx, block_idx)
    let mut tool_result_positions: Vec<(usize, usize)> = Vec::new();
    for (msg_idx, msg) in messages.iter().enumerate() {
        let content = match msg.get("content").and_then(|c| c.as_array()) {
            Some(arr) => arr,
            None => continue,
        };
        for (block_idx, block) in content.iter().enumerate() {
            if block.get("type").and_then(|t| t.as_str()) == Some("tool_result") {
                tool_result_positions.push((msg_idx, block_idx));
            }
        }
    }

    if tool_result_positions.len() <= keep {
        return;
    }

    let trim_count = tool_result_positions.len() - keep;
    for &(msg_idx, block_idx) in tool_result_positions.iter().take(trim_count) {
        if let Some(content) = messages[msg_idx]
            .get_mut("content")
            .and_then(|c| c.as_array_mut())
        {
            let original = &content[block_idx];
            let tool_use_id = original
                .get("tool_use_id")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            let original_text = original
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let size = original_text.len();
            content[block_idx] = serde_json::json!({
                "type": "tool_result",
                "tool_use_id": tool_use_id,
                "content": format!("[tool_result trimmed: {size} chars]"),
                "is_error": false,
            });
        }
    }
}

/// 相同工具 + 相同参数的连续调用去重（P1 简化：预留接口）
#[allow(dead_code)]
pub fn deduplicate_tool_results(_messages: &mut Vec<serde_json::Value>) {
    // P1 简化实现：暂不做去重，预留接口
}

// ── ContextManager ──────────────────────────────────────────────

pub struct ContextManager {
    config: ContextConfig,
    token_budget: TokenBudget,
    consecutive_failures: u32,
}

impl ContextManager {
    pub fn new(config: ContextConfig, token_budget: TokenBudget) -> Self {
        Self {
            config,
            token_budget,
            consecutive_failures: 0,
        }
    }

    /// 估算 token 是否超过压缩阈值
    pub fn needs_compact(&self, estimated_tokens: u32) -> bool {
        let threshold = self
            .token_budget
            .effective_window()
            .saturating_sub(self.config.auto_compact_buffer);
        estimated_tokens > threshold
    }

    /// 第二层：LLM 摘要压缩
    pub async fn compact_with_llm(
        &mut self,
        messages: Vec<serde_json::Value>,
        provider: &dyn crate::services::llm::LlmProvider,
        model: &str,
    ) -> Result<(Vec<serde_json::Value>, Option<String>), AppError> {
        // 熔断检查
        if self.consecutive_failures >= self.config.max_consecutive_failures {
            return Err(AppError::Llm(
                "连续压缩失败次数过多，停止压缩".into(),
            ));
        }

        const COMPACT_SYSTEM: &str =
            "你是一个对话摘要助手。请将以下对话历史压缩为简洁的摘要，保留：\n\
             1. 用户的核心需求和意图\n\
             2. 已完成的关键操作和结论\n\
             3. 未解决的待办事项\n\
             不要包含工具调用的原始输出，只保留结论性信息。";

        let conversation_text = messages
            .iter()
            .filter_map(|m| {
                let role = m.get("role")?.as_str()?;
                let content = m.get("content")?;
                // content 可能是 string 或 array，统一取文本
                let text = match content.as_str() {
                    Some(s) => s.to_string(),
                    None => {
                        // array 模式：拼接 text block
                        content
                            .as_array()?
                            .iter()
                            .filter_map(|block| {
                                if block.get("type")?.as_str()? == "text" {
                                    block.get("text")?.as_str().map(|s| s.to_string())
                                } else {
                                    None
                                }
                            })
                            .collect::<Vec<_>>()
                            .join(" ")
                    }
                };
                Some(format!("[{role}]: {text}"))
            })
            .collect::<Vec<_>>()
            .join("\n");

        let summary_request = serde_json::json!({
            "role": "user",
            "content": format!("请摘要以下对话：\n{}", conversation_text)
        });

        let stream = provider
            .chat_stream(
                vec![serde_json::json!({
                    "type": "text",
                    "text": COMPACT_SYSTEM,
                    "cache_control": {"type": "ephemeral"}
                })],
                vec![summary_request],
                model,
                None,
            )
            .await?;

        let mut summary_text = String::new();
        let mut stream = std::pin::pin!(stream);
        while let Some(item) = futures::StreamExt::next(&mut stream).await {
            match item {
                Ok(crate::services::llm::LlmStreamEvent::TextDelta { delta }) => {
                    summary_text.push_str(&delta)
                }
                Ok(crate::services::llm::LlmStreamEvent::Error { message: _ }) => {
                    self.consecutive_failures += 1;
                    return Ok((messages, None));
                }
                Err(_) => {
                    self.consecutive_failures += 1;
                    return Ok((messages, None));
                }
                _ => {}
            }
        }

        if summary_text.is_empty() {
            self.consecutive_failures += 1;
            return Ok((messages, None));
        }

        self.consecutive_failures = 0;

        // 将所有消息压缩为一条摘要消息
        let compressed = vec![serde_json::json!({
            "role": "user",
            "content": format!("[对话摘要]\n{}", summary_text)
        })];

        Ok((compressed, Some(summary_text)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── TokenBudget tests ────────────────────────────────────────

    #[test]
    fn test_token_budget_effective_window() {
        let budget = TokenBudget::new(200_000, 8_192);
        assert_eq!(budget.effective_window(), 191_808);

        // 零 max_output 不应下溢
        let budget2 = TokenBudget::new(100_000, 0);
        assert_eq!(budget2.effective_window(), 100_000);

        // max_output > context_window 应返回 0
        let budget3 = TokenBudget::new(1000, 2000);
        assert_eq!(budget3.effective_window(), 0);
    }

    #[test]
    fn test_needs_compact_threshold() {
        let config = ContextConfig::default(); // auto_compact_buffer = 13_000
        let budget = TokenBudget::new(200_000, 8_192); // effective = 191_808
        let mgr = ContextManager::new(config, budget);

        // 191_808 - 13_000 = 178_808 是阈值
        assert!(!mgr.needs_compact(100_000)); // 100k < 178k → 不需要
        assert!(!mgr.needs_compact(178_808)); // 刚好等于 → 不需要
        assert!(mgr.needs_compact(178_809)); // 超过 1 → 需要
        assert!(mgr.needs_compact(190_000)); // 明显超过
    }

    #[test]
    fn test_estimate_text() {
        let budget = TokenBudget::new(200_000, 8_192);
        // 4 字符 ≈ 1 token
        assert_eq!(budget.estimate_text("abcd"), 1);
        assert_eq!(budget.estimate_text("abcdefgh"), 2);
        assert_eq!(budget.estimate_text("abc"), 0); // 不足 4 字符 → 0
        assert_eq!(budget.estimate_text(""), 0);
    }

    // ── trim_old_tool_results tests ──────────────────────────────

    fn make_messages_with_tool_results(count: usize) -> Vec<serde_json::Value> {
        let mut messages = Vec::new();
        for i in 0..count {
            messages.push(serde_json::json!({
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": format!("tool-{}", i),
                        "content": format!("result data {} with some padding", i),
                        "is_error": false
                    }
                ]
            }));
        }
        messages
    }

    #[test]
    fn test_trim_keeps_recent_k_results() {
        let mut messages = make_messages_with_tool_results(5);
        trim_old_tool_results(&mut messages, 3);

        // 最后 3 个应保持原样
        for i in 2..5 {
            let content = messages[i].get("content").unwrap().as_array().unwrap();
            let text = content[0].get("content").unwrap().as_str().unwrap();
            assert!(text.contains(&format!("result data {}", i)));
        }
    }

    #[test]
    fn test_trim_replaces_old_with_marker() {
        let mut messages = make_messages_with_tool_results(5);
        trim_old_tool_results(&mut messages, 3);

        // 前 2 个应被替换为 trimmed marker
        for i in 0..2 {
            let content = messages[i].get("content").unwrap().as_array().unwrap();
            let text = content[0].get("content").unwrap().as_str().unwrap();
            assert!(
                text.contains("[tool_result trimmed:"),
                "entry {} should be trimmed, got: {}",
                i,
                text
            );
        }
    }

    #[test]
    fn test_trim_noop_when_under_keep() {
        let mut messages = make_messages_with_tool_results(2);
        let original = serde_json::to_string(&messages).unwrap();
        trim_old_tool_results(&mut messages, 5); // keep > count
        let after = serde_json::to_string(&messages).unwrap();
        assert_eq!(original, after);
    }

    #[test]
    fn test_trim_preserves_tool_use_id() {
        let mut messages = make_messages_with_tool_results(3);
        trim_old_tool_results(&mut messages, 2);

        // 第一个应被替换，但保留 tool_use_id
        let content = messages[0].get("content").unwrap().as_array().unwrap();
        assert_eq!(content[0].get("tool_use_id").unwrap().as_str().unwrap(), "tool-0");
        assert_eq!(content[0].get("is_error").unwrap().as_bool().unwrap(), false);
    }

    // ── estimate_entries tests ───────────────────────────────────

    #[test]
    fn test_estimate_entries_counts_user_and_assistant() {
        let budget = TokenBudget::new(200_000, 8_192);
        let entries = vec![
            TranscriptEntry::User {
                uuid: "u1".to_string(),
                parent_uuid: None,
                timestamp: "t".to_string(),
                session_id: "s1".to_string(),
                content: vec![crate::models::UserContentBlock::Text {
                    text: "a".repeat(400), // ~100 tokens
                }],
            },
            TranscriptEntry::Assistant {
                uuid: "a1".to_string(),
                parent_uuid: Some("u1".to_string()),
                timestamp: "t".to_string(),
                session_id: "s1".to_string(),
                content: vec![crate::models::AssistantContentBlock::Text {
                    text: "b".repeat(800), // ~200 tokens
                }],
                usage: None,
            },
        ];
        let estimated = budget.estimate_entries(&entries);
        assert_eq!(estimated, 300);
    }

    // ── ContextConfig default ────────────────────────────────────

    #[test]
    fn test_context_config_defaults() {
        let config = ContextConfig::default();
        assert_eq!(config.auto_compact_buffer, 13_000);
        assert_eq!(config.warning_buffer, 20_000);
        assert_eq!(config.hard_limit_buffer, 3_000);
        assert_eq!(config.keep_tool_results, 10);
        assert_eq!(config.compact_max_output_tokens, 20_000);
        assert_eq!(config.max_consecutive_failures, 3);
    }

    // ── deduplicate_tool_results noop ────────────────────────────

    #[test]
    fn test_deduplicate_noop() {
        let mut messages = make_messages_with_tool_results(3);
        let original = serde_json::to_string(&messages).unwrap();
        deduplicate_tool_results(&mut messages);
        let after = serde_json::to_string(&messages).unwrap();
        assert_eq!(original, after);
    }
}
