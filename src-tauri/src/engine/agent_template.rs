use crate::engine::task_tree::TaskBudget;
use std::collections::HashMap;
use std::path::Path;

pub struct AgentTemplate {
    pub name: String,
    pub tools: Vec<String>,
    pub read_only: bool,
    pub default_budget: TaskBudget,
    pub system_prompt_key: String,
}

pub struct AgentTemplateRegistry {
    templates: HashMap<String, AgentTemplate>,
}

impl AgentTemplateRegistry {
    pub fn new() -> Self {
        let mut templates = HashMap::new();
        templates.insert(
            "Explore".into(),
            AgentTemplate {
                name: "Explore".into(),
                tools: vec!["Read".into(), "Bash".into()],
                read_only: true,
                default_budget: TaskBudget {
                    max_tokens: 50_000,
                    max_turns: 20,
                    max_tool_calls: 50,
                },
                system_prompt_key: "explore".into(),
            },
        );
        templates.insert(
            "Plan".into(),
            AgentTemplate {
                name: "Plan".into(),
                tools: vec!["Read".into(), "Bash".into()],
                read_only: true,
                default_budget: TaskBudget {
                    max_tokens: 80_000,
                    max_turns: 15,
                    max_tool_calls: 40,
                },
                system_prompt_key: "plan".into(),
            },
        );
        templates.insert(
            "general-purpose".into(),
            AgentTemplate {
                name: "general-purpose".into(),
                tools: vec![
                    "Read".into(),
                    "Write".into(),
                    "Bash".into(),
                    "feedback".into(),
                ],
                read_only: false,
                default_budget: TaskBudget {
                    max_tokens: 200_000,
                    max_turns: 50,
                    max_tool_calls: 200,
                },
                system_prompt_key: "general_purpose".into(),
            },
        );
        Self { templates }
    }

    /// 从 prompts/agents/ 目录加载自定义 Agent 并注册为模板
    pub fn load_custom_agents(&mut self, data_dir: &Path) {
        let agents_dir = data_dir.join("prompts").join("agents");
        if !agents_dir.is_dir() {
            return;
        }
        let builtin_keys = ["system", "explore", "plan", "general_purpose"];
        if let Ok(rd) = std::fs::read_dir(&agents_dir) {
            for entry in rd.flatten() {
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                // 只处理 .toml 文件（每个自定义 agent 有 .md + .toml）
                let Some(agent_name) = name_str.strip_suffix(".toml") else {
                    continue;
                };
                if builtin_keys.contains(&agent_name) {
                    continue;
                }
                let md_path = agents_dir.join(format!("{agent_name}.md"));
                if !md_path.is_file() {
                    continue;
                }
                let meta = parse_agent_toml(&entry.path());
                self.templates.insert(
                    agent_name.to_string(),
                    AgentTemplate {
                        name: agent_name.to_string(),
                        tools: meta.tools,
                        read_only: meta.read_only,
                        default_budget: TaskBudget {
                            max_tokens: meta.max_tokens,
                            max_turns: meta.max_turns,
                            max_tool_calls: meta.max_tool_calls,
                        },
                        system_prompt_key: agent_name.to_string(),
                    },
                );
            }
        }
    }

    /// 移除指定名称的自定义 Agent 模板
    pub fn remove_custom_agent(&mut self, name: &str) {
        self.templates.remove(name);
    }

    pub fn get(&self, name: &str) -> Option<&AgentTemplate> {
        self.templates.get(name)
    }
}

/// 自定义 Agent TOML 元数据
struct AgentTomlMeta {
    tools: Vec<String>,
    read_only: bool,
    max_tokens: u32,
    max_turns: u32,
    max_tool_calls: u32,
}

impl Default for AgentTomlMeta {
    fn default() -> Self {
        Self {
            tools: vec![],
            read_only: false,
            max_tokens: 100_000,
            max_turns: 30,
            max_tool_calls: 100,
        }
    }
}

fn parse_agent_toml(path: &Path) -> AgentTomlMeta {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return AgentTomlMeta::default(),
    };
    let mut meta = AgentTomlMeta::default();
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("tools = ") {
            meta.tools = parse_toml_array(rest);
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

fn parse_toml_array(s: &str) -> Vec<String> {
    let inner = s.trim().trim_start_matches('[').trim_end_matches(']');
    if inner.is_empty() {
        return vec![];
    }
    inner
        .split(',')
        .map(|s| s.trim().trim_matches('"').to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_builtin_template() {
        let registry = AgentTemplateRegistry::new();
        let explore = registry.get("Explore").unwrap();
        assert!(explore.tools.contains(&"Read".to_string()));
        assert!(explore.read_only);
        assert_eq!(explore.default_budget.max_tokens, 50_000);
    }

    #[test]
    fn excludes_dispatch_tools() {
        let registry = AgentTemplateRegistry::new();
        let explore = registry.get("Explore").unwrap();
        // 防递归：Explore 和 Plan 不应包含调度工具
        assert!(!explore.tools.contains(&"dispatch_agent".to_string()));
        assert!(!explore.tools.contains(&"orchestrate".to_string()));
    }

    #[test]
    fn load_custom_agents_from_dir() {
        let dir = tempfile::tempdir().unwrap();
        let agents_dir = dir.path().join("prompts").join("agents");
        std::fs::create_dir_all(&agents_dir).unwrap();
        std::fs::write(agents_dir.join("code_reviewer.md"), "review code").unwrap();
        std::fs::write(
            agents_dir.join("code_reviewer.toml"),
            "name = \"code_reviewer\"\ntools = [\"Read\", \"Bash\"]\nread_only = true\nmax_tokens = 60000\n",
        ).unwrap();

        let mut registry = AgentTemplateRegistry::new();
        registry.load_custom_agents(dir.path());

        let t = registry.get("code_reviewer").unwrap();
        assert_eq!(t.name, "code_reviewer");
        assert_eq!(t.tools, vec!["Read", "Bash"]);
        assert!(t.read_only);
        assert_eq!(t.default_budget.max_tokens, 60_000);
        assert_eq!(t.system_prompt_key, "code_reviewer");
    }

    #[test]
    fn remove_custom_agent() {
        let mut registry = AgentTemplateRegistry::new();
        // 手动插入一个假的 template
        registry.templates.insert("test_agent".into(), AgentTemplate {
            name: "test_agent".into(),
            tools: vec![],
            read_only: false,
            default_budget: TaskBudget { max_tokens: 10_000, max_turns: 10, max_tool_calls: 10 },
            system_prompt_key: "test_agent".into(),
        });
        assert!(registry.get("test_agent").is_some());
        registry.remove_custom_agent("test_agent");
        assert!(registry.get("test_agent").is_none());
    }
}
