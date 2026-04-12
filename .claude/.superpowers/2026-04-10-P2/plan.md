# P2-AgentSpawner 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 dispatch_agent/orchestrate 的 sync 和 async 模式真正执行子 AgentLoop，消除所有 stub。

**Architecture:** 新增 `DefaultAgentSpawner`（实现 `AgentSpawner` trait），内部封装 provider/tool_registry/config 等运行时依赖，通过 `spawn_agent()` 创建子 `AgentLoop` 并执行。dispatch_agent 和 orchestrate 通过 `ToolExecutionContext` 中的 `Arc<dyn AgentSpawner>` 委托执行。

**Tech Stack:** Rust + tokio async + AgentLoop + BudgetGuard + ConcurrencyManager

**Spec:** [dispatch-agent spec](2026-04-10-P2-dispatch-agent/spec.md) | [orchestrate spec](2026-04-10-P2-orchestrate/spec.md)

---

## 实现差距分析

### 已实现（骨架/基础设施）
- TaskTree / OrchestrateNode / TaskNode / Notify pause/resume
- BudgetGuard（token/turn/tool_call 上限、diminishing returns、warning）
- ConcurrencyManager（Semaphore + active_count）
- AgentTemplateRegistry（Explore/Plan/general-purpose）
- ToolExecutionContext（task_tree, event_tx, api_messages, current_assistant_content, tool_registry）
- dispatch_agent/orchestrate/feedback 工具 schema + 参数校验
- run_turn 集成 BudgetGuard + kill/pause 检查 + ToolExecutionContext 传递
- sidechain JSONL 路径 + 追加写入函数（sidechain_path, append_sidechain_entry, orchestrate_path）
- PromptManager::new_with_prompt
- build_fork_messages / is_in_fork_child（dispatch_agent.rs 内已实现）
- bridge_events（子→父事件桥接+节流，dispatch_agent.rs 内已实现）
- 前端 SubAgentCard / ToolCallCard / ChatView / StatusBar

### 未实现（本次计划覆盖）
1. **DefaultAgentSpawner** — AgentSpawner trait 的唯一实现者
2. **dispatch_agent sync 执行** — 当前硬编码 `Err("not yet implemented")`
3. **dispatch_agent async 执行** — 当前 `sleep(100ms)` stub
4. **orchestrate sync/async 执行** — 当前返回 `"stub — pending AgentSpawner"` 文本
5. **ToolExecutionContext 加入 agent_spawner** — 当前缺少此字段
6. **异步结果注入** — send_message 中检查已完成的异步任务并注入

---

## File Structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `engine/agent_spawner.rs` | 修改 | 加入 DefaultAgentSpawner impl |
| `engine/tools/context.rs` | 修改 | ToolExecutionContext 加入 agent_spawner |
| `engine/tools/dispatch_agent.rs` | 修改 | sync/async 使用 agent_spawner |
| `engine/tools/orchestrate.rs` | 修改 | sync/async 使用 agent_spawner |
| `api/mod.rs` | 修改 | AppState 加入 agent_spawner 字段 |
| `api/commands.rs` | 修改 | ToolExecutionContext 注入 agent_spawner + 异步结果注入 |
| `engine/task_tree.rs` | 修改 | 异步结果注入支持（result_injected 标记） |
| `engine/subagent/mod.rs` | 删除 | 空文件，只有一行注释 |

---

## Task 1: DefaultAgentSpawner 实现

**Files:**
- Modify: `src-tauri/src/engine/agent_spawner.rs`

**Context:** 当前文件只有 trait 定义和类型（SpawnConfig, SpawnHandle, AgentSpawnResult），标记 `#[allow(dead_code)]`。需要新增 `DefaultAgentSpawner` struct 和 `impl AgentSpawner`。

**现有依赖可参考：**
- `engine::loop_::AgentLoop::run_turn()` 签名（13 个参数，见下方）
- `engine::budget_guard::BudgetGuard`
- `engine::concurrency::ConcurrencyManager`
- `store::jsonl::{sidechain_path, append_sidechain_entry}`

