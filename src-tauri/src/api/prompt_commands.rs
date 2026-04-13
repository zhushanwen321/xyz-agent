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
}

// ── Prompt 管理 Commands ──────────────────────────────────────

#[tauri::command]
pub async fn prompt_list(state: State<'_, AppState>) -> Result<Vec<PromptInfo>, String> {
    let mut registry = PromptRegistry::new();
    registry.load_user_prompts(&state.data_dir);

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
                    result.push(PromptInfo {
                        key: key.to_string(),
                        mode: "custom".to_string(),
                        content,
                        has_enhance: false,
                        has_override: false,
                    });
                }
            }
        }
    }

    Ok(result)
}

#[tauri::command]
pub async fn prompt_get(key: String, state: State<'_, AppState>) -> Result<String, String> {
    let mut registry = PromptRegistry::new();
    registry.load_user_prompts(&state.data_dir);
    registry
        .resolve(&key)
        .map(|s| s.to_string())
        .ok_or_else(|| format!("prompt '{}' not found", key))
}

#[tauri::command]
pub async fn prompt_preview(key: String, state: State<'_, AppState>) -> Result<String, String> {
    let mut registry = PromptRegistry::new();
    registry.load_user_prompts(&state.data_dir);

    // 拼接 builtin + enhance
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

    let md_path = agents_dir.join(format!("{}.md", payload.name));
    std::fs::write(&md_path, &payload.content)
        .map_err(|e| format!("failed to write agent: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn custom_agent_delete(name: String, state: State<'_, AppState>) -> Result<(), String> {
    let agents_dir = state.data_dir.join("prompts").join("agents");
    let md_path = agents_dir.join(format!("{}.md", name));
    if md_path.exists() {
        std::fs::remove_file(&md_path)
            .map_err(|e| format!("failed to delete agent: {e}"))?;
        Ok(())
    } else {
        Err(format!("custom agent '{}' not found", name))
    }
}
