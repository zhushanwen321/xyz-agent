use std::collections::HashMap;
use std::path::Path;

// ── 数据结构 ──────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum PromptMode {
    Builtin,
    Enhance,
    Override,
    New,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct AgentMeta {
    pub name: String,
    pub description: String,
    pub tools: Vec<String>,
    pub read_only: bool,
    pub max_tokens: u32,
    pub max_turns: u32,
    pub max_tool_calls: u32,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct PromptEntry {
    pub key: String,
    pub mode: PromptMode,
    pub content: String,
    pub meta: Option<AgentMeta>,
}

pub struct PromptRegistry {
    entries: HashMap<String, Vec<PromptEntry>>,
}

impl PromptRegistry {
    pub fn new() -> Self {
        let mut entries = HashMap::new();
        let builtins: &[(&str, &str)] = &[
            ("system", include_str!("../../prompts/system_static.md")),
            ("explore", include_str!("../../prompts/explore.md")),
            ("plan", include_str!("../../prompts/plan.md")),
            ("general_purpose", include_str!("../../prompts/general_purpose.md")),
        ];
        for &(key, content) in builtins {
            entries.insert(
                key.to_string(),
                vec![PromptEntry {
                    key: key.to_string(),
                    mode: PromptMode::Builtin,
                    content: content.to_string(),
                    meta: None,
                }],
            );
        }
        Self { entries }
    }

    /// 扫描用户目录加载自定义 prompt
    ///
    /// 文件约定：
    /// - `enhance_<key>.md` → 拼接到 builtin 内容末尾
    /// - `override_<key>.md` → 完全替换 builtin
    /// - `agents/<key>.md` → 新增独立 agent prompt
    pub fn load_user_prompts(&mut self, data_dir: &Path) {
        let prompts_dir = data_dir.join("prompts");
        if !prompts_dir.is_dir() {
            return;
        }

        // enhance_*.md 和 override_*.md
        if let Ok(rd) = std::fs::read_dir(&prompts_dir) {
            for entry in rd.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if let Some(content) = read_file_if_exists(&entry.path()) {
                    if let Some(key) = name.strip_prefix("enhance_").and_then(|s| s.strip_suffix(".md")) {
                        self.entries
                            .entry(key.to_string())
                            .or_default()
                            .push(PromptEntry {
                                key: key.to_string(),
                                mode: PromptMode::Enhance,
                                content,
                                meta: None,
                            });
                    } else if let Some(key) = name.strip_prefix("override_").and_then(|s| s.strip_suffix(".md")) {
                        self.entries
                            .entry(key.to_string())
                            .or_default()
                            .push(PromptEntry {
                                key: key.to_string(),
                                mode: PromptMode::Override,
                                content,
                                meta: None,
                            });
                    }
                }
            }
        }

        // agents/ 子目录
        let agents_dir = prompts_dir.join("agents");
        if agents_dir.is_dir() {
            if let Ok(rd) = std::fs::read_dir(&agents_dir) {
                for entry in rd.flatten() {
                    let name = entry.file_name();
                    let name = name.to_string_lossy();
                    if let Some(key) = name.strip_suffix(".md") {
                        if let Some(content) = read_file_if_exists(&entry.path()) {
                            self.entries.entry(key.to_string()).or_default().push(
                                PromptEntry {
                                    key: key.to_string(),
                                    mode: PromptMode::New,
                                    content,
                                    meta: None,
                                },
                            );
                        }
                    }
                }
            }
        }
    }

    /// 查找 prompt，优先级：override > builtin+enhance > custom agent
    pub fn resolve(&self, key: &str) -> Option<&str> {
        let entries = self.entries.get(key)?;
        // override 优先
        if let Some(e) = entries.iter().find(|e| e.mode == PromptMode::Override) {
            return Some(&e.content);
        }
        // builtin + enhance 拼接（由 PromptManager 处理拼接逻辑，这里返回 builtin 内容）
        // 但如果有 enhance，需要在外部拼接，所以这里返回 builtin 原文
        // enhance 的内容由 resolve_enhances 单独获取
        if let Some(e) = entries.iter().find(|e| e.mode == PromptMode::Builtin) {
            return Some(&e.content);
        }
        // custom agent
        if let Some(e) = entries.iter().find(|e| e.mode == PromptMode::New) {
            return Some(&e.content);
        }
        None
    }

    /// 获取指定 key 的 enhance 内容，用于拼接到 builtin 末尾
    pub fn resolve_enhances(&self, key: &str) -> Vec<&str> {
        match self.entries.get(key) {
            Some(entries) => entries
                .iter()
                .filter(|e| e.mode == PromptMode::Enhance)
                .map(|e| e.content.as_str())
                .collect(),
            None => vec![],
        }
    }

    /// 返回完整的 prompt 文本（override 直接返回，否则 builtin + enhance 拼接）
    pub fn resolve_full(&self, key: &str) -> Option<String> {
        let entries = self.entries.get(key)?;
        // override 直接返回
        if let Some(e) = entries.iter().find(|e| e.mode == PromptMode::Override) {
            return Some(e.content.clone());
        }
        // builtin + enhance 拼接
        let builtin = entries.iter().find(|e| e.mode == PromptMode::Builtin)?;
        let mut result = builtin.content.clone();
        for enhance in entries.iter().filter(|e| e.mode == PromptMode::Enhance) {
            result.push_str("\n\n");
            result.push_str(&enhance.content);
        }
        Some(result)
    }

    /// 插入 override（供 new_with_prompt 使用）
    pub fn insert_override(&mut self, key: &str, content: &str) {
        let entries = self.entries.entry(key.to_string()).or_default();
        // 移除已有 override
        entries.retain(|e| e.mode != PromptMode::Override);
        entries.push(PromptEntry {
            key: key.to_string(),
            mode: PromptMode::Override,
            content: content.to_string(),
            meta: None,
        });
    }

    /// 获取指定 key 的所有条目引用（供 commands 层读取 mode 信息）
    pub fn entries_for(&self, key: &str) -> &[PromptEntry] {
        self.entries.get(key).map(|v| v.as_slice()).unwrap_or(&[])
    }
}