**run_turn 签名参考（用于构建调用）：**
```rust
pub async fn run_turn(
    &self,
    _user_message: String,           // 子 Agent 的 prompt
    history: Vec<TranscriptEntry>,    // preset: [User{text:prompt}]；fork: build_fork_messages 的结果
    parent_uuid: Option<String>,      // None
    event_tx: UnboundedSender<AgentEvent>,  // 子 channel 的 tx
    tool_registry: &ToolRegistry,     // 过滤后的子集
    tool_perms: &PermissionContext,   // 从 SpawnConfig 传入
    prompt_manager: &PromptManager,   // new_with_prompt 或默认
    dynamic_context: &DynamicContext, // 从 SpawnConfig 传入
    agent_config: &AgentConfig,       // 从 DefaultAgentSpawner 持有
    budget_guard: Option<&mut BudgetGuard>,  // 从 SpawnConfig.budget 创建
    task_tree: Option<Arc<Mutex<TaskTree>>>,  // 从 DefaultAgentSpawner 持有
    node_id: Option<String>,          // 从 SpawnConfig.node_id
    tool_ctx: Option<ToolExecutionContext>,   // 子 Agent 的 ctx（无 agent_spawner 防递归）
) -> Result<Vec<TranscriptEntry>, AppError>
```

- [ ] **Step 1: 补充 SpawnConfig 缺失的字段**

SpawnConfig 需要额外字段：

```rust
pub struct SpawnConfig {
    pub prompt: String,
    pub session_id: String,           // 新增：用于 sidechain JSONL 路径
    pub task_id: String,              // 新增：用于 TaskTree 注册
    pub node_id: Option<String>,      // 新增：TaskTree 节点 ID
    pub history: Vec<TranscriptEntry>,
    pub system_prompt_override: Option<String>,
    pub tool_filter: Option<Vec<String>>,
    pub budget: TaskBudget,           // 改为非 Option：调用者必须提供
    pub event_tx: tokio::sync::mpsc::UnboundedSender<AgentEvent>,
    pub sync: bool,
    pub fork_api_messages: Option<Vec<serde_json::Value>>,
    pub fork_assistant_content: Option<Vec<AssistantContentBlock>>,
    pub dynamic_context: DynamicContext,
    pub permission_context: PermissionContext,
}
```

- [ ] **Step 2: 定义 DefaultAgentSpawner struct**

```rust
pub struct DefaultAgentSpawner {
    pub provider: Arc<dyn crate::engine::llm::LlmProvider>,
    pub model: String,
    pub config: crate::engine::config::AgentConfig,
    pub tool_registry: Arc<crate::engine::tools::ToolRegistry>,
    pub task_tree: Arc<tokio::sync::Mutex<crate::engine::task_tree::TaskTree>>,
    pub concurrency_manager: Arc<crate::engine::concurrency::ConcurrencyManager>,
    pub data_dir: std::path::PathBuf,
}
```

- [ ] **Step 3a: run_turn 增加 api_messages_override 参数**

为了支持 Fork 模式直接传入 api_messages（绕过 history_to_api_messages 转换），在 `run_turn` 签名中增加：

```rust
pub async fn run_turn(
    &self,
    // ... 现有 13 个参数不变
    tool_ctx: Option<ToolExecutionContext>,
    api_messages_override: Option<Vec<serde_json::Value>>,  // 新增第 14 个参数
) -> Result<Vec<TranscriptEntry>, AppError>
```

在 `run_turn` 内部，`history_to_api_messages` 调用前检查：

```rust
let mut api_messages = match api_messages_override {
    Some(msgs) => msgs,  // Fork 模式：直接使用
    None => history::history_to_api_messages(&all),  // Preset 模式：从 history 转换
};
```

**对现有调用者的影响：**
- `api/commands.rs` 的 `send_message` — 传 `None`
- `agent_spawner.rs` 的 `run_subagent` — Fork 时传 `config.fork_api_messages`
- `loop_/mod.rs` 的两个测试 — 传 `None`（第 14 个参数）

- [ ] **Step 4: 实现 AgentSpawner trait**

核心逻辑：

