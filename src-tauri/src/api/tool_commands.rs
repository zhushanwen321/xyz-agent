use crate::api::AppState;
use serde::Deserialize;
use tauri::State;

// ── 数据结构 ──────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct ToolInfo {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
    pub is_concurrent_safe: bool,
    pub timeout_secs: u64,
    pub danger_level: String,
    pub enabled: bool,
    pub has_override: bool,
}

#[derive(Deserialize)]
pub struct ToolConfigSaveRequest {
    pub name: String,
    pub description: Option<String>,
    pub timeout_secs: Option<u64>,
    pub enabled: Option<bool>,
}

// ── TOML 解析（逐行，与 parse_agent_meta 模式一致） ──

struct ToolTomlOverride {
    description: Option<String>,
    timeout_secs: Option<u64>,
    enabled: Option<bool>,
}

fn parse_tool_config_toml(content: &str) -> ToolTomlOverride {
    let mut result = ToolTomlOverride {
        description: None,
        timeout_secs: None,
        enabled: None,
    };
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("description = ") {
            result.description = Some(rest.trim().trim_matches('"').to_string());
        } else if let Some(rest) = trimmed.strip_prefix("timeout_secs = ") {
            result.timeout_secs = rest.trim().parse().ok();
        } else if let Some(rest) = trimmed.strip_prefix("enabled = ") {
            result.enabled = (rest.trim() == "true").then_some(true).or(Some(false));
            // enabled = true/false 是明确的布尔值
        }
    }
    result
}

// ── Commands ──────────────────────────────────────────────

#[tauri::command]
pub async fn tool_config_list(state: State<'_, AppState>) -> Result<Vec<ToolInfo>, String> {
    let tools_dir = state.data_dir.join("prompts").join("tools");
    let names = state.tool_registry.tool_names();
    let mut result = Vec::with_capacity(names.len());

    for name in &names {
        let tool = state
            .tool_registry
            .get(name)
            .ok_or_else(|| format!("tool '{}' not found in registry", name))?;

        let toml_path = tools_dir.join(format!("{name}.toml"));
        let has_override = toml_path.exists();
        let mut enabled = true;

        if has_override {
            if let Ok(content) = std::fs::read_to_string(&toml_path) {
                let override_ = parse_tool_config_toml(&content);
                if let Some(e) = override_.enabled {
                    enabled = e;
                }
            }
        }

        result.push(ToolInfo {
            name: name.clone(),
            description: tool.description().to_string(),
            input_schema: tool.input_schema(),
            is_concurrent_safe: tool.is_concurrent_safe(),
            timeout_secs: tool.timeout_secs(),
            danger_level: tool.danger_level().to_string(),
            enabled,
            has_override,
        });
    }

    Ok(result)
}