impl Default for PromptRegistry {
    fn default() -> Self {
        Self::new()
    }
}

fn read_file_if_exists(path: &Path) -> Option<String> {
    if path.is_file() {
        std::fs::read_to_string(path).ok()
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_keys_loaded() {
        let reg = PromptRegistry::new();
        assert!(reg.resolve("system").is_some());
        assert!(reg.resolve("explore").is_some());
        assert!(reg.resolve("plan").is_some());
        assert!(reg.resolve("general_purpose").is_some());
    }

    #[test]
    fn unknown_key_returns_none() {
        let reg = PromptRegistry::new();
        assert!(reg.resolve("nonexistent").is_none());
    }

    #[test]
    fn override_takes_priority() {
        let mut reg = PromptRegistry::new();
        reg.insert_override("system", "overridden content");
        assert_eq!(reg.resolve("system").unwrap(), "overridden content");
    }

    #[test]
    fn enhance_appended_separately() {
        let mut reg = PromptRegistry::new();
        let dir = tempfile::tempdir().unwrap();
        let prompts_dir = dir.path().join("prompts");
        std::fs::create_dir_all(&prompts_dir).unwrap();
        std::fs::write(prompts_dir.join("enhance_system.md"), "extra context").unwrap();

        reg.load_user_prompts(dir.path());
        // builtin 仍然可获取
        let builtin = reg.resolve("system").unwrap();
        assert!(builtin.contains("xyz-agent"));
        // enhance 内容通过 resolve_enhances 获取
        let enhances = reg.resolve_enhances("system");
        assert_eq!(enhances.len(), 1);
        assert_eq!(enhances[0], "extra context");
    }

    #[test]
    fn custom_agent_from_agents_dir() {
        let mut reg = PromptRegistry::new();
        let dir = tempfile::tempdir().unwrap();
        let agents_dir = dir.path().join("prompts").join("agents");
        std::fs::create_dir_all(&agents_dir).unwrap();
        std::fs::write(agents_dir.join("code_reviewer.md"), "review code").unwrap();

        reg.load_user_prompts(dir.path());
        assert_eq!(reg.resolve("code_reviewer").unwrap(), "review code");
    }

    #[test]
    fn load_user_prompts_nonexistent_dir_is_noop() {
        let mut reg = PromptRegistry::new();
        reg.load_user_prompts(Path::new("/nonexistent/path"));
        // 仍然有 builtin
        assert!(reg.resolve("system").is_some());
    }

    #[test]
    fn resolve_full_returns_builtin_when_no_enhance() {
        let reg = PromptRegistry::new();
        let full = reg.resolve_full("system").unwrap();
        assert!(full.contains("xyz-agent"));
        // 无 enhance 时，resolve_full 与 resolve 返回相同内容
        assert_eq!(full, reg.resolve("system").unwrap());
    }

    #[test]
    fn resolve_full_appends_enhance() {
        let mut reg = PromptRegistry::new();
        let dir = tempfile::tempdir().unwrap();
        let prompts_dir = dir.path().join("prompts");
        std::fs::create_dir_all(&prompts_dir).unwrap();
        std::fs::write(prompts_dir.join("enhance_system.md"), "extra rules").unwrap();

        reg.load_user_prompts(dir.path());
        let full = reg.resolve_full("system").unwrap();
        assert!(full.contains("xyz-agent"));
        assert!(full.contains("extra rules"));
    }

    #[test]
    fn resolve_full_override_skips_enhance() {
        let mut reg = PromptRegistry::new();
        let dir = tempfile::tempdir().unwrap();
        let prompts_dir = dir.path().join("prompts");
        std::fs::create_dir_all(&prompts_dir).unwrap();
        // 同时存在 enhance 和 override
        std::fs::write(prompts_dir.join("enhance_system.md"), "extra").unwrap();
        std::fs::write(prompts_dir.join("override_system.md"), "full override").unwrap();

        reg.load_user_prompts(dir.path());
        let full = reg.resolve_full("system").unwrap();
        // override 优先，不包含 builtin 也不包含 enhance
        assert_eq!(full, "full override");
    }
}