```rust
#[async_trait]
impl AgentSpawner for DefaultAgentSpawner {
    async fn spawn_agent(&self, config: SpawnConfig) -> Result<SpawnHandle, AppError> {
        // 1. 并发控制：获取 permit（排队等待，不消耗预算）
        let permit = self.concurrency_manager.acquire().await
            .map_err(|e| AppError::Tool(format!("concurrency limit: {e}")))?;

        // 2. 创建子 event channel + bridge
        let (sub_tx, sub_rx) = tokio::sync::mpsc::unbounded_channel();
        let bridge_handle = bridge_events(
            sub_rx, config.event_tx.clone(),
            config.task_id.clone(), config.session_id.clone(),
        );

        // 3. 过滤工具注册表（按 tool_filter 白名单）
        let sub_registry = filter_tools(&self.tool_registry, config.tool_filter.as_deref());

        // 4. 构建 PromptManager
        let prompt_manager = match &config.system_prompt_override {
            Some(p) => PromptManager::new_with_prompt(p),
            None => PromptManager::new(),
        };

        // 5. 创建 BudgetGuard
        let mut budget_guard = BudgetGuard::new(config.budget.clone());

        // 6. 构建 history
        //    preset: 单条 User message
        //    fork: build_fork_messages 返回 Vec<serde_json::Value>，
        //          需要包装为 TranscriptEntry::User（见下方 helper）
        let history = build_subagent_history(&config);

        // 7. 创建 AgentLoop
        let agent_loop = AgentLoop::new(
            self.provider.clone(),
            format!("sub-{}", config.session_id),
            self.model.clone(),
        );

        // 8. 持有运行时依赖的 owned 值
        let task_tree = self.task_tree.clone();
        let data_dir = self.data_dir.clone();
        let agent_config = self.config.clone();
        let task_id = config.task_id.clone();

        // 9. sync/async 分支
        if config.sync {
            // 同步：直接 await
            let _permit = permit; // 持有 permit 直到完成
            let result = run_subagent(
                agent_loop, config, history, sub_tx,
                &sub_registry, &prompt_manager, &agent_config,
                &mut budget_guard, &task_tree, &data_dir,
            ).await;

            // drop(sub_tx) 已在 run_subagent 内完成（AgentLoop 持有）
            let _ = bridge_handle.await; // 等待 bridge drain

            Ok(SpawnHandle {
                task_id,
                result: Some(result),
            })
        } else {
            // 异步：tokio::spawn 后台执行
            let join_handle = tokio::spawn(async move {
                let _permit = permit;
                run_subagent(
                    agent_loop, config, history, sub_tx,
                    &sub_registry, &prompt_manager, &agent_config,
                    &mut budget_guard, &task_tree, &data_dir,
                ).await
            });

            Ok(SpawnHandle {
                task_id,
                join_handle: Some(join_handle),
                result: None,
            })
        }
    }
}
```

**关键实现细节：**

- `run_subagent` 是一个独立 async fn，内部调用 `agent_loop.run_turn()`，然后写入 sidechain JSONL，返回 `AgentSpawnResult`。完整签名和流程：

