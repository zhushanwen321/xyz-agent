# P1-AgentLoop 工具集成 设计规格

**版本**: v1 | **日期**: 2026-04-09 | **状态**: 已确认

---

## 目标

将 ToolRouter + 内置工具接入 AgentLoop，实现多轮工具调用循环：LLM 返回 `tool_use` 时执行工具，将结果回传 LLM 继续推理。

## 不包含

- 流式工具执行（StreamingToolExecutor，TODO：后续优化）
- 上下文压缩（ContextManager，另文档）
- 前端工具调用 UI（另文档）

## 参考

- Claude Code `query.ts`：queryLoop 实现
- Claude Code `StreamingToolExecutor.ts`：流式工具执行（P1 不实现）
- Claude Code `tools.ts`：工具注册和组装
- Claude Code `utils/messages.ts`：消息规范化

---

## TranscriptEntry 修订

> 修订 ToolRouter spec 中的 TranscriptEntry 扩展。将 tool_use/tool_result 嵌入 Assistant/User 的 content 中，而非独立 entry。

### 新增类型

```rust
// Assistant 消息的 content block
#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "type")]
pub enum AssistantContentBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "tool_use")]
    ToolUse { id: String, name: String, input: serde_json::Value },
}

// User 消息的 content block
#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "type")]
pub enum UserContentBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "tool_result")]
    ToolResult { tool_use_id: String, content: String, is_error: bool },
}
```

### TranscriptEntry 变更

```rust
// Before（ToolRouter spec 原设计）
Assistant { content: String, ... }
ToolCall { tool_use_id, name, input, ... }    // 删除
ToolResult { tool_use_id, output, ... }       // 删除

// After
Assistant {
    uuid: String,
    parent_uuid: Option<String>,
    timestamp: String,
    session_id: String,
    content: Vec<AssistantContentBlock>,   // 可包含 Text + ToolUse
    usage: Option<TokenUsage>,
}

User {
    uuid: String,
    parent_uuid: Option<String>,
    timestamp: String,
    session_id: String,
    content: Vec<UserContentBlock>,        // 可包含 Text + ToolResult
}
```

**理由**：
- 消除 `history_to_api_messages` 的分组重建逻辑
- 存储格式直接对齐 Anthropic API 格式
- 前端渲染通过 SSE 事件（AgentEvent）实现，与存储格式解耦
- 上下文压缩通过遍历 content block 处理

---

## LlmStreamEvent 扩展

新增 3 个变体（同 ToolRouter spec）：

```rust
ToolUseStart { id: String, name: String },
ToolUseInputDelta { id: String, partial_input: String },
ToolUseEnd { id: String },
```

### SSE 解析变更

`map_sse_event` 需更新：
- 解析 `content_block_start` 中 `type: "tool_use"` → `ToolUseStart`
- 解析 `content_block_delta` 中 `input_json_delta` → `ToolUseInputDelta`
- 解析 `content_block_stop` → `ToolUseEnd`
- **从 `message_delta` 提取 `stop_reason`**（目前只提取 usage）

---

## LlmProvider trait 变更

```rust
// Before
async fn chat_stream(
    &self,
    messages: Vec<serde_json::Value>,
    model: &str,
) -> Result<Pin<Box<dyn Stream<Item = Result<LlmStreamEvent, AppError>> + Send>>, AppError>;

// After
async fn chat_stream(
    &self,
    messages: Vec<serde_json::Value>,
    model: &str,
    tools: Option<Vec<serde_json::Value>>,  // JSON Schema 工具定义列表
) -> Result<Pin<Box<dyn Stream<Item = Result<LlmStreamEvent, AppError>> + Send>>, AppError>;
```

`tools` 为 `None` 时不传工具定义（纯对话模式）。

**已知限制**：`serde_json::Value` 使用 Anthropic 格式。多 provider 支持时需加转换层。

---

## history_to_api_messages 重构

不再需要分组算法。统一使用多 content block 格式：

```rust
pub fn history_to_api_messages(entries: &[TranscriptEntry]) -> Vec<serde_json::Value> {
    entries.iter()
        .filter_map(|entry| match entry {
            TranscriptEntry::User(e) => Some(json!({
                "role": "user",
                "content": e.content  // 直接序列化 UserContentBlock 数组
            })),
            TranscriptEntry::Assistant(e) => Some(json!({
                "role": "assistant",
                "content": e.content  // 直接序列化 AssistantContentBlock 数组
            })),
            _ => None,  // 跳过 System, CustomTitle, Summary
        })
        .collect()
}
```

---

## AgentLoop 多轮循环

### 签名变更

```rust
// Before
pub async fn run_turn(&self, ...) -> Result<TranscriptEntry, AppError>

// After
pub async fn run_turn(
    &self,
    user_message: String,
    history: Vec<TranscriptEntry>,
    parent_uuid: Option<String>,
    event_tx: UnboundedSender<AgentEvent>,
) -> Result<Vec<TranscriptEntry>, AppError>
```

### 循环逻辑

