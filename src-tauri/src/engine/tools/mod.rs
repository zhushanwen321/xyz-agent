pub mod bash;
pub mod context;
pub mod dispatch_agent;
pub mod executor;
pub mod feedback;
pub mod orchestrate;
pub mod read;
pub mod write;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use async_trait::async_trait;

use crate::types::ToolResult;

pub use context::ToolExecutionContext;
pub use executor::execute_batch;

#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn input_schema(&self) -> serde_json::Value;

    fn is_concurrent_safe(&self) -> bool {
        true
    }

    fn timeout_secs(&self) -> u64 {
        30
    }

    async fn call(&self, input: serde_json::Value, ctx: Option<&ToolExecutionContext>) -> ToolResult;
}

pub struct ToolRegistry {
    tools: HashMap<String, Arc<dyn Tool>>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self {
            tools: HashMap::new(),
        }
    }

    pub fn clone(&self) -> Self {
        Self {
            tools: self.tools.clone(),
        }
    }

    pub fn register(&mut self, tool: Arc<dyn Tool>) {
        self.tools.insert(tool.name().to_string(), tool);
    }

    pub fn get(&self, name: &str) -> Option<&Arc<dyn Tool>> {
        self.tools.get(name)
    }

    pub fn tool_names(&self) -> Vec<String> {
        let mut names: Vec<String> = self.tools.keys().cloned().collect();
        names.sort();
        names
    }

    pub fn is_allowed(&self, name: &str, perms: &PermissionContext) -> bool {
        if perms.global_forbidden.contains(name) {
            return false;
        }
        if perms.session_forbidden.contains(name) {
            return false;
        }
        if let Some(ref allowed) = perms.global_allowed {
            if !allowed.contains(name) {
                return false;
            }
        }
        if let Some(ref allowed) = perms.session_allowed {
            if !allowed.contains(name) {
                return false;
            }
        }
        true
    }

    pub fn denial_reason(&self, name: &str, perms: &PermissionContext) -> String {
        if perms.global_forbidden.contains(name) {
            return format!("tool '{}' is globally forbidden", name);
        }
        if perms.session_forbidden.contains(name) {
            return format!("tool '{}' is forbidden in this session", name);
        }
        if let Some(ref allowed) = perms.global_allowed {
            if !allowed.contains(name) {
                return format!("tool '{}' is not in the global allowlist", name);
            }
        }
        if let Some(ref allowed) = perms.session_allowed {
            if !allowed.contains(name) {
                return format!("tool '{}' is not in the session allowlist", name);
            }
        }
        format!("tool '{}' is allowed", name)
    }

    pub fn tool_schemas(&self, _perms: &PermissionContext) -> Vec<serde_json::Value> {
        let mut names = self.tool_names();
        names.sort();

        names
            .into_iter()
            .map(|name| {
                let tool = &self.tools[&name];
                serde_json::json!({
                    "name": tool.name(),
                    "description": tool.description(),
                    "input_schema": tool.input_schema(),
                })
            })
            .collect()
    }
}

#[derive(Debug, Clone)]
pub struct PermissionContext {
    pub global_allowed: Option<HashSet<String>>,
    pub global_forbidden: HashSet<String>,
    pub session_allowed: Option<HashSet<String>>,
    pub session_forbidden: HashSet<String>,
}

impl Default for PermissionContext {
    fn default() -> Self {
        Self {
            global_allowed: None,
            global_forbidden: HashSet::new(),
            session_allowed: None,
            session_forbidden: HashSet::new(),
        }
    }
}

/// A tool call extracted from LLM response, awaiting execution.
#[derive(Clone)]
pub struct PendingToolCall {
    pub id: String,
    pub name: String,
    pub input: serde_json::Value,
}

/// Result of executing a single tool call.
pub struct ToolExecutionResult {
    pub id: String,
    pub output: String,
    pub is_error: bool,
}

use std::path::PathBuf;
use crate::engine::config::AgentConfig;

