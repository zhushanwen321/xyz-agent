# P2-A/B/C: dispatch_agent 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 实现 dispatch_agent 工具的三阶段：sync 模式 → async 模式 → Fork 模式。

**Spec:** [2026-04-10-P2-dispatch-agent/spec.md](spec.md)
**前置:** task-tree plan + budget-guard plan 完成

---

## Part 1: P2-A — dispatch_agent 同步模式

### Task 1: feedback 工具

**Files:**
- Create: `src-tauri/src/engine/tools/feedback.rs`

- [ ] **Step 1: 写 feedback 工具测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_has_required_fields() {
        let tool = FeedbackTool;
        let schema = tool.input_schema();
        let required = schema.get("required").unwrap().as_array().unwrap();
        assert!(required.iter().any(|r| r.as_str() == Some("message")));
    }
}
```

- [ ] **Step 2: 实现 FeedbackTool**

```rust
// engine/tools/feedback.rs
use crate::engine::tools::{Tool, ToolResult, ToolExecutionContext};
use async_trait::async_trait;

pub struct FeedbackTool;

#[async_trait]
impl Tool for FeedbackTool {
    fn name(&self) -> &str { "feedback" }
    fn description(&self) -> &str { "向父 Agent 发送中间报告" }
    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "message": { "type": "string" },
                "severity": { "enum": ["info", "warning", "error"], "default": "info" }
            },
            "required": ["message"]
        })
    }

    async fn call(&self, input: serde_json::Value, ctx: Option<&ToolExecutionContext>) -> ToolResult {
        let message = input["message"].as_str().unwrap_or("").to_string();
        let severity = input["severity"].as_str().unwrap_or("info").to_string();

        if let Some(ctx) = ctx {
            let _ = ctx.event_tx.send(crate::types::AgentEvent::TaskFeedback {
                session_id: ctx.session_id.clone(),
                task_id: String::new(), // 由调用者填充
                message,
                severity,
            });
        }
        ToolResult::Text("Feedback sent.".into())
    }
}
```

- [ ] **Step 3: 运行测试并 commit**

```bash
git add src-tauri/src/engine/tools/feedback.rs src-tauri/src/engine/tools/mod.rs
git commit -m "feat(P2-A): add feedback tool for SubAgent→Parent communication"
```

---

### Task 2: dispatch_agent 工具（sync 模式）

**Files:**
- Create: `src-tauri/src/engine/tools/dispatch_agent.rs`

- [ ] **Step 1: 写 dispatch_agent sync 测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_validates_required_fields() {
        let tool = DispatchAgentTool;
        let schema = tool.input_schema();
        let required = schema.get("required").unwrap().as_array().unwrap();
        assert!(required.iter().any(|r| r.as_str() == Some("description")));
        assert!(required.iter().any(|r| r.as_str() == Some("prompt")));
    }

    #[test]
    fn is_not_concurrent_safe() {
        let tool = DispatchAgentTool;
        assert!(!tool.is_concurrent_safe());
    }

    #[test]
    fn timeout_is_600() {
        let tool = DispatchAgentTool;
        assert_eq!(tool.timeout_secs(), 600);
    }
}
```

- [ ] **Step 2: 实现 dispatch_agent sync call**

