use serde_json::Value;

/// 动态上下文：注入到系统提示词的环境信息
pub struct DynamicContext {
    pub cwd: String,
    pub os: String,
    pub model: String,
    pub git_branch: Option<String>,
    pub tool_names: Vec<String>,
    pub data_context_summary: Option<String>,
    pub conversation_summary: Option<String>,
}

pub struct PromptManager {
    static_prompt: String,
}

impl PromptManager {
    pub fn new() -> Self {
        Self {
            static_prompt: include_str!("../prompts/system_static.md").to_string(),
        }
    }

    /// 构建完整的系统提示词（静态层 + 动态层）
    /// 静态层带 cache_control 以利用 Anthropic Prompt Cache
    pub fn build_system_prompt(&self, ctx: &DynamicContext) -> Vec<Value> {
        let mut blocks = Vec::new();

        // 静态层（可缓存）
        blocks.push(serde_json::json!({
            "type": "text",
            "text": self.static_prompt,
            "cache_control": { "type": "ephemeral" }
        }));

        // 动态层（不可缓存）
        let dynamic = self.render_dynamic(ctx);
        if !dynamic.is_empty() {
            blocks.push(serde_json::json!({
                "type": "text",
                "text": dynamic,
            }));
        }

        blocks
    }

    fn render_dynamic(&self, ctx: &DynamicContext) -> String {
        let mut parts = Vec::new();

        // 环境信息（始终存在）
        let mut env = format!(
            "## 环境\n- 操作系统: {}\n- 当前目录: {}\n- 模型: {}",
            ctx.os, ctx.cwd, ctx.model
        );
        if let Some(branch) = &ctx.git_branch {
            env.push_str(&format!("\n- Git 分支: {branch}"));
        }
        parts.push(env);

        // 可用工具列表
        if !ctx.tool_names.is_empty() {
            parts.push(format!("## 可用工具\n{}", ctx.tool_names.join(", ")));
        }

        // DataContext 摘要
        if let Some(summary) = &ctx.data_context_summary {
            parts.push(format!("## 已读取文件\n{summary}"));
        }

        // 对话摘要
        if let Some(summary) = &ctx.conversation_summary {
            parts.push(format!("## 对话历史摘要\n{summary}"));
        }

        parts.join("\n\n")
    }
}

impl Default for PromptManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_ctx() -> DynamicContext {
        DynamicContext {
            cwd: "/home/user/project".to_string(),
            os: "linux".to_string(),
            model: "claude-sonnet-4-20250514".to_string(),
            git_branch: None,
            tool_names: vec![],
            data_context_summary: None,
            conversation_summary: None,
        }
    }

    #[test]
    fn test_static_prompt_includes_cache_control() {
        let pm = PromptManager::new();
        let ctx = default_ctx();
        let blocks = pm.build_system_prompt(&ctx);

        // 第一个 block 是静态层，应包含 cache_control
        assert_eq!(blocks.len(), 2);
        let static_block = &blocks[0];
        assert_eq!(static_block["type"], "text");
        assert!(static_block["text"].as_str().unwrap().contains("xyz-agent"));
        assert_eq!(
            static_block["cache_control"]["type"],
            "ephemeral"
        );

        // 第二个 block 是动态层，不应有 cache_control
        let dynamic_block = &blocks[1];
        assert_eq!(dynamic_block["type"], "text");
        assert!(dynamic_block.get("cache_control").is_none());
    }

    #[test]
    fn test_dynamic_renders_environment() {
        let pm = PromptManager::new();
        let ctx = default_ctx();
        let blocks = pm.build_system_prompt(&ctx);

        let dynamic_text = blocks[1]["text"].as_str().unwrap();
        assert!(dynamic_text.contains("linux"));
        assert!(dynamic_text.contains("/home/user/project"));
        assert!(dynamic_text.contains("claude-sonnet-4-20250514"));
    }

    #[test]
    fn test_dynamic_renders_conversation_summary() {
        let pm = PromptManager::new();
        let ctx = DynamicContext {
            conversation_summary: Some("用户之前问了关于 Rust 异步的问题".to_string()),
            ..default_ctx()
        };
        let blocks = pm.build_system_prompt(&ctx);

        let dynamic_text = blocks[1]["text"].as_str().unwrap();
        assert!(dynamic_text.contains("对话历史摘要"));
        assert!(dynamic_text.contains("用户之前问了关于 Rust 异步的问题"));
    }

    #[test]
    fn test_dynamic_empty_when_no_context() {
        let pm = PromptManager::new();
        let ctx = default_ctx();
        let blocks = pm.build_system_prompt(&ctx);

        // 即使所有可选字段为空，动态层仍然有环境信息
        assert_eq!(blocks.len(), 2);
        let dynamic_text = blocks[1]["text"].as_str().unwrap();
        assert!(dynamic_text.contains("## 环境"));
        assert!(!dynamic_text.contains("可用工具"));
        assert!(!dynamic_text.contains("已读取文件"));
        assert!(!dynamic_text.contains("对话历史摘要"));
    }
}
