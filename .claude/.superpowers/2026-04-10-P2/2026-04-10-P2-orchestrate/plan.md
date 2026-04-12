# P2-D: orchestrate 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 实现递归任务编排工具 orchestrate，支持 Orchestrator/Executor 双角色、Agent 持久化复用、双向反馈和级联终止。

**Spec:** [2026-04-10-P2-orchestrate/spec.md](spec.md)
**前置:** P2-C 完成（dispatch_agent + AgentSpawner + Fork 模式）

---

## Task 1: orchestrate 工具骨架

**Files:**
- Create: `src-tauri/src/engine/tools/orchestrate.rs`

- [ ] **Step 1: 写工具测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_requires_task_and_type() {
        let tool = OrchestrateTool;
        let schema = tool.input_schema();
        let required = schema.get("required").unwrap().as_array().unwrap();
        assert!(required.iter().any(|r| r.as_str() == Some("task_description")));
        assert!(required.iter().any(|r| r.as_str() == Some("agent_type")));
        assert!(required.iter().any(|r| r.as_str() == Some("directive")));
    }

    #[test]
    fn is_not_concurrent_safe() {
        let tool = OrchestrateTool;
        assert!(!tool.is_concurrent_safe());
    }

    #[test]
    fn depth_auto_downgrade() {
        // depth >= MAX_DEPTH 时 orchestrator 降级为 executor
        assert_eq!(resolve_effective_type("orchestrator", 5), "executor");
        assert_eq!(resolve_effective_type("orchestrator", 4), "orchestrator");
    }
}
```

- [ ] **Step 2: 实现 OrchestrateTool**

```rust
// engine/tools/orchestrate.rs
use crate::engine::tools::{Tool, ToolResult, ToolExecutionContext};
use crate::engine::task_tree::*;
use crate::engine::agent_spawner::*;
use crate::types::event::*;
use async_trait::async_trait;

const MAX_DEPTH: u32 = 5;

pub struct OrchestrateTool;

fn resolve_effective_type(requested: &str, depth: u32) -> &'static str {
    if requested == "orchestrator" && depth >= MAX_DEPTH {
        "executor"
    } else {
        requested
    }
}

#[async_trait]
impl Tool for OrchestrateTool {
    fn name(&self) -> &str { "orchestrate" }
    fn description(&self) -> &str {
        "创建编排节点。Orchestrator 可递归调用本工具，Executor 为叶节点执行者。"
    }
    fn is_concurrent_safe(&self) -> bool { false }
    fn timeout_secs(&self) -> u64 { 600 }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "task_description": { "type": "string" },
                "agent_type": { "enum": ["orchestrator", "executor"] },
                "target_agent_id": { "type": "string" },
                "directive": { "type": "string" },
                "sync": { "type": "boolean", "default": true },
                "token_budget": { "type": "integer" },
                "max_turns": { "type": "integer" }
            },
            "required": ["task_description", "agent_type", "directive"]
        })
    }

    async fn call(&self, input: serde_json::Value, ctx: Option<&ToolExecutionContext>) -> ToolResult {
        let Some(ctx) = ctx else {
            return ToolResult::Error("orchestrate requires ToolExecutionContext".into());
        };

        let task_description = input["task_description"].as_str().unwrap_or("").to_string();
        let requested_type = input["agent_type"].as_str().unwrap_or("executor");
        let directive = input["directive"].as_str().unwrap_or("").to_string();
        let target_agent_id = input["target_agent_id"].as_str().map(String::from);
        let is_sync = input["sync"].as_bool().unwrap_or(true);

        // 深度计算（从 ctx 获取当前深度）
        let current_depth = 0; // TODO: 从 calling context 获取
        let effective_type = resolve_effective_type(requested_type, current_depth);
        let node_depth = current_depth + 1;

        // 预算
        let default_budget = match effective_type {
            "orchestrator" => TaskBudget { max_tokens: 80_000, max_turns: 15, max_tool_calls: 50 },
            _ => TaskBudget { max_tokens: 50_000, max_turns: 20, max_tool_calls: 100 },
        };
        let budget = TaskBudget {
            max_tokens: input["token_budget"].as_u64().unwrap_or(default_budget.max_tokens as u64) as u32,
            max_turns: input["max_turns"].as_u64().unwrap_or(default_budget.max_turns as u64) as u32,
            max_tool_calls: default_budget.max_tool_calls,
        };

        // 复用检查
        if let Some(ref agent_id) = target_agent_id {
            let tree = ctx.task_tree.lock().await;
            if let Some(node) = tree.get_orchestrate_node(agent_id) {
                if node.status != OrchestrateStatus::Idle {
                    return ToolResult::Error(format!("Agent {} is not idle (status: {:?})", agent_id, node.status));
                }
                // TODO: 验证所有权
            } else {
                return ToolResult::Error(format!("Agent {} not found", agent_id));
            }
        }

        // 创建 OrchestrateNode
        let node_id = generate_task_id("orchestrate");
        let agent_id = target_agent_id.unwrap_or_else(|| format!("agent_{}", &node_id[3..11]));

        // 发送事件
        let _ = ctx.event_tx.send(AgentEvent::OrchestrateNodeCreated {
            session_id: ctx.session_id.clone(),
            node_id: node_id.clone(),
            parent_id: None, // TODO: 从 calling context 获取
            role: effective_type.to_string(),
            depth: node_depth,
            description: task_description.clone(),
        });

        // 工具过滤
        let tool_filter = match effective_type {
            "orchestrator" => vec!["orchestrate".into(), "feedback".into(), "read".into(), "bash".into()],
            _ => vec!["feedback".into(), "read".into(), "write".into(), "bash".into()],
        };

        // 通过 AgentSpawner 执行
        let result = if is_sync {
            self.run_sync(ctx, &node_id, &agent_id, &directive, &tool_filter, budget.clone()).await
        } else {
            self.run_async(ctx, &node_id, &agent_id, &directive, &tool_filter, budget.clone()).await
        };

        match result {
            Ok(text) => ToolResult::Text(text),
            Err(e) => ToolResult::Error(e),
        }
    }
}
```

- [ ] **Step 3: 注册 orchestrate 到 ToolRegistry**

在 AppState 初始化中注册。

- [ ] **Step 4: 运行 cargo check 并 commit**

```bash
git add src-tauri/src/engine/tools/orchestrate.rs
git commit -m "feat(P2-D): add orchestrate tool with depth control and role-based tool filtering"
```

---

## Task 2: Agent 持久化复用

**Files:**
- Modify: `src-tauri/src/engine/tools/orchestrate.rs`

- [ ] **Step 1: 实现复用激活逻辑**

```rust
async fn reactivate_agent(
    &self,
    ctx: &ToolExecutionContext,
    agent_id: &str,
    new_directive: &str,
    new_budget: TaskBudget,
) -> Result<(), String> {
    let mut tree = ctx.task_tree.lock().await;
    let node = tree.get_orchestrate_node_mut(agent_id)
        .ok_or_else(|| format!("Agent {} not found", agent_id))?;

    // 验证空闲状态
    if node.status != OrchestrateStatus::Idle {
        return Err(format!("Agent {} is not idle", agent_id));
    }

    // 更新节点
    node.status = OrchestrateStatus::Running;
    node.directive = new_directive.to_string();
    node.budget = new_budget;
    node.reuse_count += 1;

    // 将 directive 作为 user message 追加到 JSONL
    let entry = TranscriptEntry::User { /* ... */ };
    crate::store::jsonl::append_sidechain_entry(&node.conversation_path, &entry)
        .map_err(|e| e.to_string())?;

    Ok(())
}
```

- [ ] **Step 2: 实现 idle 标记和超时清理**

```rust
async fn mark_idle_and_notify(&self, ctx: &ToolExecutionContext, node_id: &str) {
    let mut tree = ctx.task_tree.lock().await;
    if let Some(node) = tree.get_orchestrate_node_mut(node_id) {
        node.status = OrchestrateStatus::Idle;
        node.last_active_at = chrono::Utc::now().to_rfc3339();
    }
    let _ = ctx.event_tx.send(AgentEvent::OrchestrateNodeIdle {
        session_id: ctx.session_id.clone(),
        node_id: node_id.to_string(),
    });
}
```

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/engine/tools/orchestrate.rs
git commit -m "feat(P2-D): add agent reuse with idle/reactivate and JSONL history append"
```

