# 代码链路分析报告

## 概述

- 分析文件：`src-tauri/src/services/llm.rs`
- 分析时间：2026-04-09
- 语言类型：Rust
- 文件职责：定义 LLM Provider 抽象层，实现 Anthropic SSE 流式解析和重试逻辑

---

## 调用链路图

### 下游调用（llm.rs 依赖）

```
llm.rs
  |-- crate::error::AppError          (error.rs)
  |     `- AppError::Llm(String) 用于所有 LLM 错误包装
  |
  |-- crate::models::TokenUsage       (models/transcript.rs)
  |     `- struct TokenUsage { input_tokens: u32, output_tokens: u32 }
  |
  |-- reqwest::Client                  (外部 crate v0.12)
  |     `- .post() / .header() / .json() / .send() / .bytes_stream()
  |
  |-- eventsource_stream::Eventsource  (外部 crate v0.2)
  |     `- .eventsource() 将 bytes_stream 转为 SSE 事件流
  |
  `-- futures::stream::StreamExt      (外部 crate futures v0.3)
        `- .map() 将 SSE 事件映射为 LlmStreamEvent
```

### 上游调用（llm.rs 被调用）

```
lib.rs
  |-- use services::llm::{AnthropicProvider, LlmProvider}
  |-- AnthropicProvider::new(api_key)              // 构造实例
  |-- Arc<dyn LlmProvider>                         // trait object 注入 AppState
  `-- 注意：with_base_url() 和 chat_stream_with_retry() 未被使用

agent_loop.rs
  |-- use crate::services::llm::LlmProvider
  |-- provider.chat_stream(messages, model)        // 核心：启动流式请求
  `-- 完整消费 LlmStreamEvent 四个变体：
        TextDelta / ThinkingDelta / MessageStop / Error

commands/chat.rs
  |-- 间接调用：通过 AgentLoop::run_turn -> provider.chat_stream
  `-- 不直接引用 llm.rs 的任何符号
```

### 完整调用链路

```
Tauri 前端
  `-- send_message (commands/chat.rs)
        |-- AppState.provider: Arc<dyn LlmProvider>
        |-- AgentLoop::new(provider, session_id)
        `-- agent_loop.run_turn(content, history, event_tx)
              |-- history_to_api_messages(&history)
              |-- provider.chat_stream(api_messages, model)
              |     `-- AnthropicProvider::chat_stream()
              |           |-- reqwest POST /v1/messages (stream: true)
              |           |-- bytes_stream().eventsource()
              |           `-- .map(map_sse_event)
              `-- while let Some(item) = stream.next().await
                    |-- TextDelta  -> full_content.push_str + event_tx.send
                    |-- ThinkingDelta -> event_tx.send
                    |-- MessageStop  -> final_usage = usage + event_tx.send
                    |-- Error        -> event_tx.send + return Err
                    `-- Err(e)       -> event_tx.send + return Err
```

---

## 数据链路图

### 请求数据流

```
TranscriptEntry[] (history)
  `-- history_to_api_messages() 过滤 User/Assistant
        `-- Vec<serde_json::Value> [{role, content}, ...]
              `-- push 当前 user message
                    `-- AnthropicProvider.chat_stream(messages, model)
                          `-- serde_json::json!({
                                model: "claude-sonnet-4-20250514",
                                messages: Vec<Value>,
                                stream: true,
                                max_tokens: 4096
                              })
                                `-- reqwest POST body
```

### 响应数据流（SSE 事件流）

```
Anthropic API SSE 响应
  `-- bytes_stream()
        `-- .eventsource()
              `-- eventsource_stream::Event { event: String, data: String }
                    `-- map_sse_event(event)
                          |
                          |-- "content_block_delta"
                          |     `-- JSON delta["delta"]["text"] 或 delta["delta"]["thinking"]
                          |           |-- thinking 非空 -> ThinkingDelta { delta }
                          |           `-- 否则           -> TextDelta { delta }
                          |
                          |-- "message_delta"
                          |     `-- JSON delta["usage"]["input_tokens/output_tokens"]
                          |           `-- MessageStop { usage: TokenUsage { input_tokens, output_tokens } }
                          |
                          |-- "error"
                          |     `-- JSON err["error"]["message"]
                          |           `-- Error { message }
                          |
                          `-- 其他 (ping/message_start)
                                `-- TextDelta { delta: "" }  <-- 问题：产生空 delta
