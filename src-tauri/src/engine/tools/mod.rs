pub mod bash;
pub mod context;
pub mod dispatch_agent;
pub mod feedback;
pub mod read;
pub mod write;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use async_trait::async_trait;
use futures::future::join_all;

use crate::types::ToolResult;

pub use context::ToolExecutionContext;

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

/// Execute a batch of tool calls, dispatching based on concurrency safety.
pub async fn execute_batch(
    calls: Vec<PendingToolCall>,
    registry: &ToolRegistry,
    perms: &PermissionContext,
    ctx: Option<&ToolExecutionContext>,
) -> Vec<ToolExecutionResult> {
    let (safe, unsafe_calls): (Vec<_>, Vec<_>) = calls.into_iter().partition(|c| {
        registry
            .get(&c.name)
            .map(|t| t.is_concurrent_safe())
            .unwrap_or(true)
    });

    let mut results = Vec::with_capacity(safe.len() + unsafe_calls.len());

    let safe_handles: Vec<_> = safe
        .into_iter()
        .map(|c| {
            let registry = registry.clone();
            let perms = perms.clone();
            async move { execute_single(c, &registry, &perms, None).await }
        })
        .collect();

    results.extend(join_all(safe_handles).await);

    for c in unsafe_calls {
        results.push(execute_single(c, registry, perms, ctx).await);
    }

    results
}

