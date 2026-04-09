# P1-ToolRouter 设计规格

**版本**: v1 | **日期**: 2026-04-09 | **状态**: 已确认

---

## 目标

为 Agent 引擎添加工具调用能力：LLM 返回 `tool_use` 时，执行对应工具并将结果回传 LLM 继续推理。

## 不包含

- 具体内置工具实现（另文档）
- 上下文压缩（ContextManager，另文档）
- MCP 动态加载（P3）
- 前端工具调用 UI（另文档）

---

## 核心类型

### Tool trait

```rust
#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn input_schema(&self) -> serde_json::Value;   // JSON Schema
    fn is_concurrent_safe(&self) -> bool { true }   // 是否可与其他工具并发
    fn timeout_secs(&self) -> u64 { 30 }            // 执行超时
    async fn call(&self, input: serde_json::Value) -> ToolResult;
}

pub struct ToolResult {
    pub output: String,
    pub is_error: bool,
}
```

### ToolRegistry（Flat Registry）

```rust
pub struct ToolRegistry {
    tools: HashMap<String, Arc<dyn Tool>>,
}
```

关键方法：
- `register(tool)` — 注册工具
- `get(name)` — 按名称查找
- `is_allowed(name, session_perms)` — 权限检查
- `denial_reason(name, session_perms)` — 禁用原因描述
- `tool_schemas(session_perms)` — 生成传给 LLM 的工具列表（包含禁用工具）

### ToolExecutor

```rust
pub struct PendingToolCall {
    pub id: String,       // LLM 返回的 tool_use_id
    pub name: String,
    pub input: serde_json::Value,
}

pub struct ToolExecutionResult {
    pub id: String,
    pub output: String,
    pub is_error: bool,
}

impl ToolExecutor {
    pub async fn execute_batch(
        calls: Vec<PendingToolCall>,
        registry: &ToolRegistry,
        perms: &PermissionContext,
    ) -> Vec<ToolExecutionResult>;
}
```

---

## 并发调度

```
LLM 返回 N 个 tool_use
  → 按 is_concurrent_safe 分两组
     safe:     [a, b, c] → join_all 并发
     unsafe:   [d, e]    → 串行执行
  → 两组之间串行（先并发组，再串行组）
  → 收集结果，按 tool_use_id 回传 LLM
```

超时保护：每个工具按 `timeout_secs()` 强制超时，返回错误结果。

---

## 权限分层

**两层**：全局（AppState）+ Session 级别。

**判定逻辑**：
1. `name in global_forbidden` → 拒绝
2. `name in session_forbidden` → 拒绝
3. `global_allowed = Some(set)` 且 `name not in set` → 拒绝
4. `session_allowed = Some(set)` 且 `name not in set` → 拒绝
5. 允许

Session 层只能比全局更严格，不能放宽全局禁止的工具。

### 禁用工具的反馈策略

禁用的工具**不会从 schema 列表中移除**，LLM 仍然能看到工具定义。当 LLM 调用禁用工具时，返回明确的错误反馈：

```rust
ToolExecutionResult {
    id: call.id,
    output: format!(
        "Tool '{}' is not available: {}. You can use alternative approaches or ask the user.",
        call.name,
        registry.denial_reason(&call.name, &perms)
    ),
    is_error: true,
}
```

这样 LLM 知道工具存在但受限，可以选择替代方案或告知用户。

---

## LlmStreamEvent 扩展

新增变体（`src-tauri/src/services/llm.rs`）：

```rust
pub enum LlmStreamEvent {
    // 现有
    TextDelta { delta: String },
    ThinkingDelta { delta: String },
    MessageStop { usage: TokenUsage },
    Error { message: String },
    // 新增
    ToolUseStart { id: String, name: String },                    // content_block_start
    ToolUseInputDelta { id: String, partial_input: String },      // content_block_delta (json)
    ToolUseEnd { id: String },                                    // content_block_stop
}
```

SSE 解析需更新：处理 `content_block_start` 中的 `tool_use` 类型块。

---

## AgentEvent 扩展

新增变体（`src-tauri/src/models/event.rs`）：

```rust
pub enum AgentEvent {
    // 现有
    TextDelta { session_id: String, delta: String },
    ThinkingDelta { session_id: String, delta: String },
    MessageComplete { session_id: String, role: String, content: String, usage: TokenUsage },
    Error { session_id: String, message: String },
    // 新增
    ToolCallStart { session_id: String, tool_name: String, tool_use_id: String },
    ToolCallEnd { session_id: String, tool_use_id: String, is_error: bool },
}
```

---

## TranscriptEntry 扩展

> **已被 P1-AgentLoop 工具集成 spec 覆盖。**
> tool_use/tool_result 改为嵌入 Assistant/User 的 content block 中，不再作为独立 entry。
> 详见 `.claude/.superpowers/2026-04-09-P1-agentloop-tools/spec.md` 的 "TranscriptEntry 修订" 章节。

~~新增变体（`src-tauri/src/models/transcript.rs`）：~~

~~ToolCall, ToolResult 独立 entry~~

~~工具记录独立存储，不嵌入 Assistant 消息。~~ → 已改为嵌入 content block。

---

## AgentLoop 多轮循环

`run_turn` 改为循环：

```
loop {
    response = provider.chat_stream(messages, model, tools)

    match response.stop_reason {
        "end_turn" | "max_tokens" => break,
        "tool_use" => {
            tool_calls = collect_from_stream(response)
            results = executor.execute_batch(tool_calls, registry, perms)

            持久化 ToolCall + ToolResult entries
            发送 ToolCallStart/ToolCallEnd 事件

            messages.push(assistant_with_tool_use)
            messages.push(tool_result for each result)
            continue  // 下一轮
        }
        _ => break,
    }
}
```

最大轮次限制（默认 50，可配置），防止无限工具调用循环。详见 AgentLoop spec。

---

## 新增文件

| 文件 | 职责 |
|------|------|
| `src-tauri/src/services/tool_registry.rs` | Tool trait, ToolRegistry, PermissionContext |
| `src-tauri/src/services/tool_executor.rs` | ToolExecutor, 并发调度, 超时 |

## 修改文件

| 文件 | 变更 |
|------|------|
| `src-tauri/src/services/llm.rs` | LlmStreamEvent 新增 3 个变体, SSE 解析更新 |
| `src-tauri/src/services/agent_loop.rs` | run_turn 改多轮循环, 注入 ToolRegistry/Executor |
| `src-tauri/src/models/event.rs` | AgentEvent 新增 2 个变体 |
| `src-tauri/src/models/transcript.rs` | TranscriptEntry content 改为 content block（见 AgentLoop spec） |
| `src-tauri/src/commands/chat.rs` | 传递 ToolRegistry 到 AgentLoop |
| `src-tauri/src/lib.rs` | AppState 增加 ToolRegistry, 注册内置工具 |
| `src/types/index.ts` | AgentEvent 新增类型 |
| `src/components/ChatView.vue` | 展示工具调用状态 |

## 约束

- services/tool_registry.rs 和 tool_executor.rs 不 import tauri
- Tool trait 的 JSON Schema 输出必须兼容 Anthropic tool definition 格式
- 工具调用结果最大 100KB，超出截断
