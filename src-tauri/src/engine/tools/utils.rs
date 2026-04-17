//! dispatch_agent 和 orchestrate 共享的工具函数

use crate::engine::context::prompt::DynamicContext;
use crate::types::transcript::{AssistantContentBlock, TranscriptEntry};

/// 从 transcript entries 中提取助手纯文本
pub fn extract_assistant_text(entries: &[TranscriptEntry]) -> String {
    entries
        .iter()
        .filter_map(|e| match e {
            TranscriptEntry::Assistant { content, .. } => Some(
                content
                    .iter()
                    .filter_map(|b| match b {
                        AssistantContentBlock::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
            ),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 构建 dispatch/orchestrate 工具通用的 DynamicContext
pub fn build_tool_dynamic_context(tool_names: Vec<String>) -> DynamicContext {
    DynamicContext {
        cwd: std::env::current_dir()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string(),
        os: std::env::consts::OS.to_string(),
        model: String::new(),
        git_branch: None,
        tool_names,
        data_context_summary: None,
        conversation_summary: None,
        disabled_tools: vec![],
    }
}
