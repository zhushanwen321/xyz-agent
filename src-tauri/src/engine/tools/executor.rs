use futures::future::join_all;

use crate::types::ToolResult;

use super::{PermissionContext, ToolExecutionContext, ToolExecutionResult, ToolRegistry};

pub async fn execute_batch(
    calls: Vec<super::PendingToolCall>,
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

    // ctx 需要 clone 进入每个 async task，所以提前 clone 一份
    let ctx_clone = ctx.cloned();
    let safe_handles: Vec<_> = safe
        .into_iter()
        .map(|c| {
            let registry = registry.clone();
            let perms = perms.clone();
            let ctx = ctx_clone.as_ref();
            async move { execute_single(c, &registry, &perms, ctx).await }
        })
        .collect();

    results.extend(join_all(safe_handles).await);

    for c in unsafe_calls {
        results.push(execute_single(c, registry, perms, ctx).await);
    }

    results
}

async fn execute_single(
    call: super::PendingToolCall,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    use async_trait::async_trait;
    use tempfile::tempdir;

    use super::super::{Tool, PendingToolCall};

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

    fn build_call(id: &str, name: &str) -> super::super::PendingToolCall {
        super::super::PendingToolCall {
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
}
