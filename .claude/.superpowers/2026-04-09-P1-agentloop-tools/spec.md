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

### 数据迁移

现有 JSONL 中 `content: String` 格式。改为 `content: Vec<ContentBlock>` 后旧数据反序列化失败。

**方案**：使用 serde 自定义反序列化（`#[serde(deserialize_with = "...")]`）兼容两种格式：
- 旧格式 `content: "text"` → 反序列化为 `vec![ContentBlock::Text { text: "text" }]`
- 新格式 `content: [{type: "text", text: "..."}]` → 直接反序列化

无需数据迁移脚本，向后兼容。

---

## LlmStreamEvent 扩展

新增 3 个变体（同 ToolRouter spec）：

```rust
#[serde(rename = "tool_use_start")]
ToolUseStart { id: String, name: String },
#[serde(rename = "tool_use_input_delta")]
ToolUseInputDelta { id: String, partial_input: String },
#[serde(rename = "tool_use_end")]
ToolUseEnd { id: String },
```

### SSE 解析变更

`map_sse_event` 需更新：
- 解析 `content_block_start` 中 `type: "tool_use"` → `ToolUseStart`
- 解析 `content_block_delta` 中 `input_json_delta` → `ToolUseInputDelta`
- 解析 `content_block_stop` → `ToolUseEnd`
- **从 `message_delta` 提取 `stop_reason`**（目前只提取 usage）

### ToolUseInputDelta 累积策略

`input_json_delta` 是 JSON 字符串的增量片段，直接按 id 拼接即可：
```rust
HashMap<String, (String, String)>  // id → (name, accumulated_json)
```
`ToolUseStart` 时创建条目，`ToolUseInputDelta` 时拼接 `partial_input`，`ToolUseEnd` 时解析完整 JSON 为 `serde_json::Value`。

---

## LlmProvider trait 变更

```rust
// Before
async fn chat_stream(
    &self,
    messages: Vec<serde_json::Value>,
    model: &str,
) -> Result<Pin<Box<dyn Stream<Item = Result<LlmStreamEvent, AppError>> + Send>>, AppError>;

// After（PromptManager spec 追加 system 参数）
async fn chat_stream(
    &self,
    system: Vec<serde_json::Value>,          // system prompt blocks（PromptManager 生成）
    messages: Vec<serde_json::Value>,
    model: &str,
    tools: Option<Vec<serde_json::Value>>,  // JSON Schema 工具定义列表
) -> Result<Pin<Box<dyn Stream<Item = Result<LlmStreamEvent, AppError>> + Send>>, AppError>;
```

`tools` 为 `None` 时不传工具定义（纯对话模式，如摘要请求）。
`system` 由 PromptManager.build_system_prompt() 生成，含 cache breakpoint。

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

// After（含 PromptManager/ContextManager/DataContext 集成）
pub async fn run_turn(
    &self,
    user_message: String,
    history: Vec<TranscriptEntry>,
    parent_uuid: Option<String>,
    event_tx: UnboundedSender<AgentEvent>,
    prompt_manager: &PromptManager,
    dynamic_context: &DynamicContext,
) -> Result<Vec<TranscriptEntry>, AppError>
```

### 循环逻辑

```
entries: Vec<TranscriptEntry> = []
tool_schemas = registry.tool_schemas(&perms)
system = prompt_manager.build_system_prompt(dynamic_context)