```
entries: Vec<TranscriptEntry> = []
tool_schemas = registry.tool_schemas(&perms)

loop {
    api_messages = history_to_api_messages(&history) + entries
    stream = provider.chat_stream(api_messages, model, Some(tool_schemas))

    (content_blocks, tool_calls, stop_reason, usage) = consume_stream(stream)

    assistant_entry = TranscriptEntry::Assistant { content: content_blocks, usage, ... }
    entries.push(assistant_entry)
    emit MessageComplete event

    if stop_reason != "tool_use" || tool_calls.is_empty() {
        break
    }

    // 执行工具
    results = executor.execute_batch(tool_calls, registry, perms)
    emit ToolCallStart/ToolCallEnd events

    // 构造 tool_result 的 User entry
    user_content = results.iter().map(|r| UserContentBlock::ToolResult { ... }).collect()
    entries.push(TranscriptEntry::User { content: user_content, ... })

    // 更新 assistant entry 的 content，加入 ToolUse blocks
    // （在构造 assistant_entry 时已包含，因为 consume_stream 收集了 tool_use）
}

// 迭代限制
if iterations >= max_turns {
    break with warning
}
```

### consume_stream 函数

从 SSE 流中收集所有信息：

```rust
struct StreamResult {
    content_blocks: Vec<AssistantContentBlock>,
    tool_calls: Vec<PendingToolCall>,
    stop_reason: String,
    usage: TokenUsage,
}
```

处理逻辑：
- `TextDelta` → 累积文本
- `ThinkingDelta` → 转发事件
- `ToolUseStart` → 记录新工具调用（id, name）
- `ToolUseInputDelta` → 累积对应 id 的 JSON 输入
- `ToolUseEnd` → 完成工具调用，加入 content_blocks 和 tool_calls
- `MessageStop` → 记录 usage 和 stop_reason

### 重试策略

- 只重试 LLM 调用（网络/API 错误），最多 3 次
- 工具执行失败 → 作为 `is_error: true` 的 ToolResult 回传 LLM

### 迭代限制

`max_turns` 作为参数传入（默认 50）。超过限制时 break 并发送 warning 事件。

---

## PermissionContext

两层权限：

```rust
pub struct PermissionContext {
    pub global_allowed: Option<HashSet<String>>,    // None = 允许所有
    pub global_forbidden: HashSet<String>,
    pub session_allowed: Option<HashSet<String>>,
    pub session_forbidden: HashSet<String>,
}
```

P1 实现：从 `config.toml` 读取 `allowed_tools` / `forbidden_tools`，存入 AppState。

---

## AppState 和初始化

```rust
pub struct AppState {
    pub data_dir: PathBuf,
    pub provider: Arc<dyn LlmProvider>,
    pub model: String,
    pub tool_registry: Arc<ToolRegistry>,       // NEW
    pub global_perms: PermissionContext,         // NEW
}
```

`lib.rs` 初始化：
```
1. 创建 ToolRegistry
2. register_builtin_tools(&mut registry, workdir)
3. 从 config.toml 加载 PermissionContext
4. 包装为 Arc<ToolRegistry>
5. 存入 AppState
```

工具注册表**不可变**（Arc，非 RwLock）。后续动态变化通过消息层增量追加。

---

## chat.rs 变更

```rust
// Before
let assistant_entry = agent_loop.run_turn(...).await?;
append_entry(&path, &assistant_entry)?;

// After
let entries = agent_loop.run_turn(...).await?;
for entry in &entries {
    append_entry(&path, entry)?;
}
```

AgentLoop 构造时注入 ToolRegistry 和 PermissionContext。

---

## 新增文件

| 文件 | 职责 |
|------|------|
| `src-tauri/src/services/tool_registry.rs` | Tool trait, ToolRegistry, PermissionContext |
| `src-tauri/src/services/tool_executor.rs` | ToolExecutor, 并发调度, 超时 |
| `src-tauri/src/services/tools/*.rs` | 内置工具（另见 builtins spec） |

## 修改文件

| 文件 | 变更 |
|------|------|
| `src-tauri/src/services/agent_loop.rs` | run_turn 改多轮循环, 返回 Vec, 注入 ToolRegistry |
| `src-tauri/src/services/llm.rs` | LlmStreamEvent 新增 3 变体, SSE 解析更新, LlmProvider trait 加 tools 参数 |
| `src-tauri/src/models/transcript.rs` | Assistant/User 的 content 改为 Vec<ContentBlock>, 新增 ContentBlock 枚举 |
| `src-tauri/src/models/event.rs` | AgentEvent 新增 ToolCallStart/ToolCallEnd |
| `src-tauri/src/commands/chat.rs` | 传递 ToolRegistry, 处理 Vec<TranscriptEntry> |
| `src-tauri/src/lib.rs` | AppState 增加 ToolRegistry + PermissionContext |
| `src/types/index.ts` | ContentBlock 类型, AgentEvent 新增变体 |

## TODO（后续优化）

- 流式工具执行（参考 Claude Code StreamingToolExecutor）
- 边执行边持久化（yield 模式，避免部分失败时丢失中间结果）
- 工具注册表动态层（MCP 工具增量追加，不影响静态层缓存）

## 约束

- `services/` 不 import tauri crate
- JSON Schema 兼容 Anthropic tool definition 格式
- 工具调用结果最大 100KB，超出截断
- `max_turns` 默认 50，可配置
