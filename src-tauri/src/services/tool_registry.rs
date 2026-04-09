use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use async_trait::async_trait;
use serde_json;

/// Tool trait — all built-in and future MCP tools must implement this.
#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn input_schema(&self) -> serde_json::Value;

    /// Whether multiple invocations of this tool can run concurrently.
    fn is_concurrent_safe(&self) -> bool {
        true
    }

    /// Maximum seconds before the tool call is considered timed out.
    fn timeout_secs(&self) -> u64 {
        30
    }

    async fn call(&self, input: serde_json::Value) -> ToolResult;
}

pub struct ToolResult {
    pub output: String,
    pub is_error: bool,
}

/// Flat tool registry backed by a HashMap.
pub struct ToolRegistry {
    tools: HashMap<String, Arc<dyn Tool>>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self {
            tools: HashMap::new(),
        }
    }

    pub fn register(&mut self, tool: Arc<dyn Tool>) {
        self.tools.insert(tool.name().to_string(), tool);
    }

    pub fn get(&self, name: &str) -> Option<&Arc<dyn Tool>> {
        self.tools.get(name)
    }

    /// Returns tool names sorted alphabetically.
    pub fn tool_names(&self) -> Vec<String> {
        let mut names: Vec<String> = self.tools.keys().cloned().collect();
        names.sort();
        names
    }

    /// 5-step deny-first permission check.
    pub fn is_allowed(&self, name: &str, perms: &PermissionContext) -> bool {
        // 1. global forbidden
        if perms.global_forbidden.contains(name) {
            return false;
        }
        // 2. session forbidden
        if perms.session_forbidden.contains(name) {
            return false;
        }
        // 3. global allowlist (Some = whitelist mode)
        if let Some(ref allowed) = perms.global_allowed {
            if !allowed.contains(name) {
                return false;
            }
        }
        // 4. session allowlist
        if let Some(ref allowed) = perms.session_allowed {
            if !allowed.contains(name) {
                return false;
            }
        }
        // 5. allow
        true
    }

    /// Returns a human-readable reason why a tool is denied.
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

    /// Generate Anthropic-compatible tool definitions for ALL registered tools.
    /// Denied tools are included so the LLM gets error feedback instead of silently losing them.
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

/// Permission context with 5-step deny-first logic.
///
/// `None` for `*_allowed` means "allow all" (no whitelist restriction).
/// `Some(set)` means "only these are allowed".
///
/// `*_forbidden` are always deny-on-match.
#[derive(Debug, Clone)]
pub struct PermissionContext {
    pub global_allowed: Option<HashSet<String>>,
    pub global_forbidden: HashSet<String>,
    pub session_allowed: Option<HashSet<String>>,
    pub session_forbidden: HashSet<String>,
}

impl Default for PermissionContext {
    /// Default = allow all (no restrictions).
    fn default() -> Self {
        Self {
            global_allowed: None,
            global_forbidden: HashSet::new(),
            session_allowed: None,
            session_forbidden: HashSet::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

        async fn call(&self, _input: serde_json::Value) -> ToolResult {
            ToolResult {
                output: format!("called {}", self.name),
                is_error: false,
            }
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

        // Forbidden takes priority over allowed
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
}
