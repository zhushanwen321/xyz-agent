use serde_json::Value;

use super::prompt_registry::PromptRegistry;

/// 动态上下文：注入到系统提示词的环境信息
#[derive(Clone)]
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
    registry: PromptRegistry,
    default_key: String,
}

impl PromptManager {
    pub fn new() -> Self {
        Self {
            registry: PromptRegistry::new(),
            default_key: "system".to_string(),
        }
    }

    /// 加载用户自定义 prompt 文件
    pub fn with_user_prompts(mut self, data_dir: &std::path::Path) -> Self {
        self.registry.load_user_prompts(data_dir);
        self
    }

    /// 设置默认 prompt key（如 "explore", "plan", "general_purpose"）
    pub fn with_key(mut self, key: &str) -> Self {
        self.default_key = key.to_string();
        self
    }

    /// Fork 模式需要 byte-identical system prompt 以命中 Prompt Cache
    #[allow(dead_code)]
    pub fn new_with_prompt(static_prompt: &str) -> Self {
        let mut registry = PromptRegistry::new();
        registry.insert_override("system", static_prompt);
        Self {
            registry,
            default_key: "system".to_string(),
        }
    }

    /// 构建完整的系统提示词（静态层 + 动态层）
    /// 静态层带 cache_control 以利用 Anthropic Prompt Cache
    /// enhance 内容拼接到 builtin 同一 block 内，保持 cache_control 有效性
    pub fn build_system_prompt(&self, ctx: &DynamicContext) -> Vec<Value> {
        let mut blocks = Vec::new();

        // 静态层（可缓存）— builtin + enhance 拼接在同一 block
        let mut static_text = self
            .registry
            .resolve(&self.default_key)
            .unwrap_or_default()
            .to_string();

        // enhance 内容拼接到 builtin 末尾
        for enhance in self.registry.resolve_enhances(&self.default_key) {
            static_text.push_str("\n\n");
            static_text.push_str(enhance);
        }

        blocks.push(serde_json::json!({
            "type": "text",
            "text": static_text,
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

    #[test]
    fn test_with_key_uses_different_prompt() {
        let pm = PromptManager::new().with_key("explore");
        let ctx = default_ctx();
        let blocks = pm.build_system_prompt(&ctx);
        let text = blocks[0]["text"].as_str().unwrap();
        assert!(text.contains("代码探索 Agent"));
        assert!(!text.contains("xyz-agent 编码助手"));
    }

    #[test]
    fn test_new_with_prompt_overrides_system() {
        let pm = PromptManager::new_with_prompt("custom prompt");
        let ctx = default_ctx();
        let blocks = pm.build_system_prompt(&ctx);
        let text = blocks[0]["text"].as_str().unwrap();
        assert_eq!(text, "custom prompt");
    }

    #[test]
    fn test_user_prompts_enhance_appended_to_static_block() {
        let dir = tempfile::tempdir().unwrap();
        let prompts_dir = dir.path().join("prompts");
        std::fs::create_dir_all(&prompts_dir).unwrap();
        std::fs::write(prompts_dir.join("enhance_system.md"), "extra rules").unwrap();

        let pm = PromptManager::new().with_user_prompts(dir.path());
        let ctx = default_ctx();
        let blocks = pm.build_system_prompt(&ctx);
        let text = blocks[0]["text"].as_str().unwrap();
        assert!(text.contains("xyz-agent 编码助手"));
        assert!(text.contains("extra rules"));
        // enhance 和 builtin 在同一个 block，cache_control 有效
        assert_eq!(
            blocks[0]["cache_control"]["type"],
            "ephemeral"
        );
    }
}