pub fn register_builtin_tools(registry: &mut ToolRegistry, workdir: PathBuf, config: &AgentConfig) {
    registry.register(Arc::new(read::ReadTool::new(workdir.clone(), config.tool_output_max_bytes)));
    registry.register(Arc::new(write::WriteTool::new(workdir.clone())));
    registry.register(Arc::new(bash::BashTool::new(workdir, config.bash_default_timeout_secs, config.tool_output_max_bytes)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    struct MockTool {
        name: String,
        description: String,
        safe: bool,
    }

    impl MockTool {
        fn new(name: &str, safe: bool) -> Self {
            Self {
                name: name.to_string(),
                description: format!("Mock tool {}", name),
                safe,
            }
        }
    }

    #[async_trait]
    impl Tool for MockTool {
        fn name(&self) -> &str {
            &self.name
        }
        fn description(&self) -> &str {
            &self.description
        }
        fn input_schema(&self) -> serde_json::Value {
            serde_json::json!({
                "type": "object",
                "properties": {
                    "input": { "type": "string" }
                }
            })
        }
        fn is_concurrent_safe(&self) -> bool {
            self.safe
        }

        async fn call(&self, _input: serde_json::Value, _ctx: Option<&ToolExecutionContext>) -> ToolResult {
            ToolResult::Text(format!("called {}", self.name))
        }
    }

    #[test]
    fn test_register_and_get() {
        let mut registry = ToolRegistry::new();
        let tool = Arc::new(MockTool::new("Read", true));
        registry.register(tool);

        assert!(registry.get("Read").is_some());
        assert!(registry.get("Write").is_none());
    }

    #[test]
    fn test_tool_schemas_sorted_alphabetically() {
        let mut registry = ToolRegistry::new();
        registry.register(Arc::new(MockTool::new("Write", true)));
        registry.register(Arc::new(MockTool::new("Read", true)));
        registry.register(Arc::new(MockTool::new("Bash", true)));

        let perms = PermissionContext::default();
        let schemas = registry.tool_schemas(&perms);
        let names: Vec<&str> = schemas.iter().map(|s| s["name"].as_str().unwrap()).collect();

        assert_eq!(names, vec!["Bash", "Read", "Write"]);
    }

    #[test]
    fn test_permission_deny_priority() {
        let mut registry = ToolRegistry::new();
        registry.register(Arc::new(MockTool::new("Bash", true)));

        let mut perms = PermissionContext::default();
        perms.global_allowed = Some(
            ["Bash", "Read"].iter().map(|s| s.to_string()).collect(),
        );
        perms.global_forbidden = vec!["Bash".to_string()].into_iter().collect();

        assert!(!registry.is_allowed("Bash", &perms));
    }

    #[test]
    fn test_denied_tool_returns_error_feedback() {
        let mut registry = ToolRegistry::new();
        registry.register(Arc::new(MockTool::new("Bash", true)));

        let mut perms = PermissionContext::default();
        perms.session_forbidden.insert("Bash".to_string());

        assert!(!registry.is_allowed("Bash", &perms));

        let reason = registry.denial_reason("Bash", &perms);
        assert!(reason.contains("Bash"));
        assert!(reason.contains("session"));
    }

    #[test]
    fn test_register_all_builtin_tools() {
        let dir = tempdir().unwrap();
        let mut registry = ToolRegistry::new();
        register_builtin_tools(&mut registry, dir.path().to_path_buf(), &AgentConfig::default());

        assert!(registry.get("Read").is_some());
        assert!(registry.get("Write").is_some());
        assert!(registry.get("Bash").is_some());
    }

    #[tokio::test]
    async fn test_builtin_tool_schemas_valid() {
        let dir = tempdir().unwrap();
        let mut registry = ToolRegistry::new();
        register_builtin_tools(&mut registry, dir.path().to_path_buf(), &AgentConfig::default());

        for name in registry.tool_names() {
            let tool = registry.get(&name).unwrap();
            let schema = tool.input_schema();
            assert_eq!(schema["type"], "object");
        }
    }
}
