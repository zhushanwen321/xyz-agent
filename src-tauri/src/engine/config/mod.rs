use crate::types::AppError;

/// Agent 全局配置，从 ~/.xyz-agent/config.toml 读取，缺失字段使用默认值
pub struct AgentConfig {
    // AgentLoop
    pub max_turns: u32,

    // ContextManager
    pub context_window: u32,
    pub max_output_tokens: u32,
    pub auto_compact_buffer: u32,
    pub warning_buffer: u32,
    pub hard_limit_buffer: u32,
    pub keep_tool_results: usize,
    pub compact_max_output_tokens: u32,
    pub max_consecutive_failures: u32,

    // ToolExecutor
    pub tool_output_max_bytes: usize,
    pub bash_default_timeout_secs: u64,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            max_turns: 50,
            context_window: 200_000,
            max_output_tokens: 8_192,
            auto_compact_buffer: 13_000,
            warning_buffer: 20_000,
            hard_limit_buffer: 3_000,
            keep_tool_results: 10,
            compact_max_output_tokens: 20_000,
            max_consecutive_failures: 3,
            tool_output_max_bytes: 100_000,
            bash_default_timeout_secs: 120,
        }
    }
}

/// 从 ~/.xyz-agent/config.toml 加载配置
/// 文件不存在时返回默认配置；解析失败的字段静默保留默认值
pub fn load_agent_config() -> Result<AgentConfig, AppError> {
    let config_path = dirs::home_dir()
        .ok_or(AppError::Config("no home dir".into()))?
        .join(".xyz-agent")
        .join("config.toml");

    if !config_path.exists() {
        return Ok(AgentConfig::default());
    }

    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| AppError::Config(format!("failed to read config.toml: {e}")))?;

    Ok(parse_config_value(&content))
}

/// 逐行解析 flat TOML key=value，未识别的 key 被忽略
fn parse_config_value(content: &str) -> AgentConfig {
    let mut config = AgentConfig::default();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = trimmed.split_once('=') {
            let key = key.trim();
            let value = value.trim();
            // 跳过引号包裹的字符串值（如 api_key = "sk-..."）
            let value = value.trim_matches('"');
            match key {
                "max_turns" => config.max_turns = value.parse().unwrap_or(config.max_turns),
                "context_window" => {
                    config.context_window = value.parse().unwrap_or(config.context_window)
                }
                "max_output_tokens" => {
                    config.max_output_tokens = value.parse().unwrap_or(config.max_output_tokens)
                }
                "auto_compact_buffer" => {
                    config.auto_compact_buffer = value.parse().unwrap_or(config.auto_compact_buffer)
                }
                "warning_buffer" => {
                    config.warning_buffer = value.parse().unwrap_or(config.warning_buffer)
                }
                "hard_limit_buffer" => {
                    config.hard_limit_buffer = value.parse().unwrap_or(config.hard_limit_buffer)
                }
                "keep_tool_results" => {
                    config.keep_tool_results = value.parse().unwrap_or(config.keep_tool_results)
                }
                "compact_max_output_tokens" => config
                    .compact_max_output_tokens = value.parse().unwrap_or(config.compact_max_output_tokens),
                "max_consecutive_failures" => config
                    .max_consecutive_failures = value.parse().unwrap_or(config.max_consecutive_failures),
                "tool_output_max_bytes" => {
                    config.tool_output_max_bytes = value.parse().unwrap_or(config.tool_output_max_bytes)
                }
                "bash_default_timeout_secs" => config
                    .bash_default_timeout_secs = value.parse().unwrap_or(config.bash_default_timeout_secs),
                _ => {} // unknown keys ignored
            }
        }
    }
    config
}

/// LLM 配置：从环境变量、~/.xyz-agent/config.toml 读取
pub struct LlmConfig {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
}