```rust
// engine/tools/dispatch_agent.rs
use crate::engine::tools::{Tool, ToolResult, ToolExecutionContext};
use crate::engine::task_tree::*;
use crate::engine::budget_guard::BudgetGuard;
use crate::types::event::*;
use async_trait::async_trait;
use std::time::Instant;

pub struct DispatchAgentTool;

#[async_trait]
impl Tool for DispatchAgentTool {
    fn name(&self) -> &str { "dispatch_agent" }
    fn description(&self) -> &str {
        "启动子 Agent 处理任务。sync=true 阻塞等待结果，sync=false 后台执行。"
    }
    fn is_concurrent_safe(&self) -> bool { false }
    fn timeout_secs(&self) -> u64 { 600 }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "description": { "type": "string", "description": "3-5 词任务摘要" },
                "prompt": { "type": "string", "description": "子 Agent 的任务指令" },
                "mode": { "enum": ["preset", "fork"], "default": "preset" },
                "subagent_type": { "type": "string", "description": "模板名（preset 必填）" },
                "sync": { "type": "boolean", "default": true },
                "token_budget": { "type": "integer" },
                "max_turns": { "type": "integer" }
            },
            "required": ["description", "prompt"]
        })
    }

    async fn call(&self, input: serde_json::Value, ctx: Option<&ToolExecutionContext>) -> ToolResult {
        let Some(ctx) = ctx else {
            return ToolResult::Error("dispatch_agent requires ToolExecutionContext".into());
        };

        let description = input["description"].as_str().unwrap_or("").to_string();
        let prompt = input["prompt"].as_str().unwrap_or("").to_string();
        let subagent_type = input["subagent_type"].as_str().unwrap_or("").to_string();
        let is_sync = input["sync"].as_bool().unwrap_or(true);

        // 查找模板
        let template = ctx.agent_templates.get(&subagent_type)
            .ok_or_else(|| format!("template '{}' not found", subagent_type))
            .map_err(|e| ToolResult::Error(e))?;

        // 构建预算
        let budget = TaskBudget {
            max_tokens: input["token_budget"].as_u64().unwrap_or(template.default_budget.max_tokens as u64) as u32,
            max_turns: input["max_turns"].as_u64().unwrap_or(template.default_budget.max_turns as u64) as u32,
            max_tool_calls: template.default_budget.max_tool_calls,
        };

        // 创建 TaskNode
        let task_id = generate_task_id("dispatch_agent");
        let start = Instant::now();

        // 发送 TaskCreated 事件
        let _ = ctx.event_tx.send(AgentEvent::TaskCreated {
            session_id: ctx.session_id.clone(),
            task_id: task_id.clone(),
            description: description.clone(),
            mode: "preset".into(),
            subagent_type: subagent_type.clone(),
            budget: TaskBudgetSummary { max_tokens: budget.max_tokens },
        });

        // 同步模式：创建子 AgentLoop 并执行
        // 注意：P2-A 阶段直接调用 AgentLoop，P2-C 引入 AgentSpawner 后重构
        let result = self.run_sync_subagent(ctx, &task_id, &prompt, &template.name, budget.clone()).await;

        let elapsed = start.elapsed().as_millis() as u64;
        let status_str = match &result {
            Ok(_) => "completed",
            Err(_) => "failed",
        };

        // 发送 TaskCompleted 事件
        let _ = ctx.event_tx.send(AgentEvent::TaskCompleted {
            session_id: ctx.session_id.clone(),
            task_id: task_id.clone(),
            status: status_str.into(),
            result_summary: result.as_deref().unwrap_or("error").chars().take(2000).collect(),
            usage: TaskUsageSummary { total_tokens: 0, tool_uses: 0, duration_ms: elapsed },
        });

        match result {
            Ok(text) => ToolResult::Text(text),
            Err(e) => ToolResult::Error(e),
        }
    }
}

impl DispatchAgentTool {
    async fn run_sync_subagent(
        &self,
        ctx: &ToolExecutionContext,
        task_id: &str,
        prompt: &str,
        template_name: &str,
        budget: TaskBudget,
    ) -> Result<String, String> {
        // P2-A: 简化实现——直接在当前 tokio task 中运行子 AgentLoop
        // P2-C: 重构为 AgentSpawner.spawn_agent()
        // 当前阶段使用 TODO 占位，等 AgentLoop 集成完成后实现
        todo!("P2-A integration: wire up AgentLoop::run_turn with filtered tools + BudgetGuard")
    }
}
```

- [ ] **Step 3: 注册 dispatch_agent 和 feedback 到 ToolRegistry**