```rust
async fn run_subagent(
    agent_loop: AgentLoop,
    config: SpawnConfig,
    history: Vec<TranscriptEntry>,
    sub_tx: UnboundedSender<AgentEvent>,
    sub_registry: &ToolRegistry,
    prompt_manager: &PromptManager,
    agent_config: &AgentConfig,
    budget_guard: &mut BudgetGuard,
    task_tree: &Arc<Mutex<TaskTree>>,
    data_dir: &Path,
) -> Result<AgentSpawnResult, AppError> {
    let start = Instant::now();

    // Fork 模式：需要特殊处理 history → api_messages 转换
    // 方案：给 run_turn 增加 api_messages_override 参数
    // 当 fork_api_messages 存在时，run_turn 跳过 history_to_api_messages，
    // 直接使用 fork_api_messages 作为 LLM 请求的 messages
    let api_messages_override = config.fork_api_messages.clone();

    let entries = agent_loop.run_turn(
        config.prompt.clone(),
        history,
        None,
        sub_tx,
        sub_registry,
        &config.permission_context,
        prompt_manager,
        &config.dynamic_context,
        agent_config,
        Some(budget_guard),
        Some(task_tree.clone()),
        config.node_id,
        None,  // 子 Agent 不传 tool_ctx
        api_messages_override,  // 新增参数（见 Step 3a）
    ).await?;

    // 写入 sidechain JSONL
    let sidechain = sidechain_path(data_dir, &config.session_id, &config.task_id);
    for entry in &entries {
        append_sidechain_entry(&sidechain, entry)?;
    }

    // 提取结果文本
    let result_text: String = entries.iter()
        .filter_map(|e| match e {
            TranscriptEntry::Assistant { content, .. } => Some(
                content.iter()
                    .filter_map(|b| match b {
                        AssistantContentBlock::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            ),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");

    // 截断到 100K 字符
    let result_summary: String = result_text.chars().take(100_000).collect();

    // 写入 TaskNode 的 result_summary
    {
        let mut tree = task_tree.lock().await;
        tree.set_task_result(&config.task_id, result_summary.clone());
    }

    let elapsed = start.elapsed().as_millis() as u64;
    Ok(AgentSpawnResult {
        entries,
        usage: TaskUsage { total_tokens: 0, duration_ms: elapsed },
        status: "completed".into(),
        output_file: Some(sidechain),
    })
}
```

- `run_turn` 的 `agent_config` 参数使用 `DefaultAgentSpawner` 持有的 `self.config`（`AgentConfig` 类型），**不是** `SpawnConfig`
- 子 Agent 不传 `ToolExecutionContext`（传 `None`），因为：
  - 防递归：子 Agent 不应再调用 dispatch_agent/orchestrate
  - 防护靠工具过滤（tool_filter 排除 dispatch_agent/orchestrate），不靠 ctx 有无
  - P1 工具（Read/Write/Bash）当前内部 `let _ = ctx`，不需要 ctx 中的任何字段
- `bridge_events` 从 dispatch_agent.rs 移动到 agent_spawner.rs 作为 `pub fn`
- `sub_tx` 传入 `run_turn` 后被 AgentLoop 持有，AgentLoop 完成后 drop，bridge 的 recv 返回 None 自动结束

**SpawnHandle 修改（与 spec 的有意偏离）：**
```rust
pub struct SpawnHandle {
    pub task_id: String,
    pub join_handle: Option<tokio::task::JoinHandle<Result<AgentSpawnResult, AppError>>>,
    pub result: Option<Result<AgentSpawnResult, AppError>>,  // sync 时直接填充
}
```

与 spec 的区别：spec 中 sync 模式 `join_handle = None` 且通过返回值获取结果。plan 中增加了 `result` 字段，sync 模式直接存储结果，避免调用者需要 unwrap Option。两者设计意图一致。

- [ ] **Step 5: 实现 helper 函数**

`build_subagent_history` — 将 SpawnConfig 转为 `Vec<TranscriptEntry>`：

```rust
fn build_subagent_history(config: &SpawnConfig) -> Vec<TranscriptEntry> {
    match &config.fork_api_messages {
        Some(api_messages) => {
            // Fork 模式：api_messages 是 Vec<serde_json::Value>
            // build_fork_messages 已追加 user message
            // 包装为单条 User TranscriptEntry
            let uuid = uuid::Uuid::new_v4().to_string();
            vec![TranscriptEntry::User {
                uuid,
                parent_uuid: None,
                timestamp: chrono::Utc::now().to_rfc3339(),
                session_id: config.session_id.clone(),
                content: vec![UserContentBlock::Text {
                    text: format!("Processing fork context with {} messages", api_messages.len()),
                }],
            }]
            // 注意：实际 fork 需要将 api_messages 传入 AgentLoop，
            // 可能需要 run_turn 支持直接接收 api_messages 而非 TranscriptEntry
            // 这取决于 history → api_messages 转换在哪里发生
        }
        None => {
            // Preset 模式：单条用户消息
            let uuid = uuid::Uuid::new_v4().to_string();
            vec![TranscriptEntry::User {
                uuid,
                parent_uuid: None,
                timestamp: chrono::Utc::now().to_rfc3339(),
                session_id: config.session_id.clone(),
                content: vec![UserContentBlock::Text {
                    text: config.prompt.clone(),
                }],
            }]
        }
    }
}
```