```

### TokenUsage 数据链路

```
Anthropic API message_delta 事件
  `-- delta["usage"]["input_tokens"]  -> u64 -> as u32
  `-- delta["usage"]["output_tokens"] -> u64 -> as u32
        `-- TokenUsage { input_tokens: u32, output_tokens: u32 }
              `-- LlmStreamEvent::MessageStop { usage }
                    `-- agent_loop.rs: final_usage = usage
                          `-- AgentEvent::MessageComplete { usage }
                          `-- TranscriptEntry::Assistant { usage: Some(final_usage) }
                                `-- jsonl::append_entry() 持久化
```

---

## 链路详情

| 环节 | 源文件 | 目标文件 | 接口 | 状态 |
|------|--------|----------|------|------|
| Trait 定义 | llm.rs | - | `LlmProvider::chat_stream()` | 正常 |
| Provider 注册 | lib.rs | llm.rs | `AnthropicProvider::new()` | 正常 |
| 流式请求 | agent_loop.rs:33 | llm.rs:60 | `provider.chat_stream()` | 正常 |
| SSE 解析 | llm.rs:90-96 | eventsource-stream | `bytes_stream().eventsource()` | 正常 |
| 事件映射 | llm.rs:104-151 | - | `map_sse_event()` | 有问题 |
| TokenUsage 构造 | llm.rs:131-134 | transcript.rs:6-9 | `TokenUsage { u32, u32 }` | 正常 |
| 事件消费 | agent_loop.rs:41-79 | llm.rs | `match LlmStreamEvent` | 正常 |
| 事件桥接 | agent_loop.rs -> event_bus.rs | Tauri emit | `AgentEvent` | 正常 |
| 重试逻辑 | llm.rs:155-174 | - | `chat_stream_with_retry()` | 未使用 |

---

## 问题清单

### 严重问题（8-10分）

#### 问题 1：未知 SSE 事件产生空 TextDelta，下游无过滤（严重度：8）

**位置**：llm.rs:147-149

`map_sse_event` 对未匹配的 SSE 事件（如 `ping`、`message_start`、`content_block_start`、`content_block_stop`、`message_stop`）返回 `TextDelta { delta: "" }`。这个空字符串会传递到 `agent_loop.rs:44` 的 `full_content.push_str(&delta)`，虽然空字符串拼接无副作用，但 `agent_loop.rs:45-48` 会触发 `AgentEvent::TextDelta` 发送到前端。前端会收到大量空内容的 delta 事件，增加不必要的通信开销和前端处理负担。

```rust
// llm.rs:147-149
_ => Ok(LlmStreamEvent::TextDelta {
    delta: String::new(),
}),
```

**影响范围**：每次流式响应会产生 3-5 个额外的空 delta 事件（message_start + content_block_start + content_block_stop + ping 等），全部推送至前端。

**建议修复**：引入 `LlmStreamEvent::Heartbeat` 变体或在 stream 层用 `filter_map` 过滤掉空 delta。

---

#### 问题 2：`chat_stream_with_retry` 重试不区分错误类型（严重度：7）

**位置**：llm.rs:155-174

重试逻辑对所有 `AppError::Llm` 一视同仁地进行重试。以下错误类型不应重试：
- 认证失败（401）-- 重试必然失败
- 无效请求（400）-- 如 model 名称错误
- 余额不足（402）
- 内容审核拒绝

只有 429（rate limit）和 5xx（服务端错误）才值得重试。

```rust
// llm.rs:163-171
match provider.chat_stream(messages.clone(), model).await {
    Ok(stream) => return Ok(stream),
    Err(e) if attempt < max_retries => {  // 所有错误都重试
        let delay = std::time::Duration::from_secs(1u64 << attempt);
        tokio::time::sleep(delay).await;
        attempt += 1;
        let _ = &e;
    }
    Err(e) => return Err(e),
}
```

**影响范围**：当前此函数未被调用（lib.rs 直接使用 `AnthropicProvider`），但作为公开 API 存在，一旦被使用将产生无效重试。

---

### 一般问题（5-7分）

#### 问题 3：`with_base_url` 方法未被使用（严重度：5）

**位置**：llm.rs:52-55

`with_base_url` 是 builder 模式方法，但 `lib.rs:25` 直接使用 `AnthropicProvider::new(api_key)` 而不调用此方法。这意味着：
- 没有配置自定义 base_url 的入口
- 生产环境硬编码 `https://api.anthropic.com`
- 无法通过配置切换到代理或兼容 API

