# Plan B: LlmProvider 扩展 + AgentLoop 多轮循环

> 依赖：Plan A（TranscriptEntry ContentBlock, ToolRegistry, ToolExecutor, AgentConfig）

---

## Task 8.5: MockLlmProvider 测试基础设施

**Files:**
- Create: `src-tauri/src/services/test_utils.rs`（`#[cfg(test)]` only）

Plan B 的 consume_stream、多轮循环、以及 Plan C 的 compact_with_llm 都需要 mock provider。提前准备。

- [ ] **Step 1: 实现 MockLlmProvider**

```rust
#[cfg(test)]
pub struct MockLlmProvider {
    pub responses: Vec<Vec<LlmStreamEvent>>,  // 按调用顺序返回
    pub call_count: std::sync::atomic::AtomicUsize,
}

impl MockLlmProvider {
    pub fn new(responses: Vec<Vec<LlmStreamEvent>>) -> Self { ... }
}
```

实现 `LlmProvider` trait：`chat_stream` 返回预设的 stream 事件。

- [ ] **Step 2: 实现辅助构造器**

```rust
// 快速构造纯文本响应
pub fn text_response(text: &str) -> Vec<LlmStreamEvent>;
// 构造带 tool_use 的响应
pub fn tool_use_response(text: &str, tool_calls: Vec<(&str, &str, Value)>) -> Vec<LlmStreamEvent>;
```

- [ ] **Step 3: 提交**

```bash
git commit -m "test: MockLlmProvider 测试基础设施"
```

---

## Task 9: LlmStreamEvent 新增变体

**Files:**
- Modify: `src-tauri/src/services/llm.rs`

**Spec 参考:** `.claude/.superpowers/2026-04-09-P1-agentloop-tools/spec.md` LlmStreamEvent 扩展

- [ ] **Step 1: 添加 3 个变体**

```rust
#[serde(rename = "tool_use_start")]
ToolUseStart { id: String, name: String },
#[serde(rename = "tool_use_input_delta")]
ToolUseInputDelta { id: String, partial_input: String },
#[serde(rename = "tool_use_end")]
ToolUseEnd { id: String },
```

- [ ] **Step 2: 更新 SSE 解析 map_sse_event**

处理 Anthropic SSE 事件：
- `content_block_start` 中 `type: "tool_use"` → `ToolUseStart`
- `content_block_delta` 中 `input_json_delta` → `ToolUseInputDelta`
- `content_block_stop`（对应 tool_use block）→ `ToolUseEnd`
- `message_delta` 中提取 `stop_reason`（目前只提取 usage）

- [ ] **Step 3: 写测试**

用模拟 SSE 数据测试新的解析逻辑。

- [ ] **Step 4: 提交**

```bash
cargo test && git commit -m "feat: LlmStreamEvent 新增 ToolUse 相关变体 + SSE 解析"
```

---

## Task 10: LlmProvider trait 扩展（system + tools 参数）

**Files:**
- Modify: `src-tauri/src/services/llm.rs`

**Spec 参考:** PromptManager spec 和 AgentLoop spec 的接口统一

- [ ] **Step 1: 更新 trait 签名**

```rust
async fn chat_stream(
    &self,
    system: Vec<serde_json::Value>,
    messages: Vec<serde_json::Value>,
    model: &str,
    tools: Option<Vec<serde_json::Value>>,
) -> Result<Pin<Box<dyn Stream<Item = Result<LlmStreamEvent, AppError>> + Send>>, AppError>;
```

- [ ] **Step 2: 更新 AnthropicProvider 实现**

请求体构建：
```rust
let mut body = json!({
    "model": model,
    "system": system,
    "messages": messages,
    "stream": true,
    "max_tokens": 8192,
});
if let Some(tools) = tools {
    body["tools"] = json!(tools);
}
```

- [ ] **Step 3: 更新 agent_loop.rs 中的调用点**

`provider.chat_stream(messages, &model)` → `provider.chat_stream(system, messages, &model, None)`。P0 的纯对话调用传 `system: vec![]` 和 `tools: None`。

- [ ] **Step 4: 运行测试 + 提交**

```bash
cargo test && git commit -m "feat: LlmProvider trait 加 system + tools 参数"
```

---

## Task 11: history_to_api_messages 重构

**Files:**
- Modify: `src-tauri/src/services/agent_loop.rs`

- [ ] **Step 1: 重写 history_to_api_messages**

利用 ContentBlock 直接序列化，不再需要分组算法：

```rust
fn history_to_api_messages(history: &[TranscriptEntry]) -> Vec<serde_json::Value> {
    history.iter()
        .filter_map(|entry| match entry {
            TranscriptEntry::User { content, .. } => Some(json!({
                "role": "user",
                "content": content,
            })),
            TranscriptEntry::Assistant { content, .. } => Some(json!({
                "role": "assistant",
                "content": content,
            })),
            _ => None,
        })
        .collect()
}
```

- [ ] **Step 2: 更新测试**

- [ ] **Step 3: 提交**

```bash
cargo test && git commit -m "refactor: history_to_api_messages 利用 ContentBlock 直接序列化"
```

---

## Task 12: consume_stream 函数

**Files:**
- Modify: `src-tauri/src/services/agent_loop.rs`

**Spec 参考:** AgentLoop spec 的 consume_stream 章节

- [ ] **Step 1: 定义 StreamResult**