---

## Task 3: Feedback 非阻塞暂停

**Files:**
- Modify: `src-tauri/src/engine/tools/feedback.rs`

- [ ] **Step 1: severity=error 触发暂停**

在 FeedbackTool 的 call 中增加 orchestrate 上下文判断：

```rust
// 如果 severity=error 且 ctx 中有 orchestrate 上下文
if severity == "error" {
    if let Some(ctx) = ctx {
        let mut tree = ctx.task_tree.lock().await;
        tree.request_pause(&current_node_id);
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add src-tauri/src/engine/tools/feedback.rs
git commit -m "feat(P2-D): feedback severity=error triggers non-blocking pause for orchestrate nodes"
```

---

## Task 4: 级联终止

**Files:**
- Modify: `src-tauri/src/engine/task_tree.rs`
- Modify: `src-tauri/src/engine/loop_/mod.rs`

- [ ] **Step 1: request_kill_tree 已在 task-tree plan 中实现**

确认 `request_kill_tree` 正确递归设置所有子节点的 `kill_requested`。

- [ ] **Step 2: run_turn 中 kill/pause 检查**

在 run_turn 循环顶部添加：

```rust
// 检查 kill（从 TaskTree 读取）
if let Some(tree) = &self.task_tree {
    let tree = tree.lock().await;
    if tree.should_kill(&node_id) {
        break;
    }
    if tree.should_pause(&node_id) {
        drop(tree);
        // 暂停循环
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let tree = self.task_tree.as_ref().unwrap().lock().await;
            if !tree.should_pause(&node_id) { break; }
            if tree.should_kill(&node_id) { break; }
        }
    }
}
```

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/engine/task_tree.rs src-tauri/src/engine/loop_/mod.rs
git commit -m "feat(P2-D): add kill/pause check in run_turn with 1s polling loop"
```

---

## Task 5: Orchestrate 事件系统完整集成

**Files:**
- Modify: `src-tauri/src/engine/tools/orchestrate.rs`

- [ ] **Step 1: 补充 Progress 和 Completed 事件发送**

在子 AgentLoop 执行期间，定期发送 `OrchestrateNodeProgress`，完成后发送 `OrchestrateNodeCompleted`。

- [ ] **Step 2: 运行 cargo test 并 commit**

```bash
git add src-tauri/src/engine/tools/orchestrate.rs
git commit -m "feat(P2-D): complete orchestrate event system with progress, completed, idle, feedback"
```
