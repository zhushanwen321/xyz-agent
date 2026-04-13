use crate::api::AppState;
use crate::engine::context::prompt_registry::{PromptMode, PromptRegistry};
use serde::Deserialize;
use tauri::State;

// ── Prompt 管理数据结构 ──────────────────────────────────────

#[derive(serde::Serialize)]
pub struct PromptInfo {
    pub key: String,
    /// "builtin" | "enhance" | "override" | "custom"
    pub mode: String,
    pub content: String,
    pub has_enhance: bool,
    pub has_override: bool,
    pub tools: Vec<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub max_tokens: u32,
    #[serde(default)]
    pub max_turns: u32,
    #[serde(default)]
    pub max_tool_calls: u32,
}

#[derive(Deserialize)]
pub struct PromptSaveRequest {
    pub key: String,
    /// "enhance" | "override"
    pub mode: String,
    pub content: String,
}

#[derive(Deserialize)]
pub struct CustomAgentSaveRequest {
    pub name: String,
    pub content: String,
    pub tools: Vec<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    #[serde(default = "default_max_turns")]
    pub max_turns: u32,
    #[serde(default = "default_max_tool_calls")]
    pub max_tool_calls: u32,
}

fn default_max_tokens() -> u32 { 100_000 }
fn default_max_turns() -> u32 { 30 }
fn default_max_tool_calls() -> u32 { 100 }

// ── Prompt 管理 Commands ──────────────────────────────────────

#[tauri::command]
pub async fn prompt_list(state: State<'_, AppState>) -> Result<Vec<PromptInfo>, String> {
    let registry = state.prompt_registry.read().map_err(|e| e.to_string())?;

    let builtin_keys = ["system", "explore", "plan", "general_purpose"];
    let mut result = Vec::new();

    for key in &builtin_keys {
        let entries = registry.entries_for(key);
        let has_enhance = entries.iter().any(|e| e.mode == PromptMode::Enhance);
        let has_override = entries.iter().any(|e| e.mode == PromptMode::Override);
        let mode = if has_override {
            "override"
        } else if has_enhance {
            "enhance"
        } else {
            "builtin"
        };
        let content = registry.resolve(key).unwrap_or_default().to_string();
        result.push(PromptInfo {
            key: key.to_string(),
            mode: mode.to_string(),
            content,
            has_enhance,
            has_override,
            tools: vec![],
            description: String::new(),
            read_only: false,
            max_tokens: 0,
            max_turns: 0,
            max_tool_calls: 0,
        });
    }

    // 用户自定义 agents
    let agents_dir = state.data_dir.join("prompts").join("agents");
    if agents_dir.is_dir() {
        if let Ok(rd) = std::fs::read_dir(&agents_dir) {
            for entry in rd.flatten() {
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                if let Some(key) = name_str.strip_suffix(".md") {
                    if builtin_keys.contains(&key) {
                        continue;
                    }
                    let content = std::fs::read_to_string(entry.path()).unwrap_or_default();
                    // 从 .toml 读取完整元数据
                    let toml_path = agents_dir.join(format!("{key}.toml"));
                    let meta = parse_agent_meta(&toml_path);
                    result.push(PromptInfo {
                        key: key.to_string(),
                        mode: "custom".to_string(),
                        content,
                        has_enhance: false,
                        has_override: false,
                        tools: meta.tools,
                        description: meta.description,
                        read_only: meta.read_only,
                        max_tokens: meta.max_tokens,
                        max_turns: meta.max_turns,
                        max_tool_calls: meta.max_tool_calls,
                    });
                }
            }
        }
    }

    Ok(result)
}

#[tauri::command]
pub async fn prompt_get(key: String, state: State<'_, AppState>) -> Result<String, String> {
    let registry = state.prompt_registry.read().map_err(|e| e.to_string())?;
    registry
        .resolve(&key)
        .map(|s| s.to_string())
        .ok_or_else(|| format!("prompt '{}' not found", key))
}

