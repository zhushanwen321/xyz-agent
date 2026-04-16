use crate::engine::llm::types::{ModelEntry, ModelTier, ProviderConfig};
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

    // Extended Thinking
    pub thinking_enabled: bool,
    pub thinking_budget_tokens: u32,
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
            thinking_enabled: false,
            thinking_budget_tokens: 10_000,
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

    Ok(parse_config_toml(&content))
}

/// 用 toml_edit 解析配置文件，与 save_config 使用同一解析库
/// 缺失或无效字段静默保留默认值
fn parse_config_toml(content: &str) -> AgentConfig {
    let mut config = AgentConfig::default();
    let doc = match content.parse::<toml_edit::DocumentMut>() {
        Ok(d) => d,
        Err(_) => return config,
    };

    macro_rules! read_int {
        ($key:expr, $field:ident) => {
            if let Some(v) = doc.get($key).and_then(|v| v.as_integer()) {
                config.$field = v as _;
            }
        };
    }
    macro_rules! read_bool {
        ($key:expr, $field:ident) => {
            if let Some(v) = doc.get($key).and_then(|v| v.as_bool()) {
                config.$field = v;
            }
        };
    }

    read_int!("max_turns", max_turns);
    read_int!("context_window", context_window);
    read_int!("max_output_tokens", max_output_tokens);
    read_int!("auto_compact_buffer", auto_compact_buffer);
    read_int!("warning_buffer", warning_buffer);
    read_int!("hard_limit_buffer", hard_limit_buffer);
    read_int!("keep_tool_results", keep_tool_results);
    read_int!("compact_max_output_tokens", compact_max_output_tokens);
    read_int!("max_consecutive_failures", max_consecutive_failures);
    read_int!("tool_output_max_bytes", tool_output_max_bytes);
    read_int!("bash_default_timeout_secs", bash_default_timeout_secs);
    read_bool!("thinking_enabled", thinking_enabled);
    read_int!("thinking_budget_tokens", thinking_budget_tokens);

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

/// 用 toml_edit 读取指定 key 的字符串值，与 save_config 使用同一解析库
fn read_config_value(key: &str) -> Result<String, ()> {
    let config_path = dirs::home_dir()
        .ok_or(())?
        .join(".xyz-agent")
        .join("config.toml");
    if !config_path.exists() {
        return Err(());
    }
    let content = std::fs::read_to_string(&config_path).map_err(|_| ())?;
    let doc = content.parse::<toml_edit::DocumentMut>().map_err(|_| ())?;
    doc.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or(())
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
    thinking_enabled: bool,
    thinking_budget_tokens: u32,
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
    doc["thinking_enabled"] = toml_edit::value(thinking_enabled);
    doc["thinking_budget_tokens"] = toml_edit::value(thinking_budget_tokens as i64);

    std::fs::write(&config_path, doc.to_string())
        .map_err(|e| AppError::Config(format!("failed to write config: {e}")))?;

    Ok(())
}

// ── 多 Provider 配置 ─────────────────────────────────────────

pub struct ProvidersConfig {
    pub providers: Vec<ProviderConfig>,
    pub default_model: Option<String>,
}

/// 从 toml 内容解析 [[providers]] 和 [[providers.models]]
fn parse_providers_toml(content: &str) -> ProvidersConfig {
    let doc = match content.parse::<toml_edit::DocumentMut>() {
        Ok(d) => d,
        Err(_) => return ProvidersConfig { providers: vec![], default_model: None },
    };

    let default_model = doc.get("default_model")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let mut providers = Vec::new();
    if let Some(arr) = doc.get("providers").and_then(|v| v.as_array_of_tables()) {
        for table in arr.iter() {
            let name = match table.get("name").and_then(|v| v.as_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            let api_key = table.get("api_key")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let base_url = table.get("base_url")
                .and_then(|v| v.as_str())
                .unwrap_or("https://api.anthropic.com")
                .to_string();

            let mut models = Vec::new();
            if let Some(model_arr) = table.get("models").and_then(|v| v.as_array_of_tables()) {
                for mt in model_arr.iter() {
                    let id = match mt.get("id").and_then(|v| v.as_str()) {
                        Some(id) => id.to_string(),
                        None => continue,
                    };
                    let alias = mt.get("alias").and_then(|v| v.as_str()).map(|s| s.to_string());
                    let tier = mt.get("tier").and_then(|v| v.as_str())
                        .and_then(|t| match t {
                            "reasoning" => Some(ModelTier::Reasoning),
                            "fast" => Some(ModelTier::Fast),
                            _ => Some(ModelTier::Balanced),
                        })
                        .unwrap_or_default();
                    models.push(ModelEntry { id, alias, tier });
                }
            }
            providers.push(ProviderConfig { name, api_key, base_url, models });
        }
    }

    ProvidersConfig { providers, default_model }
}

/// 旧格式自动迁移：anthropic_api_key/llm_model/anthropic_base_url → [[providers]]
fn migrate_if_needed(content: &str) -> ProvidersConfig {
    let doc = match content.parse::<toml_edit::DocumentMut>() {
        Ok(d) => d,
        Err(_) => return ProvidersConfig { providers: vec![], default_model: None },
    };

    let has_providers = doc.get("providers").and_then(|v| v.as_array_of_tables())
        .map(|a| !a.is_empty())
        .unwrap_or(false);
    if has_providers {
        return parse_providers_toml(content);
    }

    let api_key = match doc.get("anthropic_api_key").and_then(|v| v.as_str()) {
        Some(k) if !k.is_empty() => k.to_string(),
        _ => return ProvidersConfig { providers: vec![], default_model: None },
    };
    let base_url = doc.get("anthropic_base_url")
        .and_then(|v| v.as_str())
        .unwrap_or("https://api.anthropic.com")
        .to_string();
    let model = doc.get("llm_model")
        .and_then(|v| v.as_str())
        .unwrap_or("claude-sonnet-4-20250514")
        .to_string();

    let default_model = format!("default/{model}");
    ProvidersConfig {
        providers: vec![ProviderConfig {
            name: "default".to_string(),
            api_key,
            base_url,
            models: vec![ModelEntry {
                id: model,
                alias: None,
                tier: ModelTier::Balanced,
            }],
        }],
        default_model: Some(default_model),
    }
}

/// 加载 providers 配置：[[providers]] > 旧格式 > 环境变量
pub fn load_providers() -> ProvidersConfig {
    let config_path = dirs::home_dir()
        .ok_or(())
        .map(|h| h.join(".xyz-agent").join("config.toml"))
        .ok();

    let content = config_path
        .and_then(|p| if p.exists() { std::fs::read_to_string(p).ok() } else { None });

    match content {
        Some(c) => {
            let parsed = parse_providers_toml(&c);
            if !parsed.providers.is_empty() {
                return parsed;
            }
            let migrated = migrate_if_needed(&c);
            if !migrated.providers.is_empty() {
                return migrated;
            }
            ProvidersConfig { providers: vec![], default_model: None }
        }
        None => {
            // fallback 到环境变量
            let api_key = std::env::var("ANTHROPIC_API_KEY").ok();
            match api_key {
                Some(key) => {
                    let base_url = std::env::var("ANTHROPIC_BASE_URL")
                        .unwrap_or_else(|_| "https://api.anthropic.com".to_string());
                    let model = std::env::var("LLM_MODEL")
                        .unwrap_or_else(|_| "claude-sonnet-4-20250514".to_string());
                    ProvidersConfig {
                        providers: vec![ProviderConfig {
                            name: "env".to_string(),
                            api_key: key,
                            base_url,
                            models: vec![ModelEntry {
                                id: model.clone(),
                                alias: None,
                                tier: ModelTier::Balanced,
                            }],
                        }],
                        default_model: Some(format!("env/{model}")),
                    }
                }
                None => ProvidersConfig { providers: vec![], default_model: None },
            }
        }
    }
}

/// 保存单个 Provider 到 config.toml（按 name 匹配更新或追加）
///
/// 策略：解析现有 providers → 内存中合并 → 移除旧 providers 部分 → 文本拼接新 providers
/// 避免 toml_edit 对嵌套 [[providers.models]] 的 API 限制
pub fn save_provider_config(new_config: &ProviderConfig, _agent_config: &AgentConfig) -> Result<(), AppError> {
    let config_path = dirs::home_dir()
        .ok_or(AppError::Config("no home dir".into()))?
        .join(".xyz-agent")
        .join("config.toml");

    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::Config(format!("failed to create dir: {e}")))?;
    }

    let existing = if config_path.exists() {
        std::fs::read_to_string(&config_path)
            .map_err(|e| AppError::Config(format!("failed to read: {e}")))?
    } else {
        String::new()
    };

    // 合并：更新同名 provider 或追加
    let mut providers = parse_providers_toml(&existing).providers;
    let mut found = false;
    for p in &mut providers {
        if p.name == new_config.name {
            *p = new_config.clone();
            found = true;
            break;
        }
    }
    if !found {
        providers.push(new_config.clone());
    }

    // 从文档中移除旧 providers（保留其余字段），再拼接新 providers 文本
    let mut doc = match existing.parse::<toml_edit::DocumentMut>() {
        Ok(d) => d,
        Err(_) => toml_edit::DocumentMut::new(),
    };
    doc.remove("providers");
    let base = doc.to_string();

    let mut out = base;
    for p in &providers {
        out.push_str(&format!("\n[[providers]]\n"));
        out.push_str(&format!("name = \"{}\"\n", p.name));
        out.push_str(&format!("api_key = \"{}\"\n", p.api_key));
        out.push_str(&format!("base_url = \"{}\"\n", p.base_url));
        for m in &p.models {
            out.push_str("\n[[providers.models]]\n");
            out.push_str(&format!("id = \"{}\"\n", m.id));
            if let Some(ref alias) = m.alias {
                out.push_str(&format!("alias = \"{}\"\n", alias));
            }
            let tier_str = match m.tier {
                ModelTier::Balanced => "balanced",
                ModelTier::Reasoning => "reasoning",
                ModelTier::Fast => "fast",
            };
            out.push_str(&format!("tier = \"{}\"\n", tier_str));
        }
    }

    std::fs::write(&config_path, out)
        .map_err(|e| AppError::Config(format!("failed to write config: {e}")))?;
    Ok(())
}

