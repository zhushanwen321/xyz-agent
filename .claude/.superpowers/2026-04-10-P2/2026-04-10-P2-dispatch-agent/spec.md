# P2-dispatch_agent + SubAgent 生命周期 设计规格

**版本**: v2 | **日期**: 2026-04-10 | **状态**: 设计中

---

## Tool trait 接口变更（BLOCKER 修复）

P1 的 `Tool` trait 签名无 context 参数，dispatch_agent 需要额外依赖。修改方案：

```rust
// Before（P1）
async fn call(&self, input: serde_json::Value) -> ToolResult;

// After（P2）
async fn call(&self, input: serde_json::Value, ctx: Option<&ToolExecutionContext>) -> ToolResult;
```

所有现有工具实现接收 `ctx: Option<&ToolExecutionContext>` 参数，内部不使用（`let _ = ctx;`）。
`execute_batch` / `execute_single` 签名同步增加 `ctx: Option<&ToolExecutionContext>` 参数，透传给 `tool.call()`。
仅在 `run_turn` 调用 `execute_batch` 时，为 dispatch_agent 构建 context 并传入。

---

## ToolExecutionContext

```rust
pub struct ToolExecutionContext {
    pub task_tree: Arc<Mutex<TaskTree>>,           // Mutex 提供内部可变性
    pub agent_templates: Arc<AgentTemplateRegistry>,
    pub provider: Arc<dyn LlmProvider>,
    pub config: Arc<AgentConfig>,
    pub prompt_manager: Arc<PromptManager>,         // 可配置的 PromptManager
    pub data_dir: PathBuf,
    pub session_id: String,
    pub event_tx: UnboundedSender<AgentEvent>,      // 主 Agent 的事件通道
    // 以下由 run_turn 在调用 execute_batch 前填充
    pub api_messages: Vec<serde_json::Value>,       // 当前 API messages（Fork 用）
    pub current_assistant_content: Vec<AssistantContentBlock>, // 当前轮 assistant content（Fork 用）
    pub tool_registry: Arc<ToolRegistry>,           // 父工具注册表（Fork 用）
}
```

**构建时机**：在 `run_turn` 的工具调用处，构建 `ToolExecutionContext` 并传入 `execute_batch`。每次工具调用前填充 `api_messages` 和 `current_assistant_content` 的最新值。

---

## PromptManager 可配置化（BLOCKER 修复）

P1 的 `PromptManager` 硬编码 `include_str!("../../prompts/system_static.md")`。SubAgent 需要使用模板的 system_prompt。

```rust
impl PromptManager {
    // P1 已有
    pub fn new() -> Self { /* include_str! */ }

    // P2 新增
    pub fn new_with_prompt(static_prompt: &str) -> Self {
        Self { static_prompt: static_prompt.to_string() }
    }
}
```

SubAgent 执行时用 `PromptManager::new_with_prompt(template.system_prompt)` 创建独立的 PromptManager。

---

## SubAgent 事件通道策略（BLOCKER 修复）

**方案：独立 channel + 选择性桥接。**

SubAgent 创建独立的 `mpsc::unbounded_channel()`。SubAgent 的 `AgentLoop::run_turn` 使用这个独立 channel。

主 Agent 的 `dispatch_agent` 工具内部：
1. 创建 SubAgent 专用 channel
2. 启动桥接 task：从 SubAgent channel 读取事件，只转发 TaskProgress/TaskCompleted/BudgetWarning 到主 event_tx
3. SubAgent 的 TextDelta/ThinkingDelta/ToolCallStart/ToolCallEnd 被丢弃（不推送到前端）

```rust
let (sub_tx, sub_rx) = tokio::sync::mpsc::unbounded_channel();

// 桥接 task
let bridge_tx = event_tx.clone();
tokio::spawn(async move {
    while let Some(event) = sub_rx.recv().await {
        match &event {
            AgentEvent::TaskProgress { .. } |
            AgentEvent::TaskCompleted { .. } |
            AgentEvent::BudgetWarning { .. } => {
                let _ = bridge_tx.send(event);
            }
            _ => {} // 丢弃 TextDelta 等
        }
    }
});
```

---

## dispatch_agent 工具

### 输入 Schema

```json
{
  "name": "dispatch_agent",
  "description": "启动子 Agent 处理复杂任务。可用模板：Explore(只读搜索)、Plan(只读规划)、general-purpose(全能)。Fork 模式继承父 Agent 上下文。",
  "input_schema": {
    "type": "object",
    "properties": {
      "description": { "type": "string", "description": "3-5 词任务摘要" },
      "prompt": { "type": "string", "description": "子 Agent 要执行的任务指令" },
      "mode": { "enum": ["preset", "fork"], "default": "preset", "description": "preset=模板+参数，fork=继承父上下文" },
      "subagent_type": { "type": "string", "description": "Agent 模板名（preset 模式必填）" },
      "run_in_background": { "type": "boolean", "default": false },
      "token_budget": { "type": "integer", "description": "token 预算，不填用模板默认值" },
      "max_turns": { "type": "integer", "description": "最大轮次，不填用模板默认值" }
    },
    "required": ["description", "prompt"]
  }
}
```

### 属性

- `is_concurrent_safe() → false` — 修改共享 TaskTree 且写入 JSONL
- `timeout_secs() → 600` — SubAgent 可能执行较长时间