#[tauri::command]
pub async fn prompt_preview(key: String, state: State<'_, AppState>) -> Result<String, String> {
    let registry = state.prompt_registry.read().map_err(|e| e.to_string())?;

    // override 存在时直接返回，不拼接 enhance（两者互斥）
    let entries = registry.entries_for(&key);
    if entries.iter().any(|e| e.mode == PromptMode::Override) {
        return Ok(registry.resolve(&key).unwrap_or_default().to_string());
    }

    // 无 override 时拼接 builtin + enhance
    let builtin = registry.resolve(&key).unwrap_or_default().to_string();
    let enhances = registry.resolve_enhances(&key);
    let mut result = builtin;
    for enhance in enhances {
        result.push_str("\n\n");
        result.push_str(enhance);
    }
    Ok(result)
}

#[tauri::command]
pub async fn prompt_save(
    payload: PromptSaveRequest,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let prompts_dir = state.data_dir.join("prompts");
    std::fs::create_dir_all(&prompts_dir)
        .map_err(|e| format!("failed to create prompts dir: {e}"))?;

    match payload.mode.as_str() {
        "enhance" => {
            // enhance 时删除同 key 的 override
            let override_path = prompts_dir.join(format!("override_{}.md", payload.key));
            if override_path.exists() {
                let _ = std::fs::remove_file(&override_path);
            }
            let path = prompts_dir.join(format!("enhance_{}.md", payload.key));
            std::fs::write(&path, &payload.content)
                .map_err(|e| format!("failed to write enhance: {e}"))?;
        }
        "override" => {
            // override 时删除同 key 的 enhance
            let enhance_path = prompts_dir.join(format!("enhance_{}.md", payload.key));
            if enhance_path.exists() {
                let _ = std::fs::remove_file(&enhance_path);
            }
            let path = prompts_dir.join(format!("override_{}.md", payload.key));
            std::fs::write(&path, &payload.content)
                .map_err(|e| format!("failed to write override: {e}"))?;
        }
        _ => return Err(format!("invalid mode '{}', expected 'enhance' or 'override'", payload.mode)),
    }
    refresh_prompt_registry(&state);
    Ok(())
}

#[tauri::command]
pub async fn prompt_delete(key: String, state: State<'_, AppState>) -> Result<(), String> {
    let prompts_dir = state.data_dir.join("prompts");
    let enhance_path = prompts_dir.join(format!("enhance_{}.md", key));
    let override_path = prompts_dir.join(format!("override_{}.md", key));
    let mut deleted = false;
    if enhance_path.exists() {
        std::fs::remove_file(&enhance_path).map_err(|e| format!("failed to delete enhance: {e}"))?;
        deleted = true;
    }
    if override_path.exists() {
        std::fs::remove_file(&override_path).map_err(|e| format!("failed to delete override: {e}"))?;
        deleted = true;
    }
    if !deleted {
        return Err(format!("no enhance/override file found for key '{}'", key));
    }
    refresh_prompt_registry(&state);
    Ok(())
}

#[tauri::command]
pub async fn custom_agent_save(
    payload: CustomAgentSaveRequest,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let builtin_keys = ["system", "explore", "plan", "general_purpose"];
    if builtin_keys.contains(&payload.name.as_str()) {
        return Err(format!("name '{}' conflicts with built-in prompt", payload.name));
    }
    let forbidden = ["dispatch_agent", "orchestrate"];
    for tool in &payload.tools {
        if forbidden.contains(&tool.as_str()) {
            return Err(format!("tool '{}' is not allowed in custom agents", tool));
        }
    }

    let agents_dir = state.data_dir.join("prompts").join("agents");
    std::fs::create_dir_all(&agents_dir)
        .map_err(|e| format!("failed to create agents dir: {e}"))?;

    // 写入 prompt 内容
    let md_path = agents_dir.join(format!("{}.md", payload.name));
    std::fs::write(&md_path, &payload.content)
        .map_err(|e| format!("failed to write agent: {e}"))?;

    // 写入 TOML 元数据（使用规范格式，非 Debug 格式化）
    let tools_str = payload.tools.iter()
        .map(|t| format!("\"{}\"", t.replace('"', "\\\"")))
        .collect::<Vec<_>>()
        .join(", ");
    let toml_content = format!(
        "name = \"{}\"\ndescription = \"{}\"\ntools = [{}]\nread_only = {}\nmax_tokens = {}\nmax_turns = {}\nmax_tool_calls = {}\n",
        payload.name,
        payload.description.replace('"', "\\\""),
        tools_str,
        payload.read_only,
        payload.max_tokens,
        payload.max_turns,
        payload.max_tool_calls,
    );
    let toml_path = agents_dir.join(format!("{}.toml", payload.name));
    std::fs::write(&toml_path, toml_content)
        .map_err(|e| format!("failed to write agent metadata: {e}"))?;

    // 运行时刷新：将新 Agent 注册到 AgentTemplateRegistry + PromptRegistry
    if let Ok(mut reg) = state.agent_templates.write() {
        reg.load_custom_agents(&state.data_dir);
    }
    refresh_prompt_registry(&state);

    Ok(())
}