/// 删除指定 Provider
pub fn delete_provider(provider_name: &str) -> Result<(), AppError> {
    let config_path = dirs::home_dir()
        .ok_or(AppError::Config("no home dir".into()))?
        .join(".xyz-agent")
        .join("config.toml");

    if !config_path.exists() {
        return Err(AppError::Config("config.toml not found".into()));
    }

    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| AppError::Config(format!("failed to read: {e}")))?;
    let mut doc = content.parse::<toml_edit::DocumentMut>()
        .map_err(|e| AppError::Config(format!("failed to parse: {e}")))?;

    if let Some(arr) = doc.get_mut("providers").and_then(|v| v.as_array_of_tables_mut()) {
        let mut to_remove = None;
        for (i, table) in arr.iter().enumerate() {
            if table.get("name").and_then(|v| v.as_str()) == Some(provider_name) {
                to_remove = Some(i);
                break;
            }
        }
        if let Some(idx) = to_remove {
            arr.remove(idx);
        }
    }

    std::fs::write(&config_path, doc.to_string())
        .map_err(|e| AppError::Config(format!("failed to write config: {e}")))?;

    Ok(())
}

/// 更新 default_model 字段
pub fn save_default_model(model_ref: &str) -> Result<(), AppError> {
    let config_path = dirs::home_dir()
        .ok_or(AppError::Config("no home dir".into()))?
        .join(".xyz-agent")
        .join("config.toml");

    let mut doc = if config_path.exists() {
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| AppError::Config(format!("failed to read: {e}")))?;
        content.parse::<toml_edit::DocumentMut>()
            .map_err(|e| AppError::Config(format!("failed to parse: {e}")))?
    } else {
        toml_edit::DocumentMut::new()
    };

    doc["default_model"] = toml_edit::value(model_ref);

    std::fs::write(&config_path, doc.to_string())
        .map_err(|e| AppError::Config(format!("failed to write config: {e}")))?;

    Ok(())
}

#[cfg(test)]
#[path = "config_tests.rs"]
mod tests;