---

#### 问题 4：SSE 解析中 `content_block_delta` 的 thinking/text 判断逻辑有隐患（严重度：6）

**位置**：llm.rs:116-124

当 `thinking` 字段非空时返回 `ThinkingDelta`，否则返回 `TextDelta`。但 Anthropic API 的 `content_block_delta` 事件中 `delta` 对象还可能是 `input_json_delta`（tool_use 类型），此时 `text` 和 `thinking` 都为空字符串，会产生一个空的 `TextDelta`。

此外，`thinking` 和 `text` 可能同时为空（如 `content_block_stop` 类型的 delta），此时返回 `TextDelta { delta: "" }` 也不合理。

---

#### 问题 5：`max_tokens` 硬编码为 4096（严重度：5）

**位置**：llm.rs:77

```rust
"max_tokens": 4096,
```

`max_tokens` 被硬编码。对于长对话或需要更长响应的场景，4096 可能不够。此参数应可通过 trait 方法参数或配置传入。

---

#### 问题 6：SSE 流建立成功后，后续流内错误不会触发重试（严重度：5）

**位置**：llm.rs:90-98

`chat_stream_with_retry` 只在 HTTP 请求阶段重试。一旦 `bytes_stream()` 成功建立，后续的 SSE 解析错误（如网络中断、JSON 解析失败）会作为 `Err(AppError)` 出现在 stream 中，由 `agent_loop.rs:71-76` 直接处理并终止，不会触发重试。

---

### 轻微问题（1-4分）

#### 问题 7：`map_sse_event` 中 `unwrap_or` 静默丢弃解析异常（严重度：3）

**位置**：llm.rs:111, 113, 132, 133, 141

多处使用 `unwrap_or(0)` 和 `unwrap_or("")` 静默处理 JSON 字段缺失。如果 Anthropic API 变更了响应格式，这些地方不会报错，而是默默使用默认值，导致难以排查的问题。

---

#### 问题 8：`message_delta` 与 `message_stop` 的 SSE 事件名不匹配（严重度：4）

**位置**：llm.rs:126

Anthropic SSE 协议中，`message_delta` 事件携带 usage 信息，而 `message_stop` 事件只表示消息结束（无 data payload）。当前代码将 SSE 的 `message_delta` 映射为 `LlmStreamEvent::MessageStop`，命名容易造成混淆。`message_stop` 事件本身会被 fallback 到空 `TextDelta`（问题 1）。

---

#### 问题 9：`u64 -> u32` 截断风险（严重度：2）

**位置**：llm.rs:132-133

```rust
input_tokens: usage["input_tokens"].as_u64().unwrap_or(0) as u32,
output_tokens: usage["output_tokens"].as_u64().unwrap_or(0) as u32,
```

`as u32` 截断，当 token 数超过 42 亿时溢出。实际场景中不可能达到此值，但属于不规范的类型转换。

---

## 建议

### 优先级 P0（应尽快修复）

1. **过滤空 delta 事件**：在 `map_sse_event` 中将 fallback 分支改为返回一个可过滤的变体（如 `Skip`），或在 stream 构建时用 `.filter_map()` 过滤掉 `Ok(TextDelta { delta })` 中 `delta.is_empty()` 的情况。这直接影响前端性能。

### 优先级 P1（应在本迭代修复）

2. **重试逻辑增加错误分类**：解析 HTTP status code，仅对 429 和 5xx 进行重试。可考虑将 status code 传入 `AppError::Llm` 以便区分。

3. **暴露 `max_tokens` 配置**：通过 `LlmProvider::chat_stream` 参数或 `AnthropicProvider` 构造函数传入，而非硬编码。

4. **启用 `with_base_url`**：在 `lib.rs` 或配置文件中提供自定义 base_url 的入口，支持代理和兼容 API。

### 优先级 P2（可后续优化）

5. **增加日志**：在 SSE 解析和重试逻辑中增加 `tracing` 日志，便于生产问题排查。

6. **考虑 `message_delta` 与 `message_stop` 的精确映射**：分别处理这两个事件，`message_delta` 提取 usage，`message_stop` 触发结束信号。
