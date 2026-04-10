use crate::engine::task_tree::TaskBudget;
use std::collections::HashMap;

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
                tools: vec!["read".into(), "bash".into()],
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
                tools: vec!["read".into(), "bash".into()],
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
                    "read".into(),
                    "write".into(),
                    "bash".into(),
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

    pub fn get(&self, name: &str) -> Option<&AgentTemplate> {
        self.templates.get(name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_builtin_template() {
        let registry = AgentTemplateRegistry::new();
        let explore = registry.get("Explore").unwrap();
        assert!(explore.tools.contains(&"read".to_string()));
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
}