---

## Agent 模板

```rust
pub struct AgentTemplate {
    pub name: &'static str,
    pub system_prompt: &'static str,
    pub tool_filter: ToolFilter,
    pub default_model: Option<&'static str>,
    pub is_read_only: bool,
    pub default_budget: TaskBudget,
}

pub enum ToolFilter {
    All,
    AllowList(&'static [&'static str]),
}
```

### 内置模板

| 模板 | 工具 | 只读 | 默认预算 |
|------|------|------|---------|
| Explore | Read, Bash | 是 | 50K tokens, 20 turns |
| Plan | Read, Bash | 是 | 80K tokens, 15 turns |
| general-purpose | Read, Write, Bash | 否 | 200K tokens, 50 turns |

所有模板的 tool_filter 始终排除 `dispatch_agent`（禁止嵌套）。

---

## SubAgent 执行流程

### Preset 模式

```
1. 查找 AgentTemplate
2. 过滤 ToolRegistry → 生成子 Agent 的 tool_schemas
3. 创建 PromptManager::new_with_prompt(template.system_prompt)
4. 构建 DynamicContext（cwd/model 继承，tool_names=过滤后列表）
5. 创建 BudgetGuard
6. 创建独立 event channel + 桥接 task
7. 注册 TaskNode → 发送 TaskCreated 到主 event_tx
8. 调用 AgentLoop::run_turn(prompt, [], None, sub_event_tx, filtered_registry, perms, sub_prompt_manager, dynamic_ctx, config, Some(budget_guard))
9. 等待完成 → 收集 entry → 截断 → 存文件
10. SubAgent entry 写入 JSONL（调用 append_entry，session_path 从 context 获取）
11. 更新 TaskNode → 发送 TaskCompleted
12. 返回 ToolResult（XML 通知）
```

### Fork 模式

```
1. 从 context 获取 api_messages（原始 API JSON，不是重新序列化的）
2. 从 context 获取 current_assistant_content
3. 调用 build_fork_messages(api_messages, current_assistant_content, directive)
4. 创建 BudgetGuard（预算 = min(父剩余, 100K)）
5. 创建独立 event channel + 桥接 task
6. 注册 TaskNode → 发送事件 → 执行 AgentLoop
7. run_turn 使用 fork_messages 作为 history
   - system = 父 PromptManager.build_system_prompt()（byte-identical 前缀）
   - tools = 父 tool_schemas（byte-identical 前缀）
   → API 命中 prompt cache
```

### Fork 消息构建

```rust
const FORK_PLACEHOLDER: &str = "Forked subagent placeholder";

fn build_fork_messages(
    api_messages: &[serde_json::Value],       // 原始 API JSON（来自 history_to_api_messages）
    last_assistant_content: &[AssistantContentBlock],
    directive: &str,
) -> Vec<serde_json::Value> {
    let mut msgs = api_messages.to_vec();
    msgs.push(json!({"role": "assistant", "content": last_assistant_content}));
    let mut user_content: Vec<UserContentBlock> = last_assistant_content.iter()
        .filter_map(|b| match b {
            AssistantContentBlock::ToolUse { id, .. } => Some(UserContentBlock::ToolResult {
                tool_use_id: id.clone(),
                content: FORK_PLACEHOLDER.to_string(),
                is_error: false,
            }),
            _ => None,
        }).collect();
    user_content.push(UserContentBlock::Text { text: format_fork_directive(directive) });
    msgs.push(json!({"role": "user", "content": user_content}));
    msgs
}
```

### Fork 行为约束

```
你是 Fork 子 Agent。严格规则：
1. 禁止调用 dispatch_agent
2. 只执行指令范围内的任务
3. 不要提问或建议后续步骤
4. 直接使用工具执行
5. 报告 ≤500 字，以 "范围:" 开头
```

---

## SubAgent JSONL 写入策略

SubAgent 产生的 entry 直接写入主 session JSONL：

- dispatch_agent 内部调用 `jsonl::append_entry(&session_path, entry)` 写入每个 SubAgent entry
- session_path 从 `ToolExecutionContext.data_dir` + `session_id` 构建
- 与主 Agent entry 混在同一 JSONL，通过 TaskNode 的 `transcript_start/end` uuid 范围关联

---

## 结果回传

### 截断

- 结果截断到 100,000 字符
- 完整输出保存到 `{data_dir}/tasks/output/{task_id}.txt`

### XML 通知

```xml
<task_notification>
  <task_id>{id}</task_id>
  <status>completed|failed|budget_exhausted</status>
  <result>{截断后结果}</result>
  <output_file>{path}</output_file>
  <usage>
    <total_tokens>N</total_tokens>
    <tool_uses>N</tool_uses>
    <duration_ms>N</duration_ms>
  </usage>
</task_notification>
```

---

## 同步 vs 异步

P2 优先实现同步模式。异步模式预留接口，标记为 TODO。

---

## 约束

- dispatch_agent 不 import tauri
- 禁止嵌套
- Fork 强制继承父 model
- 结果截断 ≤ 100K 字符
- is_concurrent_safe = false

## 已知限制

- **异步模式未实现**
- **无 Agent 记忆**
- **无 MCP 按需加载**
- **工具过滤简单** — 只有白名单