在 `api/mod.rs` 的 AppState 初始化中注册：
```rust
tool_registry.register(Box::new(crate::engine::tools::dispatch_agent::DispatchAgentTool));
tool_registry.register(Box::new(crate::engine::tools::feedback::FeedbackTool));
```

- [ ] **Step 4: 运行 cargo check 并 commit**

```bash
git add src-tauri/src/engine/tools/dispatch_agent.rs src-tauri/src/engine/tools/mod.rs src-tauri/src/api/mod.rs
git commit -m "feat(P2-A): add dispatch_agent tool with sync mode skeleton"
```

---

### Task 3: run_turn 集成 BudgetGuard

**Files:**
- Modify: `src-tauri/src/engine/loop_/mod.rs`

- [ ] **Step 1: run_turn 签名增加 budget_guard 参数**

```rust
pub async fn run_turn(
    &self,
    _user_message: String,
    history: Vec<TranscriptEntry>,
    parent_uuid: Option<String>,
    event_tx: tokio::sync::mpsc::UnboundedSender<AgentEvent>,
    tool_registry: &ToolRegistry,
    tool_perms: &PermissionContext,
    prompt_manager: &PromptManager,
    dynamic_context: &DynamicContext,
    agent_config: &AgentConfig,
    budget_guard: Option<&mut BudgetGuard>,  // P2 新增
) -> Result<Vec<TranscriptEntry>, AppError>
```

- [ ] **Step 2: 在 run_turn 循环中检查 budget**

在每轮循环（LLM 响应后）添加：
```rust
if let Some(bg) = &mut budget_guard {
    if bg.is_exhausted() {
        break; // budget exhausted
    }
    if bg.is_diminishing() {
        break; // diminishing returns
    }
    if bg.should_warn() {
        let _ = event_tx.send(AgentEvent::BudgetWarning {
            session_id: self.session_id.clone(),
            task_id: String::new(),
            usage_percent: bg.usage_percent(),
        });
    }
}
```

- [ ] **Step 3: 运行测试并 commit**

```bash
git add src-tauri/src/engine/loop_/mod.rs
git commit -m "feat(P2-A): integrate BudgetGuard into AgentLoop run_turn"
```

---

## Part 2: P2-B — dispatch_agent 异步模式

### Task 4: 异步执行 + JoinHandle 管理

**Files:**
- Modify: `src-tauri/src/engine/tools/dispatch_agent.rs`

- [ ] **Step 1: 实现 async dispatch 路径**

在 `call()` 中，当 `is_sync=false` 时：

```rust
// 异步模式
let handle = tokio::spawn({
    let ctx = ctx_clone; // clone Arc 引用
    let task_id = task_id.clone();
    async move {
        // 运行子 AgentLoop
        let result = run_subagent_inner(&ctx, &task_id, &prompt, budget).await;
        // 完成后发送事件
        let _ = ctx.event_tx.send(AgentEvent::TaskCompleted { ... });
        result
    }
});

// 存储 JoinHandle
{
    let mut tasks = ctx.background_tasks.lock().await;
    tasks.insert(task_id.clone(), handle);
}

// 立即返回
ToolResult::Text(format!(
    "<task_notification><task_id>{}</task_id><status>pending</status><message>Task started in background</message></task_notification>",
    task_id
))
```

- [ ] **Step 2: 实现异步结果注入**

在 `api/commands.rs` 的 `send_message` 处理中，构建 `history_to_api_messages` 后检查已完成的异步任务：

```rust
// 检查 pending_async_results
for result in &load_result.pending_async_results {
    // 根据最后一条消息的 role 决定注入格式（见 spec 异步注入规则）
    inject_async_result(&mut api_messages, result);
}
```

注入规则（消息交替性保证）：
- 最后一条是 `user`：注入 `assistant(text) + user(system)` 对
- 最后一条是 `assistant`：追加 text 到该 assistant content，然后注入 `user(system)`

- [ ] **Step 3: 运行 cargo check 并 commit**

```bash
git add src-tauri/src/engine/tools/dispatch_agent.rs src-tauri/src/api/commands.rs
git commit -m "feat(P2-B): add async dispatch_agent mode with background execution and result injection"
```