**Fork 模式的 history 问题：**
`build_fork_messages` 返回 `Vec<serde_json::Value>`（API 格式），而 `run_turn` 接受 `Vec<TranscriptEntry>`。
两个方案：
- **方案 A（推荐）**：Fork 模式在 SpawnConfig 中存储 api_messages，在 `run_subagent` 内绕过 `history_to_api_messages` 转换，直接使用 api_messages
- **方案 B**：将 api_messages 反序列化为 TranscriptEntry（复杂，且 API 格式与存储格式不同）

选方案 A：SpawnConfig 增加 `fork_api_messages` 字段（已有），`run_subagent` 检测到 fork_api_messages 时直接用它作为 LLM 请求的 messages，跳过 history 转换。这需要在 AgentLoop 内部或 run_subagent 中做特殊处理。

- [ ] **Step 6: 实现 filter_tools helper**

```rust
fn filter_tools(registry: &ToolRegistry, filter: Option<&[String]>) -> ToolRegistry {
    let mut sub = ToolRegistry::new();
    for name in registry.tool_names() {
        if let Some(allowed) = filter {
            if !allowed.contains(&name) { continue; }
        }
        if let Some(tool) = registry.get(&name) {
            sub.register(tool.clone());
        }
    }
    sub
}
```

- [ ] **Step 7: 写测试**

使用 `MockLlmProvider` 测试 sync 路径返回正确结果。

- [ ] **Step 8: cargo test + commit**

```bash
cd src-tauri && cargo test agent_spawner
git add src/engine/agent_spawner.rs
git commit -m "feat(P2): implement DefaultAgentSpawner with sync/async spawn"
```

---

## Task 2: TaskNode 扩展 + ToolExecutionContext 加入 agent_spawner

**Files:**
- Modify: `src-tauri/src/engine/task_tree.rs`（TaskNode 加 result_summary/result_injected）
- Modify: `src-tauri/src/engine/tools/context.rs`（加 agent_spawner + orchestrate_depth）
- Modify: `src-tauri/src/api/mod.rs`（AppState 加 agent_spawner）
- Modify: `src-tauri/src/api/commands.rs`（ToolExecutionContext 注入 agent_spawner）

**注意：** TaskNode 扩展必须在 Task 1 之前完成，因为 `run_subagent` 需要写入 `result_summary`。但为了最小化变更范围，将 TaskNode 扩展合并到本 Task 中，并在 Task 1 的 Step 4 中引用（实现者需先完成本 Task 的 Step 1-2 再回到 Task 1 Step 4）。

**Files:**
- Modify: `src-tauri/src/engine/tools/context.rs`
- Modify: `src-tauri/src/api/mod.rs`
- Modify: `src-tauri/src/api/commands.rs`

- [ ] **Step 1: context.rs 加入 agent_spawner 字段**

```rust
use crate::engine::agent_spawner::AgentSpawner;

pub struct ToolExecutionContext {
    pub agent_spawner: Arc<dyn AgentSpawner>,  // 新增
    pub task_tree: Arc<tokio::sync::Mutex<TaskTree>>,
    // ... 其余不变
}
```

- [ ] **Step 2: api/mod.rs AppState 加入 agent_spawner 字段并构造**

```rust
pub struct AppState {
    // ... 现有字段
    pub agent_spawner: Arc<dyn crate::engine::agent_spawner::AgentSpawner>,
}
```

AppState 构造时从已有字段创建 DefaultAgentSpawner。

- [ ] **Step 3: commands.rs 传入 agent_spawner**

在 send_message 的 ToolExecutionContext 构造中加入 `agent_spawner: state.agent_spawner.clone()`。

- [ ] **Step 4: 更新所有测试中 ToolExecutionContext 的构造**

dispatch_agent 和 orchestrate 测试中需要构造测试用 DefaultAgentSpawner（用 MockLlmProvider）。

- [ ] **Step 5: cargo check + cargo test + commit**

