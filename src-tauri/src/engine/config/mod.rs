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

/// LLM 配置：从 .env 文件、环境变量、~/.xyz-agent/config.toml 读取
pub struct LlmConfig {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
}

/// 加载 LLM 配置，优先级：环境变量 > .env 文件 > config.toml
pub fn load_llm_config() -> Result<LlmConfig, AppError> {
    let _ = dotenvy::dotenv();

    let api_key = std::env::var("ANTHROPIC_API_KEY")
        .or_else(|_| read_api_key_from_config_file())
        .map_err(|_| {
            AppError::Config(
                "ANTHROPIC_API_KEY not found in .env, env, or ~/.xyz-agent/config.toml"
                    .to_string(),
            )
        })?;

    let base_url = std::env::var("ANTHROPIC_BASE_URL")
        .unwrap_or_else(|_| "https://api.anthropic.com".to_string());

    let model =
        std::env::var("LLM_MODEL").unwrap_or_else(|_| "claude-sonnet-4-20250514".to_string());

    Ok(LlmConfig {
        api_key,
        base_url,
        model,
    })
}

fn read_api_key_from_config_file() -> Result<String, ()> {
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
        if let Some(key) = trimmed.strip_prefix("anthropic_api_key") {
            let key = key.trim_start_matches(['=', ' ']).trim();
            if !key.is_empty() {
                return Ok(key.to_string());
            }
        }
    }

    Err(())
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
}