---

### Task 5: 事件通道桥接

**Files:**
- Modify: `src-tauri/src/engine/tools/dispatch_agent.rs`

- [ ] **Step 1: 实现桥接 channel**

子 AgentLoop 创建独立 `mpsc::unbounded_channel()`，桥接 task 只转发指定事件类型：

```rust
fn bridge_events(
    sub_rx: UnboundedReceiver<AgentEvent>,
    main_tx: UnboundedSender<AgentEvent>,
    task_id: String,
    session_id: String,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut last_progress = Instant::now();
        while let Some(event) = sub_rx.recv().await {
            match &event {
                // 转发
                AgentEvent::TaskProgress { .. } => {
                    if last_progress.elapsed() >= Duration::from_secs(2) {
                        last_progress = Instant::now();
                        let _ = main_tx.send(event);
                    }
                }
                AgentEvent::TaskCompleted { .. }
                | AgentEvent::BudgetWarning { .. }
                | AgentEvent::TaskFeedback { .. } => {
                    let _ = main_tx.send(event);
                }
                // 丢弃：TextDelta, ThinkingDelta, ToolCallStart, ToolCallEnd
                _ => {}
            }
        }
    })
}
```

- [ ] **Step 2: 运行测试并 commit**

```bash
git add src-tauri/src/engine/tools/dispatch_agent.rs
git commit -m "feat(P2-B): add event channel bridge with throttling for SubAgent events"
```

---

## Part 3: P2-C — Fork 模式 + AgentSpawner

### Task 6: AgentSpawner trait

**Files:**
- Create: `src-tauri/src/engine/agent_spawner.rs`

- [ ] **Step 1: 定义 AgentSpawner trait + 类型**

```rust
// engine/agent_spawner.rs
use crate::engine::task_tree::*;
use crate::types::transcript::*;
use crate::types::AgentEvent;
use crate::engine::tools::ToolExecutionContext;
use async_trait::async_trait;

pub struct SpawnConfig {
    pub prompt: String,
    pub history: Vec<TranscriptEntry>,
    pub system_prompt_override: Option<String>,
    pub tool_filter: Option<Vec<String>>,
    pub budget: Option<TaskBudget>,
    pub event_tx: tokio::sync::mpsc::UnboundedSender<AgentEvent>,
    pub sync: bool,
    // Fork 专用
    pub fork_api_messages: Option<Vec<serde_json::Value>>,
    pub fork_assistant_content: Option<Vec<AssistantContentBlock>>,
    // 运行时依赖
    pub dynamic_context: crate::engine::context::prompt::DynamicContext,
    pub permission_context: crate::engine::tools::PermissionContext,
}

pub struct SpawnHandle {
    pub task_id: String,
    pub join_handle: Option<tokio::task::JoinHandle<Result<AgentSpawnResult, crate::error::AppError>>>,
}

pub struct AgentSpawnResult {
    pub entries: Vec<TranscriptEntry>,
    pub usage: TaskUsage,
    pub status: String,
    pub output_file: Option<std::path::PathBuf>,
}

#[async_trait]
pub trait AgentSpawner: Send + Sync {
    fn spawn_agent(&self, config: SpawnConfig) -> Result<SpawnHandle, crate::error::AppError>;
}
```

- [ ] **Step 2: 重构 dispatch_agent 使用 AgentSpawner**