#[tauri::command]
pub async fn custom_agent_delete(name: String, state: State<'_, AppState>) -> Result<(), String> {
    let agents_dir = state.data_dir.join("prompts").join("agents");
    let md_path = agents_dir.join(format!("{}.md", name));
    let toml_path = agents_dir.join(format!("{}.toml", name));
    if !md_path.exists() {
        return Err(format!("custom agent '{}' not found", name));
    }
    std::fs::remove_file(&md_path)
        .map_err(|e| format!("failed to delete agent: {e}"))?;
    if toml_path.exists() {
        let _ = std::fs::remove_file(&toml_path);
    }

    // 运行时刷新：从 AgentTemplateRegistry + PromptRegistry 移除
    if let Ok(mut reg) = state.agent_templates.write() {
        reg.remove_custom_agent(&name);
    }
    refresh_prompt_registry(&state);

    Ok(())
}

/// 重建 PromptRegistry 缓存（文件变更后调用）
fn refresh_prompt_registry(state: &State<'_, AppState>) {
    if let Ok(mut reg) = state.prompt_registry.write() {
        *reg = PromptRegistry::new();
        reg.load_user_prompts(&state.data_dir);
    }
}

/// 从 TOML 元数据文件中解析完整 Agent 元信息
struct AgentTomlMeta {
    tools: Vec<String>,
    description: String,
    read_only: bool,
    max_tokens: u32,
    max_turns: u32,
    max_tool_calls: u32,
}

impl Default for AgentTomlMeta {
    fn default() -> Self {
        Self {
            tools: vec![],
            description: String::new(),
            read_only: false,
            max_tokens: 100_000,
            max_turns: 30,
            max_tool_calls: 100,
        }
    }
}

fn parse_agent_meta(toml_path: &std::path::Path) -> AgentTomlMeta {
    let content = match std::fs::read_to_string(toml_path) {
        Ok(c) => c,
        Err(_) => return AgentTomlMeta::default(),
    };
    let mut meta = AgentTomlMeta::default();
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("tools = ") {
            let inner = rest.trim().trim_start_matches('[').trim_end_matches(']');
            if !inner.is_empty() {
                meta.tools = inner
                    .split(',')
                    .map(|s| s.trim().trim_matches('"').to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
            }
        } else if let Some(rest) = trimmed.strip_prefix("description = ") {
            meta.description = rest.trim().trim_matches('"').to_string();
        } else if let Some(rest) = trimmed.strip_prefix("read_only = ") {
            meta.read_only = rest.trim() == "true";
        } else if let Some(rest) = trimmed.strip_prefix("max_tokens = ") {
            meta.max_tokens = rest.trim().parse().unwrap_or(100_000);
        } else if let Some(rest) = trimmed.strip_prefix("max_turns = ") {
            meta.max_turns = rest.trim().parse().unwrap_or(30);
        } else if let Some(rest) = trimmed.strip_prefix("max_tool_calls = ") {
            meta.max_tool_calls = rest.trim().parse().unwrap_or(100);
        }
    }
    meta
}