async fn execute_single(
    call: PendingToolCall,
    registry: &ToolRegistry,
    perms: &PermissionContext,
    ctx: Option<&ToolExecutionContext>,
) -> ToolExecutionResult {
    let id = call.id.clone();
    let name = call.name.clone();

    let tool = match registry.get(&call.name) {
        Some(t) => t,
        None => {
            return ToolExecutionResult {
                id,
                output: format!("Unknown tool: {}", call.name),
                is_error: true,
            };
        }
    };

    if !registry.is_allowed(&call.name, perms) {
        let reason = registry.denial_reason(&call.name, perms);
        return ToolExecutionResult {
            id,
            output: reason,
            is_error: true,
        };
    }

    let timeout = tool.timeout_secs();
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(timeout),
        tool.call(call.input, ctx),
    )
    .await;

    match result {
        Ok(ToolResult::Text(output)) => ToolExecutionResult {
            id,
            output,
            is_error: false,
        },
        Ok(ToolResult::Error(output)) => ToolExecutionResult {
            id,
            output,
            is_error: true,
        },
        Err(_) => ToolExecutionResult {
            id,
            output: format!("Tool '{}' timed out after {}s", name, timeout),
            is_error: true,
        },
    }
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
    use std::time::Instant;
    use std::time::Duration;
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

    // ── ToolRegistry tests ─────────────────────────────────────

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

    // ── ToolExecutor tests ─────────────────────────────────────

    struct TestTool {
        name: String,
        safe: bool,
        timeout_secs: u64,
        order_log: Arc<std::sync::Mutex<Vec<String>>>,
        sleep_ms: u64,
    }

    impl TestTool {
        fn new(name: &str, safe: bool) -> Self {
            Self {
                name: name.to_string(),
                safe,
                timeout_secs: 5,
                order_log: Arc::new(std::sync::Mutex::new(Vec::new())),
                sleep_ms: 0,
            }
        }

        fn with_sleep(mut self, ms: u64) -> Self {
            self.sleep_ms = ms;
            self
        }

        fn with_timeout(mut self, secs: u64) -> Self {
            self.timeout_secs = secs;
            self
        }

        fn with_order_log(mut self, log: Arc<std::sync::Mutex<Vec<String>>>) -> Self {
            self.order_log = log;
            self
        }
    }

    #[async_trait]
    impl Tool for TestTool {
        fn name(&self) -> &str {
            &self.name
        }
        fn description(&self) -> &str {
            &self.name
        }
        fn input_schema(&self) -> serde_json::Value {
            serde_json::json!({"type": "object"})
        }
        fn is_concurrent_safe(&self) -> bool {
            self.safe
        }
        fn timeout_secs(&self) -> u64 {
            self.timeout_secs
        }

        async fn call(&self, _input: serde_json::Value, _ctx: Option<&ToolExecutionContext>) -> ToolResult {
            if self.sleep_ms > 0 {
                tokio::time::sleep(Duration::from_millis(self.sleep_ms)).await;
            }
            self.order_log.lock().unwrap().push(self.name.clone());
            ToolResult::Text(format!("result from {}", self.name))
        }
    }

    fn build_call(id: &str, name: &str) -> PendingToolCall {
        PendingToolCall {
            id: id.to_string(),
            name: name.to_string(),
            input: serde_json::json!({}),
        }
    }

    fn build_registry(tools: Vec<Arc<dyn Tool>>) -> ToolRegistry {
        let mut reg = ToolRegistry::new();
        for t in tools {
            reg.register(t);
        }
        reg
    }

    #[tokio::test]
    async fn test_concurrent_safe_tools_run_in_parallel() {
        let log = Arc::new(std::sync::Mutex::new(Vec::new()));

        let t1: Arc<dyn Tool> = Arc::new(
            TestTool::new("safe_a", true)
                .with_sleep(100)
                .with_order_log(log.clone()),
        );
        let t2: Arc<dyn Tool> = Arc::new(
            TestTool::new("safe_b", true)
                .with_sleep(100)
                .with_order_log(log.clone()),
        );
        let t3: Arc<dyn Tool> = Arc::new(
            TestTool::new("safe_c", true)
                .with_sleep(100)
                .with_order_log(log.clone()),
        );

        let registry = build_registry(vec![t1, t2, t3]);
        let perms = PermissionContext::default();

        let calls = vec![
            build_call("1", "safe_a"),
            build_call("2", "safe_b"),
            build_call("3", "safe_c"),
        ];

        let start = Instant::now();
        let results = execute_batch(calls, &registry, &perms, None).await;
        let elapsed = start.elapsed();

        assert!(elapsed < Duration::from_millis(250), "elapsed: {:?}", elapsed);
        assert_eq!(results.len(), 3);

        for r in &results {
            assert!(!r.is_error, "unexpected error: {}", r.output);
            assert!(r.output.starts_with("result from"));
        }

        let log_guard = log.lock().unwrap();
        assert_eq!(log_guard.len(), 3);
    }

    #[tokio::test]
    async fn test_unsafe_tools_run_serially() {
        let log = Arc::new(std::sync::Mutex::new(Vec::new()));

        let t1: Arc<dyn Tool> = Arc::new(
            TestTool::new("unsafe_a", false)
                .with_sleep(50)
                .with_order_log(log.clone()),
        );
        let t2: Arc<dyn Tool> = Arc::new(
            TestTool::new("unsafe_b", false)
                .with_sleep(50)
                .with_order_log(log.clone()),
        );

        let registry = build_registry(vec![t1, t2]);
        let perms = PermissionContext::default();

        let calls = vec![
            build_call("1", "unsafe_a"),
            build_call("2", "unsafe_b"),
        ];

        let start = Instant::now();
        let results = execute_batch(calls, &registry, &perms, None).await;
        let elapsed = start.elapsed();

        assert!(elapsed >= Duration::from_millis(80), "elapsed: {:?}", elapsed);
        assert_eq!(results.len(), 2);

        for r in &results {
            assert!(!r.is_error);
        }

        let log_guard = log.lock().unwrap();
        assert_eq!(*log_guard, vec!["unsafe_a".to_string(), "unsafe_b".to_string()]);
    }

    #[tokio::test]
    async fn test_timeout_returns_error() {
        let t: Arc<dyn Tool> = Arc::new(
            TestTool::new("slow_tool", true)
                .with_sleep(5000)
                .with_timeout(1),
        );

        let registry = build_registry(vec![t]);
        let perms = PermissionContext::default();

        let calls = vec![build_call("1", "slow_tool")];

        let start = Instant::now();
        let results = execute_batch(calls, &registry, &perms, None).await;
        let elapsed = start.elapsed();

        assert!(
            elapsed < Duration::from_secs(2),
            "elapsed: {:?} — timeout did not fire",
            elapsed
        );
        assert_eq!(results.len(), 1);

        let r = &results[0];
        assert!(r.is_error);
        assert!(r.output.contains("timed out"));
        assert!(r.output.contains("slow_tool"));
    }

    #[tokio::test]
    async fn test_unknown_tool_returns_error() {
        let registry = build_registry(vec![]);
        let perms = PermissionContext::default();

        let calls = vec![build_call("1", "nonexistent_tool")];

        let results = execute_batch(calls, &registry, &perms, None).await;
        assert_eq!(results.len(), 1);

        let r = &results[0];
        assert!(r.is_error);
        assert!(r.output.contains("Unknown tool"));
        assert!(r.output.contains("nonexistent_tool"));
    }

    // ── register_builtin_tools tests ───────────────────────────

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
