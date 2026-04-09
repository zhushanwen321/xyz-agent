use crate::error::AppError;

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
}