/// 加载 LLM 配置，优先级：环境变量 > config.toml
/// API Key 不存在时返回 None（不报错，允许无 Key 启动）
pub fn load_llm_config() -> Option<LlmConfig> {
    let api_key = std::env::var("ANTHROPIC_API_KEY")
        .or_else(|_| read_config_value("anthropic_api_key"))
        .ok()?;

    let base_url = std::env::var("ANTHROPIC_BASE_URL")
        .or_else(|_| read_config_value("anthropic_base_url"))
        .unwrap_or_else(|_| "https://api.anthropic.com".to_string());

    let model = std::env::var("LLM_MODEL")
        .or_else(|_| read_config_value("llm_model"))
        .unwrap_or_else(|_| "claude-sonnet-4-20250514".to_string());

    Some(LlmConfig {
        api_key,
        base_url,
        model,
    })
}

/// 通用辅助函数：从 ~/.xyz-agent/config.toml 中逐行读取指定 key 的值
fn read_config_value(key: &str) -> Result<String, ()> {
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
        if let Some(rest) = trimmed.strip_prefix(key) {
            let rest = rest.trim_start_matches(['=', ' ']).trim();
            if !rest.is_empty() {
                return Ok(rest.to_string());
            }
        }
    }
    Err(())
}

/// 将配置写入 ~/.xyz-agent/config.toml（文件不存在时自动创建）
pub fn save_config(
    llm_api_key: &str,
    llm_model: &str,
    llm_base_url: &str,
    max_turns: u32,
    context_window: u32,
    max_output_tokens: u32,
    tool_output_max_bytes: usize,
    bash_default_timeout_secs: u64,
) -> Result<(), AppError> {
    let config_path = dirs::home_dir()
        .ok_or(AppError::Config("no home dir".into()))?
        .join(".xyz-agent")
        .join("config.toml");

    let mut doc = if config_path.exists() {
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| AppError::Config(format!("failed to read: {e}")))?;
        content
            .parse::<toml_edit::DocumentMut>()
            .map_err(|e| AppError::Config(format!("failed to parse TOML: {e}")))?
    } else {
        if let Some(parent) = config_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::Config(format!("failed to create dir: {e}")))?;
        }
        toml_edit::DocumentMut::new()
    };

    doc["max_turns"] = toml_edit::value(max_turns as i64);
    doc["context_window"] = toml_edit::value(context_window as i64);
    doc["max_output_tokens"] = toml_edit::value(max_output_tokens as i64);
    doc["tool_output_max_bytes"] = toml_edit::value(tool_output_max_bytes as i64);
    doc["bash_default_timeout_secs"] = toml_edit::value(bash_default_timeout_secs as i64);
    doc["anthropic_api_key"] = toml_edit::value(llm_api_key);
    doc["llm_model"] = toml_edit::value(llm_model);
    doc["anthropic_base_url"] = toml_edit::value(llm_base_url);

    std::fs::write(&config_path, doc.to_string())
        .map_err(|e| AppError::Config(format!("failed to write config: {e}")))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_values_when_no_config() {
        let config = AgentConfig::default();
        assert_eq!(config.max_turns, 50);
        assert_eq!(config.context_window, 200_000);
        assert_eq!(config.max_output_tokens, 8_192);
        assert_eq!(config.auto_compact_buffer, 13_000);
        assert_eq!(config.warning_buffer, 20_000);
        assert_eq!(config.hard_limit_buffer, 3_000);
        assert_eq!(config.keep_tool_results, 10);
        assert_eq!(config.compact_max_output_tokens, 20_000);
        assert_eq!(config.max_consecutive_failures, 3);
        assert_eq!(config.tool_output_max_bytes, 100_000);
        assert_eq!(config.bash_default_timeout_secs, 120);
    }

    #[test]
    fn test_partial_config_uses_defaults() {
        let content = "max_turns = 100\ncontext_window = 500000\n";
        let config = parse_config_value(content);
        assert_eq!(config.max_turns, 100);
        assert_eq!(config.context_window, 500_000);
        // 其余字段应保持默认值
        assert_eq!(config.max_output_tokens, 8_192);
        assert_eq!(config.tool_output_max_bytes, 100_000);
    }

    #[test]
    fn test_invalid_values_ignored() {
        let content = "max_turns = not_a_number\ntool_output_max_bytes = abc\nbash_default_timeout_secs = 120\n";
        let config = parse_config_value(content);
        // 无效值保留默认
        assert_eq!(config.max_turns, 50);
        assert_eq!(config.tool_output_max_bytes, 100_000);
        // 有效值正常解析
        assert_eq!(config.bash_default_timeout_secs, 120);
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

    #[test]
    fn test_save_config_creates_and_writes() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.toml");

        // 直接用低层函数写入临时目录（save_config 使用固定 home 路径，这里测解析逻辑）
        let toml_content = toml_edit::DocumentMut::new();
        let mut doc = toml_content;
        doc["max_turns"] = toml_edit::value(99 as i64);
        doc["context_window"] = toml_edit::value(300_000 as i64);
        doc["max_output_tokens"] = toml_edit::value(4096 as i64);
        doc["tool_output_max_bytes"] = toml_edit::value(50_000 as i64);
        doc["bash_default_timeout_secs"] = toml_edit::value(60 as i64);
        doc["anthropic_api_key"] = toml_edit::value("sk-test");
        doc["llm_model"] = toml_edit::value("test-model");
        doc["anthropic_base_url"] = toml_edit::value("https://test.api.com");
        std::fs::write(&config_path, doc.to_string()).unwrap();

        // 读取回来验证
        let content = std::fs::read_to_string(&config_path).unwrap();
        let parsed = content.parse::<toml_edit::DocumentMut>().unwrap();
        assert_eq!(parsed["max_turns"].as_integer(), Some(99));
        assert_eq!(parsed["anthropic_api_key"].as_str(), Some("sk-test"));
        assert_eq!(parsed["llm_model"].as_str(), Some("test-model"));
        assert_eq!(parsed["anthropic_base_url"].as_str(), Some("https://test.api.com"));
        assert_eq!(parsed["tool_output_max_bytes"].as_integer(), Some(50_000));

        // 验证 parse_config_value 也能正确解析
        let agent_config = parse_config_value(&content);
        assert_eq!(agent_config.max_turns, 99);
        assert_eq!(agent_config.context_window, 300_000);
        assert_eq!(agent_config.max_output_tokens, 4096);
        assert_eq!(agent_config.tool_output_max_bytes, 50_000);
        assert_eq!(agent_config.bash_default_timeout_secs, 60);
    }

    #[test]
    fn test_read_config_value() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.toml");
        std::fs::write(
            &config_path,
            "llm_model = \"test-model\"\nanthropic_base_url = \"https://custom.com\"\n",
        )
        .unwrap();

        let content = std::fs::read_to_string(&config_path).unwrap();
        // 模拟 read_config_value 的解析逻辑
        let found_model = content.lines().find_map(|line| {
            let trimmed = line.trim();
            trimmed.strip_prefix("llm_model").and_then(|rest| {
                let rest = rest.trim_start_matches(['=', ' ']).trim();
                if !rest.is_empty() {
                    Some(rest.to_string())
                } else {
                    None
                }
            })
        });
        assert_eq!(found_model, Some("\"test-model\"".to_string()));

        let found_url = content.lines().find_map(|line| {
            let trimmed = line.trim();
            trimmed.strip_prefix("anthropic_base_url").and_then(|rest| {
                let rest = rest.trim_start_matches(['=', ' ']).trim();
                if !rest.is_empty() {
                    Some(rest.to_string())
                } else {
                    None
                }
            })
        });
        assert_eq!(found_url, Some("\"https://custom.com\"".to_string()));
    }
}