```rust
struct StreamResult {
    content_blocks: Vec<AssistantContentBlock>,
    tool_calls: Vec<PendingToolCall>,
    stop_reason: String,
    usage: TokenUsage,
}
```

- [ ] **Step 2: 实现 consume_stream**

核心数据结构：
```rust
let mut text_buf = String::new();
let mut tool_buf: HashMap<String, (String, String)> = HashMap::new();  // id → (name, accumulated_json)
let mut content_blocks: Vec<AssistantContentBlock> = Vec::new();
let mut tool_calls: Vec<PendingToolCall> = Vec::new();
let mut stop_reason = String::new();
let mut usage = TokenUsage { input_tokens: 0, output_tokens: 0 };
```

处理每种 LlmStreamEvent：
- `TextDelta` → `text_buf.push_str(delta)`
- `ToolUseStart { id, name }` → 先 flush text_buf 为 Text block（如有），然后 `tool_buf.insert(id, (name, String::new()))`
- `ToolUseInputDelta { id, partial_input }` → `tool_buf.get_mut(id).1.push_str(partial_input)`
- `ToolUseEnd { id }` → 从 tool_buf 取出，解析 JSON，构造 `AssistantContentBlock::ToolUse` + `PendingToolCall`
- `MessageStop { usage: u }` → 记录 usage 和 stop_reason（从 SSE message_delta 事件提取）
- `Error` → 返回错误
- `Error` → 返回错误

文本 flush 逻辑：ToolUseStart 时将累积文本 flush 为 Text block。

- [ ] **Step 3: 写测试**

用 mock stream 测试各种事件序列。

- [ ] **Step 4: 提交**

```bash
cargo test && git commit -m "feat: consume_stream 收集多类型 SSE 事件"
```

---

## Task 13: AgentLoop 多轮循环

**Files:**
- Modify: `src-tauri/src/services/agent_loop.rs`

**Spec 参考:** AgentLoop spec 的循环逻辑章节

- [ ] **Step 1: 更新 run_turn 签名**

```rust
pub async fn run_turn(
    &self,
    user_message: String,
    history: Vec<TranscriptEntry>,
    parent_uuid: Option<String>,
    event_tx: UnboundedSender<AgentEvent>,
    tool_registry: &ToolRegistry,
    tool_perms: &PermissionContext,
    prompt_manager: &PromptManager,
    dynamic_context: &DynamicContext,
) -> Result<Vec<TranscriptEntry>, AppError>
```

> 注意：PromptManager 和 DynamicContext 在 Plan C 实现。此处先用 `// TODO: Plan C` 占位，暂时传空 system prompt。

- [ ] **Step 2: 实现多轮循环**

```
entries = []
tool_schemas = registry.tool_schemas(perms)
config = AgentConfig::load()  // Plan A Task 9
iterations = 0

loop {
    iterations += 1
    api_messages = history_to_api_messages(&history) + entries_to_messages(&entries)
    stream = provider.chat_stream(vec![], api_messages, &model, Some(tool_schemas))

    result = consume_stream(stream, &event_tx, session_id)

    entries.push(Assistant { content: result.content_blocks, usage })
    emit MessageComplete

    if stop_reason != "tool_use" || tool_calls.is_empty() { break }

    results = executor.execute_batch(tool_calls, registry, perms)
    emit ToolCallStart/ToolCallEnd

    user_content = results → UserContentBlock::ToolResult
    entries.push(User { content: user_content })

    if iterations >= config.max_turns {
        emit warning: "已达到最大轮次限制"
        break
    }
}
```

> max_turns 从 AgentConfig 读取（Plan A Task 9），不硬编码。

- [ ] **Step 3: 更新 chat.rs**

```rust
// 使用 load_history（Plan C Task 19）替代 read_all_entries
let LoadHistoryResult { entries: history, conversation_summary } = jsonl::load_history(&path)?;

// 构建 DynamicContext（P1 阶段 conversation_summary 来自 load_history）
let dynamic_context = DynamicContext {
    cwd: std::env::current_dir()?.to_string_lossy().to_string(),
    os: "macos".into(),
    model: state.model.clone(),
    git_branch: None,
    tool_names: state.tool_registry.tool_names(),
    data_context_summary: None,
    conversation_summary,
};

// run_turn 签名已包含 tool_registry 和 tool_perms
let new_entries = agent_loop.run_turn(
    user_message, history, parent_uuid, event_tx,
    &state.tool_registry, &state.global_perms,
    &state.prompt_manager, &dynamic_context,
).await?;

// 逐条追加（含 Summary entry，由 Plan C ContextManager 生成）
for entry in &new_entries {
    jsonl::append_entry(&path, entry)?;
}
```

> 注意：Plan B 阶段 prompt_manager 和 dynamic_context 用 `// TODO: Plan C` 占位，
> chat.rs 仍用 `read_all_entries`。Plan C Task 21 会统一替换为上述代码。

- [ ] **Step 4: 写集成测试**

测试多轮循环（mock provider 返回 tool_use → mock tool 执行 → 继续循环）。

- [ ] **Step 5: 提交**

```bash
cargo test && git commit -m "feat: AgentLoop 多轮工具调用循环"
```

---

**Plan B 完成标志**: AgentLoop 能执行多轮工具调用，chat.rs 能处理 Vec<TranscriptEntry>。