```bash
cd src-tauri && cargo check && cargo test
git add src/engine/tools/context.rs src/api/mod.rs src/api/commands.rs
git commit -m "feat(P2): add agent_spawner to ToolExecutionContext and AppState"
```

---

## Task 3: dispatch_agent sync/async 真正执行

**Files:**
- Modify: `src-tauri/src/engine/tools/dispatch_agent.rs`

**Context:** sync 模式返回 `"not yet implemented"` 错误，async 模式是 `sleep(100ms)` stub。

- [ ] **Step 1: 重写 sync 路径使用 agent_spawner**

替换 dispatch_agent.rs 中 `if is_sync { ... }` 块：
1. 查找模板（已实现）
2. 构建 SpawnConfig（tool_filter 来自模板的 tools 字段）
3. 调用 `ctx.agent_spawner.spawn_agent(config)?`
4. 从 AgentSpawnResult 提取 result_summary
5. 发送 TaskCompleted 事件（用实际 usage 和 duration）

- [ ] **Step 2: 重写 async 路径使用 agent_spawner**

替换 `else { ... }` 块：
1. 构建 SpawnConfig（同 sync，但 sync: false）
2. 调用 `ctx.agent_spawner.spawn_agent(config)?`
3. 将 SpawnHandle.join_handle 存入 `ctx.background_tasks`
4. 返回 task_notification XML

- [ ] **Step 3: 移除 bridge_events 到 agent_spawner 内部**

当前 bridge_events 在 dispatch_agent.rs 中定义。DefaultAgentSpawner 内部也需要调用。两个选择：
- 移动 bridge_events 到 agent_spawner.rs 作为 pub 函数
- 或在 DefaultAgentSpawner 内部重新实现

推荐：移动到 agent_spawner.rs，dispatch_agent.rs 通过 use 引用。

- [ ] **Step 4: 更新 dispatch_agent 测试**

验证 sync 路径返回实际结果而非 "not yet implemented"。

- [ ] **Step 5: cargo test + commit**

```bash
cd src-tauri && cargo test dispatch_agent
git add src/engine/tools/dispatch_agent.rs src/engine/agent_spawner.rs
git commit -m "feat(P2): dispatch_agent sync/async execution via AgentSpawner"
```

---

## Task 4: orchestrate sync/async 真正执行

**Files:**
- Modify: `src-tauri/src/engine/tools/orchestrate.rs`

**Context:** 当前返回 `"stub — pending AgentSpawner"` 文本。`current_depth` 硬编码为 0，`target_agent_id` 复用逻辑只有 idle 检查没有实际恢复执行。

### 深度获取

当前 `let current_depth = 0u32;` 是硬编码 stub。需要从 ToolExecutionContext 的 api_messages 中推断深度（检查 orchestrate 调用的嵌套层数），或在 ToolExecutionContext 中传递当前节点的 depth。

**方案：** 在 `ToolExecutionContext` 中增加 `orchestrate_depth: Option<u32>` 字段。`run_turn` 每次迭代更新此字段（从 agent content 中的 orchestrate tool_use 调用推断深度）。默认为 0（主 Agent）。

- [ ] **Step 1: ToolExecutionContext 加入 orchestrate_depth**

```rust
pub struct ToolExecutionContext {
    pub agent_spawner: Arc<dyn AgentSpawner>,
    pub orchestrate_depth: u32,  // 默认 0，嵌套时递增
    // ... 其余不变
}
```

**深度更新时机：** 不在 `run_turn` 内部自动推断（避免复杂解析）。由调用者在创建 SpawnConfig 时显式传入：
- 主 Agent（commands.rs）：depth = 0
- 子 Agent（DefaultAgentSpawner）：从 SpawnConfig 的 `dynamic_context` 或直接从 ToolExecutionContext 读取父深度，+1 后作为子 ctx 的 orchestrate_depth

具体地，在 `run_turn` 循环中（`loop_/mod.rs` 第 222-228 行附近），更新 `tool_ctx` 时顺便更新深度：

```rust
// 在 execute_batch 之前的 ctx 更新代码中
if let Some(ref mut ctx) = tool_ctx {
    // ctx.api_messages 和 current_assistant_content 已更新
    // orchestrate_depth 不需要在这里更新——它在 ToolExecutionContext 创建时确定
}
```