#[tauri::command]
pub async fn tool_config_save(
    payload: ToolConfigSaveRequest,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // 校验：name 必须在 registry 中
    if state.tool_registry.get(&payload.name).is_none() {
        return Err(format!("tool '{}' not found in registry", payload.name));
    }

    // 校验：timeout 范围 1-600
    if let Some(timeout) = payload.timeout_secs {
        if timeout < 1 || timeout > 600 {
            return Err(format!("timeout_secs must be between 1 and 600, got {timeout}"));
        }
    }

    // 校验：description 最长 1000
    if let Some(ref desc) = payload.description {
        if desc.len() > 1000 {
            return Err(format!("description must be <= 1000 chars, got {}", desc.len()));
        }
    }

    let tools_dir = state.data_dir.join("prompts").join("tools");
    std::fs::create_dir_all(&tools_dir)
        .map_err(|e| format!("failed to create tools dir: {e}"))?;

    // 读取已有 toml（如果存在），合并写入
    let toml_path = tools_dir.join(format!("{}.toml", payload.name));
    let mut doc = if toml_path.exists() {
        let content = std::fs::read_to_string(&toml_path)
            .map_err(|e| format!("failed to read existing config: {e}"))?;
        content.parse::<toml_edit::DocumentMut>()
            .map_err(|e| format!("failed to parse existing config: {e}"))?
    } else {
        toml_edit::DocumentMut::new()
    };

    // 只写非 None 的字段
    if let Some(ref desc) = payload.description {
        doc["description"] = toml_edit::value(desc.as_str());
    }
    if let Some(timeout) = payload.timeout_secs {
        doc["timeout_secs"] = toml_edit::value(timeout as i64);
    }
    if let Some(enabled) = payload.enabled {
        doc["enabled"] = toml_edit::value(enabled);
    }

    std::fs::write(&toml_path, doc.to_string())
        .map_err(|e| format!("failed to write tool config: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn tool_config_delete(
    name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let tools_dir = state.data_dir.join("prompts").join("tools");
    let toml_path = tools_dir.join(format!("{name}.toml"));
    if !toml_path.exists() {
        return Err(format!("no override config found for tool '{}'", name));
    }
    std::fs::remove_file(&toml_path)
        .map_err(|e| format!("failed to delete tool config: {e}"))?;
    Ok(())
}

// ── 加载 disabled_tools（供 DynamicContext 使用） ──

pub(crate) fn load_disabled_tools(data_dir: &std::path::Path) -> Vec<String> {
    let tools_dir = data_dir.join("prompts").join("tools");
    if !tools_dir.is_dir() {
        return vec![];
    }
    let mut disabled = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&tools_dir) {
        for entry in rd.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if let Some(tool_name) = name_str.strip_suffix(".toml") {
                if let Ok(content) = std::fs::read_to_string(entry.path()) {
                    for line in content.lines() {
                        let trimmed = line.trim();
                        if let Some(rest) = trimmed.strip_prefix("enabled = ") {
                            if rest.trim() == "false" {
                                disabled.push(tool_name.to_string());
                            }
                            break;
                        }
                    }
                }
            }
        }
    }
    disabled
}

// ── Tests ──────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn load_disabled_tools_returns_empty_when_no_dir() {
        let dir = tempfile::tempdir().unwrap();
        let result = load_disabled_tools(dir.path());
        assert!(result.is_empty());
    }

    #[test]
    fn load_disabled_tools_finds_disabled_tools() {
        let dir = tempfile::tempdir().unwrap();
        let tools_dir = dir.path().join("prompts").join("tools");
        std::fs::create_dir_all(&tools_dir).unwrap();

        // 写入两个工具配置，一个 disabled，一个 enabled
        let mut f1 = std::fs::File::create(tools_dir.join("bash.toml")).unwrap();
        writeln!(f1, "enabled = false").unwrap();

        let mut f2 = std::fs::File::create(tools_dir.join("read.toml")).unwrap();
        writeln!(f2, "enabled = true").unwrap();

        let result = load_disabled_tools(dir.path());
        assert_eq!(result, vec!["bash".to_string()]);
    }

    #[test]
    fn parse_tool_config_toml_all_fields() {
        let content = r#"
description = "custom desc"
timeout_secs = 120
enabled = false
"#;
        let parsed = parse_tool_config_toml(content);
        assert_eq!(parsed.description, Some("custom desc".to_string()));
        assert_eq!(parsed.timeout_secs, Some(120));
        assert_eq!(parsed.enabled, Some(false));
    }

    #[test]
    fn parse_tool_config_toml_partial_fields() {
        let content = r#"
description = "only desc"
"#;
        let parsed = parse_tool_config_toml(content);
        assert_eq!(parsed.description, Some("only desc".to_string()));
        assert!(parsed.timeout_secs.is_none());
        assert!(parsed.enabled.is_none());
    }

    #[test]
    fn parse_tool_config_toml_empty() {
        let parsed = parse_tool_config_toml("");
        assert!(parsed.description.is_none());
        assert!(parsed.timeout_secs.is_none());
        assert!(parsed.enabled.is_none());
    }

    #[test]
    fn load_disabled_tools_ignores_non_toml_files() {
        let dir = tempfile::tempdir().unwrap();
        let tools_dir = dir.path().join("prompts").join("tools");
        std::fs::create_dir_all(&tools_dir).unwrap();

        let mut f = std::fs::File::create(tools_dir.join("notes.txt")).unwrap();
        writeln!(f, "enabled = false").unwrap();

        let result = load_disabled_tools(dir.path());
        assert!(result.is_empty());
    }
}