loop {
    api_messages = history_to_api_messages(&history) + entries
    api_messages = context_manager.trim_old_tool_results(api_messages)  // 第一层裁剪
    stream = provider.chat_stream(system, api_messages, model, Some(tool_schemas))

    (content_blocks, tool_calls, stop_reason, usage) = consume_stream(stream)

    assistant_entry = TranscriptEntry::Assistant { content: content_blocks, usage, ... }
    entries.push(assistant_entry)
    emit MessageComplete event

    if stop_reason != "tool_use" || tool_calls.is_empty() {
        break
    }

    // 执行工具
    results = executor.execute_batch(tool_calls, registry, perms)
    emit ToolCallStart/ToolCallEnd events（包含 tool_name/tool_use_id）

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
- `ToolUseStart` → 在累积 Map 中创建条目：`(id → (name, ""))`
- `ToolUseInputDelta` → 按 id 拼接 `partial_input` 到累积 Map
- `ToolUseEnd` → 从累积 Map 取出完整 JSON，解析为 Value，构造 `AssistantContentBlock::ToolUse` 加入 content_blocks，同时构造 `PendingToolCall` 加入 tool_calls
- `MessageStop` → 记录 usage 和 stop_reason
- `Error` → 触发重试或返回错误

**文本处理**：在 `ToolUseStart` 之前累积的文本，在 `ToolUseStart` 时 flush 为一个 `AssistantContentBlock::Text`。支持一段 assistant 消息中出现 "文本 → 工具调用1 → 工具调用2" 的混合 content。

### 重试策略

- 只重试 LLM 调用（网络/API 错误），最多 3 次
- 工具执行失败 → 作为 `is_error: true` 的 ToolResult 回传 LLM

> **vs Claude Code**：Claude Code 有多层恢复（withRetry 指数退避10次 + 模型 fallback + withheld 机制 + 上下文溢出恢复）。P1 只实现基础重试，后续逐步引入。

### 终止条件

| 退出路径 | 条件 |
|---------|------|
| `completed` | `stop_reason` 为 `end_turn`，无 tool_use |
| `max_tokens` | `stop_reason` 为 `max_tokens`，无 tool_use |
| `max_turns` | 迭代次数达到 `max_turns` 限制 |
| `model_error` | LLM 调用重试耗尽 |
| `aborted` | 用户中断（TODO：P1 不实现中断机制） |

> **vs Claude Code**：Claude Code 有 10 种退出路径（含 `blocking_limit`、`stop_hook_prevented`、`hook_stopped`、`image_error` 等）。P1 简化为 5 种。

### MessageComplete 事件适配

`AgentEvent::MessageComplete` 的 `content` 字段当前是 `String`。改为从 `Vec<AssistantContentBlock>` 中提取纯文本（拼接所有 Text block）。前端展示工具调用状态通过 `ToolCallStart/ToolCallEnd` 事件，不依赖 `MessageComplete.content`。

### 迭代限制

`max_turns` 作为参数传入（默认 50）。超过限制时 break 并发送 warning 事件。

---

## PermissionContext

独立结构体（不嵌入 ToolRegistry），两层权限：

```rust
pub struct PermissionContext {
    pub global_allowed: Option<HashSet<String>>,    // None = 允许所有
    pub global_forbidden: HashSet<String>,
    pub session_allowed: Option<HashSet<String>>,   // P1: 不实现，为 None
    pub session_forbidden: HashSet<String>,         // P1: 空
}
```

P1 实现：
- **全局权限**：从 `config.toml` 读取 `allowed_tools` / `forbidden_tools`，存入 AppState
- **Session 权限**：P1 不实现，字段为 None/空。后续通过 session 配置加载

ToolRouter spec 中 ToolRegistry 的 `global_allowed`/`global_forbidden` 字段已移除，权限检查改为接收外部 `PermissionContext` 参数。

> **vs Claude Code**：Claude Code 有四级决策（allow/deny/ask/passthrough）、LLM 分类器推测执行、竞态保护（ResolveOnce.claim）。P1 只有 allow/deny 两级，deny 永远优先。TODO：后续引入 ask 级别（用户确认对话框）和 LLM 辅助分类。

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

### 工具 Schema 排序

工具定义按名称字母排序后传给 LLM，保持稳定前缀。有利于 Anthropic API 的 prompt caching。

> **vs Claude Code**：`assembleToolPool()` 将内置工具按 name 排序形成连续前缀，服务端在最后一个内置工具后设 cache breakpoint。

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
- Hook 系统（参考 Claude Code 27 种事件类型，支持 pre/post tool use hooks）
- 子 Agent 调度（同步/异步/fork 三种模式，上下文隔离与继承）
- 多模态能力（图像理解、文件处理）
- 可调试性（决策链路追踪、消息 replay）

## 约束

- `services/` 不 import tauri crate
- JSON Schema 兼容 Anthropic tool definition 格式
- 工具调用结果最大 100KB，超出截断
- `max_turns` 默认 50，可配置

## 已知限制

- **部分失败丢失**：`run_turn` 返回 `Vec<TranscriptEntry>` 统一持久化。如果 LLM 调用彻底失败（重试耗尽），已执行的中间工具结果随 Err 丢失。TODO：后续改为边执行边持久化。
- **工具 schema 格式**：`tools` 参数使用 Anthropic 格式。多 provider 支持时需加转换层。

## 与 agent-benchmark 维度对照

### 1. Prompt 工程

| 设计点 | Claude Code | 本 spec P1 | 差距 |
|--------|------------|-----------|------|
| Tool schema 排序 | 内置工具排序形成稳定前缀 | 按名称排序 | 基本对齐 |
| Prompt cache | 全链路保护 | 工具排序 + 静态/动态分离 | 后续需 ContextManager 配合 |
| 动态 tool prompt | `prompt()` 函数按上下文组装 | 固定 description | TODO |

### 2. Context 工程

| 设计点 | Claude Code | 本 spec P1 | 差距 |
|--------|------------|-----------|------|
| 上下文压缩 | 5 层梯度响应 | 不涉及（ContextManager spec） | 另文档 |
| 工具结果预算 | applyToolResultBudget | 100KB 截断 | 基础对齐 |
| Token 效率 | 每个 token 有预算控制 | 无 | 需 ContextManager |

### 3. Harness 工程

| 设计点 | Claude Code | 本 spec P1 | 差距 |
|--------|------------|-----------|------|
| 权限模型 | 4 级（allow/deny/ask/passthrough） | 2 级（allow/deny） | TODO: ask 级别 |
| Fail-closed 默认值 | isConcurrencySafe=false, isReadOnly=false | Tool trait 同样设计 | 对齐 |
| Hook 系统 | 27 种事件类型 | 无 | TODO |
| 安全沙箱 | Bash 三层决策 + tree-sitter | 超时 + 输出截断 | TODO |
| MCP 集成 | 动态合并 + server 前缀 | 不涉及（P3） | 另文档 |

### 4. Agent Loop

| 设计点 | Claude Code | 本 spec P1 | 差距 |
|--------|------------|-----------|------|
| 循环结构 | while-true + AsyncGenerator | while-true loop | 对齐 |
| 终止条件 | 10 种退出路径 | 5 种 | P1 简化 |
| 错误恢复 | withRetry + fallback + withheld + 熔断 | 3 次重试 | TODO: 指数退避 |
| 流式工具执行 | StreamingToolExecutor | 不实现 | TODO |
| 取消机制 | AbortController 传递链 | 不实现 | TODO |

### 5-7. 子Agent / 多模态 / UX

P1 不涉及，后续逐步引入。