深度只在 orchestrate 工具的 `call()` 中使用（读取 `ctx.orchestrate_depth`），不需要每轮更新。

- [ ] **Step 2: TaskTree 注册 orchestrate 节点**

在执行前调用 `tree.create_orchestrate_node(...)` 注册节点。删除当前 `// TaskTree 注册留到 AgentSpawner 集成` 的注释，实际调用：

```rust
let node_id = generate_task_id("orchestrate");
let sidechain = crate::store::jsonl::orchestrate_path(&ctx.data_dir, &ctx.session_id, &node_id);
{
    let mut tree = ctx.task_tree.lock().await;
    tree.create_orchestrate_node(
        None,  // parent_id 从 ctx 获取（如果有）
        &ctx.session_id,
        if effective_type == "orchestrator" { NodeRole::Orchestrator } else { NodeRole::Executor },
        node_depth,  // 现在使用 ctx.orchestrate_depth + 1
        &task_description,
        &_directive,
        &agent_id,
        sidechain,
        Some(budget.clone()),
    );
}
```

- [ ] **Step 3: target_agent_id 复用路径**

当 `target_agent_id` 指定且 agent 为 idle 时：
1. 从 sidechain JSONL 加载该 agent 的历史 entries
2. 将历史 + 新 directive 合并作为 SpawnConfig 的 history
3. 分配新预算
4. 执行 `agent_spawner.spawn_agent()`

```rust
if let Some(ref agent_id) = target_agent_id {
    // 已有 idle 检查逻辑（已实现）
    // 新增：加载历史 + 重新激活
    let node = tree.get_orchestrate_node(agent_id).unwrap();
    let history = crate::store::jsonl::load_history(&node.sidechain_path)?.entries;
    // 构建 SpawnConfig，history 使用加载的历史 + 新 directive
    // ...
}
```

- [ ] **Step 4: 使用 agent_spawner 执行**

用 `ctx.agent_spawner.spawn_agent()` 替换 stub 代码：
- tool_filter 按 effective_type 决定
- `current_depth` 改为 `ctx.orchestrate_depth`
- `node_depth = current_depth + 1`

- [ ] **Step 5: 发送真实完成事件**

替换 stub 的 OrchestrateNodeCompleted，使用实际执行结果（从 AgentSpawnResult）。

- [ ] **Step 6: cargo test + commit**

```bash
cd src-tauri && cargo test orchestrate
git add src/engine/tools/orchestrate.rs src/engine/tools/context.rs
git commit -m "feat(P2): orchestrate sync/async execution via AgentSpawner"
```

---

## Task 5: 异步结果注入

**Files:**
- Modify: `src-tauri/src/api/mod.rs`（background_tasks 类型变更）
- Modify: `src-tauri/src/api/commands.rs`
- Modify: `src-tauri/src/engine/task_tree.rs`

**Context:** spec 定义了异步任务完成后，用户发送下一条消息时应注入已完成任务的结果。

### background_tasks 类型变更

当前 `AppState.background_tasks` 类型是 `HashMap<String, JoinHandle<()>>`，无法获取执行结果。需要改为存储结果：

**方案：** 不改 background_tasks 类型。异步任务的结果通过 **TaskTree** 传递：
- `DefaultAgentSpawner.spawn_agent()` async 模式下，`run_subagent` 完成后将结果写入 `TaskNode.result_summary`（通过 `ctx.task_tree`）
- `send_message` 从 TaskTree 查询已完成的异步任务，不依赖 JoinHandle 的返回值

这样 `background_tasks` 只用于跟踪任务是否完成（`is_finished()`），不需要改变类型。

- [ ] **Step 1: TaskNode 加入 result_summary + result_injected 字段**

在 `engine/task_tree.rs` 的 TaskNode 中加入：

```rust
pub struct TaskNode {
    // ... 现有字段
    pub result_summary: Option<String>,  // 异步任务完成后写入
    pub result_injected: bool,           // 标记是否已注入到主对话
}
```