将 `run_sync_subagent` 改为通过 `ctx.agent_spawner` 调用。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/engine/agent_spawner.rs src-tauri/src/engine/tools/dispatch_agent.rs
git commit -m "feat(P2-C): add AgentSpawner trait and refactor dispatch_agent to use it"
```

---

### Task 7: Fork 模式实现

**Files:**
- Modify: `src-tauri/src/engine/tools/dispatch_agent.rs`

- [ ] **Step 1: 实现 build_fork_messages**

```rust
fn build_fork_messages(
    api_messages: &[serde_json::Value],
    current_assistant_content: &[AssistantContentBlock],
    prompt: &str,
) -> Vec<serde_json::Value> {
    // 1. 复制父 api_messages
    let mut fork_messages = api_messages.to_vec();

    // 2. 构建 assistant message（包含所有 tool_use blocks）
    let tool_use_blocks: Vec<_> = current_assistant_content.iter()
        .filter(|b| matches!(b, AssistantContentBlock::ToolUse { .. }))
        .collect();

    // 3. 为每个 tool_use 生成统一 placeholder tool_result
    let mut result_blocks = vec![];
    for block in &tool_use_blocks {
        if let AssistantContentBlock::ToolUse { id, .. } = block {
            result_blocks.push(serde_json::json!({
                "type": "tool_result",
                "tool_use_id": id,
                "content": "Fork started — processing in background"
            }));
        }
    }

    // 4. 最后添加 directive
    result_blocks.push(serde_json::json!({
        "type": "text",
        "text": format!("<fork-context>\n{}\n</fork-context>", prompt)
    }));

    // 5. 追加 user message
    fork_messages.push(serde_json::json!({
        "role": "user",
        "content": result_blocks
    }));

    fork_messages
}
```

- [ ] **Step 2: Fork 防递归检查**

```rust
fn is_in_fork_child(history: &[TranscriptEntry]) -> bool {
    history.iter().any(|entry| {
        if let TranscriptEntry::User { content, .. } = entry {
            content.iter().any(|block| {
                if let UserContentBlock::Text { text } = block {
                    text.contains("<fork-context>")
                } else { false }
            })
        } else { false }
    })
}
```

- [ ] **Step 3: 在 dispatch_agent call 中处理 mode=fork**

```rust
let mode = input["mode"].as_str().unwrap_or("preset");
if mode == "fork" {
    // 检查防递归
    // 构建 fork messages（使用 ctx.api_messages + ctx.current_assistant_content）
    // byte-identical system prompt（ctx 渲染后的）
    // 父工具池（排除 dispatch_agent + orchestrate）
}
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/engine/tools/dispatch_agent.rs
git commit -m "feat(P2-C): add Fork mode with cache-safe messages and anti-recursion guard"
```

---

### Task 8: PromptManager new_with_prompt

**Files:**
- Modify: `src-tauri/src/engine/context/prompt.rs`

- [ ] **Step 1: 添加 new_with_prompt 方法**

```rust
impl PromptManager {
    pub fn new_with_prompt(static_prompt: &str) -> Self {
        Self { static_prompt: static_prompt.to_string() }
    }
}
```

- [ ] **Step 2: 运行 cargo test 并 commit**

```bash
git add src-tauri/src/engine/context/prompt.rs
git commit -m "feat(P2-C): add PromptManager::new_with_prompt for Fork mode"
```

---

## Task 9: Sidechain JSONL 读写

**Files:**
- Modify: `src-tauri/src/store/jsonl.rs`

- [ ] **Step 1: 添加 sidechain 路径辅助函数**

```rust
pub fn sidechain_path(data_dir: &Path, session_id: &str, task_id: &str) -> PathBuf {
    let dir = data_dir.join(session_id).join("subagents");
    std::fs::create_dir_all(&dir).ok();
    dir.join(format!("{}.jsonl", task_id))
}
```

- [ ] **Step 2: 添加 sidechain 写入函数**

```rust
pub fn append_sidechain_entry(path: &Path, entry: &TranscriptEntry) -> Result<(), AppError> {
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path)
        .map_err(|e| AppError::Io(e))?;
    let json = serde_json::to_string(entry).map_err(|e| AppError::Serialization(e))?;
    writeln!(file, "{}", json).map_err(|e| AppError::Io(e))
}
```

- [ ] **Step 3: 运行测试并 commit**

```bash
git add src-tauri/src/store/jsonl.rs
git commit -m "feat(P2-A): add sidechain JSONL read/write for SubAgent transcripts"
```