新增方法：
- `set_result_summary(&mut self, summary: String)` — 异步任务完成时调用
- `completed_not_injected(&self, session_id: &str) -> Vec<&TaskNode>` — 查询已完成未注入的任务

类似地，OrchestrateNode 也需要 `result_injected: bool`。

- [ ] **Step 2: DefaultAgentSpawner async 完成时写入 result_summary**

在 `run_subagent` 完成后（无论 sync/async），将结果写入 TaskTree：

```rust
let summary = result_summary.chars().take(2000).collect();
{
    let mut tree = task_tree.lock().await;
    tree.set_task_result(&task_id, summary);
}
```

- [ ] **Step 3: commands.rs send_message 中注入异步结果**

在 `history_to_api_messages` 之后、发送给 LLM 之前：
1. 查询 TaskTree 中 `result_injected == false` 且 `result_summary.is_some()` 的任务
2. 调用 `inject_async_result()` 注入到 api_messages
3. 标记为 `result_injected = true`

- [ ] **Step 4: 实现 inject_async_result 函数**

```rust
fn inject_async_result(
    messages: &mut Vec<serde_json::Value>,
    desc: &str,
    result: &str,
    status: &str,
) {
    let prefix = if status == "failed" { "[FAILED]" } else { "[Background]" };
    let text = format!("{} task completed: {}\n{}", prefix, desc, result);
    // 保证消息交替性（见 spec "下一回合注入"）
    match messages.last().map(|m| m["role"].as_str()) {
        Some("user") => {
            messages.push(serde_json::json!({
                "role": "assistant",
                "content": [{ "type": "text", "text": text }]
            }));
            messages.push(serde_json::json!({
                "role": "user",
                "content": [{ "type": "text", "text": "[System: 以上是异步任务结果，请结合用户消息处理]" }]
            }));
        }
        _ => {
            messages.push(serde_json::json!({
                "role": "user",
                "content": [{ "type": "text", "text": format!("[System: 异步任务 {} 已完成，结果已就绪]", desc) }]
            }));
        }
    }
}
```

- [ ] **Step 5: cargo test + commit**

```bash
cd src-tauri && cargo test
git add src/api/mod.rs src/api/commands.rs src/engine/task_tree.rs src/engine/agent_spawner.rs
git commit -m "feat(P2): inject completed async task results into next user message"
```

---

## Task 6: 清理 dead_code 和空文件

**Files:**
- Modify: agent_spawner.rs, jsonl.rs — 移除 `#[allow(dead_code)]`
- Delete: `src-tauri/src/engine/subagent/mod.rs`（只有一行注释）

- [ ] **Step 1: 移除所有 P2 相关 dead_code 标记**

agent_spawner.rs 的 SpawnConfig/SpawnHandle/AgentSpawnResult 不再 dead。
jsonl.rs 的 sidechain_path/append_sidechain_entry/orchestrate_path 不再 dead。

- [ ] **Step 2: 删除 subagent/mod.rs**

该文件只有 `// P2: SubAgent dispatch`，无实际内容。如果 mod.rs 是 subagent/ 目录下唯一文件，整个目录删除。

- [ ] **Step 3: cargo check（0 warnings）+ cargo test + commit**

```bash
cd src-tauri && cargo check 2>&1 | grep warning  # 应无输出
cargo test
git add -A
git commit -m "chore(P2): remove dead_code annotations and empty subagent module"
```

---

## 验收标准

1. `dispatch_agent sync=true` → 创建子 AgentLoop 执行 prompt，返回结果文本（不再是 "not yet implemented"）
2. `dispatch_agent sync=false` → 后台执行，立即返回 task_notification
3. `orchestrate sync=true` → 创建编排节点并执行子 Agent
4. `orchestrate sync=false` → 后台执行编排节点
5. orchestrate `target_agent_id` 复用路径正常工作（idle agent 加载历史 + 重新执行）
6. 异步任务结果在用户下一条消息时自动注入
7. **142** 个现有测试全部通过（回归基线：2026-04-11 测得 142 passed）
8. `cargo check` 无 warnings
9. `npm run tauri dev` 中 dispatch_agent 真正执行子任务
