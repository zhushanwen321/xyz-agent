# P0 后端服务 — 实施计划

> 前置条件：Task 1-3 已完成，`crate::models`、`crate::error::AppError`、`crate::db::{jsonl, session_index}` 可用。

---

## Task 4: LLM Gateway

**目标**：实现 `LlmProvider` trait 和 `AnthropicProvider` 流式调用。

**文件**：`src-tauri/src/services/llm.rs`

---

### 4.1 添加依赖

- [ ] 在 `src-tauri/Cargo.toml` 的 `[dependencies]` 中确认以下依赖存在（若缺失则添加）：

```toml
futures = "0.3"
async-trait = "0.1"
eventsource-stream = "0.2"
reqwest = { version = "0.12", features = ["stream", "json"] }
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

```bash
cargo check
# 期望：无依赖缺失错误
```

### 4.2 创建 services/mod.rs

- [ ] 创建 `src-tauri/src/services/mod.rs`：

```rust
pub mod llm;
```

- [ ] 在 `src-tauri/src/lib.rs` 中添加 `mod services;`（如果尚未存在）。

```bash
cargo check
# 期望：模块声明通过
```

### 4.3 写 LlmStreamEvent 序列化测试

- [ ] 创建 `src-tauri/src/services/llm.rs`，先只写测试：

```rust
use crate::error::AppError;
use crate::models::TokenUsage;
use async_trait::async_trait;
use futures::stream::Stream;
use pin_project::pin_project;
use serde::{Deserialize, Serialize};
use std::pin::Pin;

// === 类型定义（先声明，后续步骤实现） ===

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum LlmStreamEvent {
    TextDelta { delta: String },
    ThinkingDelta { delta: String },
    MessageStop { usage: TokenUsage },
    Error { message: String },
}

// === 测试 ===

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_delta_serialization_roundtrip() {
        let event = LlmStreamEvent::TextDelta {
            delta: "hello".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains(r#""type":"TextDelta""#));
        assert!(json.contains(r#""delta":"hello""#));

        let de: LlmStreamEvent = serde_json::from_str(&json).unwrap();
        match de {
            LlmStreamEvent::TextDelta { delta } => assert_eq!(delta, "hello"),
            _ => panic!("expected TextDelta"),
        }
    }

    #[test]
    fn message_stop_serialization() {
        let event = LlmStreamEvent::MessageStop {
            usage: TokenUsage {
                input_tokens: 100,
                output_tokens: 50,
            },
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains(r#""type":"MessageStop""#));

        let de: LlmStreamEvent = serde_json::from_str(&json).unwrap();
        match de {
            LlmStreamEvent::MessageStop { usage } => {
                assert_eq!(usage.input_tokens, 100);
                assert_eq!(usage.output_tokens, 50);
            }
            _ => panic!("expected MessageStop"),
        }
    }

    #[test]
    fn error_event_serialization() {
        let event = LlmStreamEvent::Error {
            message: "rate limited".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains(r#""type":"Error""#));

        let de: LlmStreamEvent = serde_json::from_str(&json).unwrap();
        match de {
            LlmStreamEvent::Error { message } => {
                assert_eq!(message, "rate limited");
            }
            _ => panic!("expected Error"),
        }
    }
}
```

```bash
cargo test --lib services::llm::tests
# 期望：3 个测试通过
```

### 4.4 实现 Provider trait + AnthropicProvider 构造函数

- [ ] 在 `llm.rs` 中追加 trait 定义和 struct：

```rust
#[async_trait]
pub trait LlmProvider: Send + Sync {
    async fn chat_stream(
        &self,
        messages: Vec<serde_json::Value>,
        model: &str,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<LlmStreamEvent, AppError>> + Send>>, AppError>;
}

pub struct AnthropicProvider {
    client: reqwest::Client,
    api_key: String,
    base_url: String,
}

impl AnthropicProvider {
    pub fn new(api_key: String) -> Self {
        Self {
            client: reqwest::Client::new(),
            api_key,
            base_url: "https://api.anthropic.com".to_string(),
        }
    }

    pub fn with_base_url(mut self, url: String) -> Self {
        self.base_url = url;
        self
    }
}
```

```bash
cargo check
# 期望：编译通过（trait 未实现会报错，下一步实现）
```

### 4.5 实现 AnthropicProvider::chat_stream

- [ ] 实现 `chat_stream`，包含 SSE 解析和事件映射：

```rust
use eventsource_stream::Eventsource;
use futures::StreamExt;

#[async_trait]
impl LlmProvider for AnthropicProvider {
    async fn chat_stream(
        &self,
        messages: Vec<serde_json::Value>,
        model: &str,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<LlmStreamEvent, AppError>> + Send>>, AppError> {
        let url = format!("{}/v1/messages", self.base_url);
        let body = serde_json::json!({
            "model": model,
            "messages": messages,
            "stream": true,
            "max_tokens": 4096,
        });

        let response = self
            .client
            .post(&url)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::Llm(e.to_string()))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::Llm(format!("API error {}: {}", status, body)));
        }

        let stream = response
            .bytes_stream()
            .eventsource()
            .map(move |event| match event {
                Ok(event) => {
                    let data = &event.data;
                    let parsed: serde_json::Value =
                        serde_json::from_str(data).unwrap_or(serde_json::Value::Null);

                    let event_type = parsed["type"].as_str().unwrap_or("");

                    match event_type {
                        "content_block_delta" => {
                            let delta = parsed["delta"]["text"]
                                .as_str()
                                .unwrap_or("")
                                .to_string();
                            Ok(LlmStreamEvent::TextDelta { delta })
                        }
                        "message_delta" => {
                            let usage = &parsed["usage"];
                            Ok(LlmStreamEvent::MessageStop {
                                usage: TokenUsage {
                                    input_tokens: usage["input_tokens"]
                                        .as_u64()
                                        .unwrap_or(0) as u32,
                                    output_tokens: usage["output_tokens"]
                                        .as_u64()
                                        .unwrap_or(0) as u32,
                                },
                            })
                        }
                        "error" => {
                            let msg = parsed["error"]["message"]
                                .as_str()
                                .unwrap_or("unknown error")
                                .to_string();
                            Ok(LlmStreamEvent::Error { message: msg })
                        }
                        _ => Ok(LlmStreamEvent::TextDelta {
                            delta: String::new(),
                        }),
                    }
                }
                Err(e) => Err(AppError::Llm(e.to_string())),
            });

        Ok(Box::pin(stream))
    }
}
```

```bash
cargo check
# 期望：编译通过
```

### 4.6 添加指数退避重试

- [ ] 添加带重试的包装方法 `chat_stream_with_retry`：

```rust
impl AnthropicProvider {
    /// 带指数退避重试的 chat_stream（3 次，base 1s）
    pub async fn chat_stream_with_retry(
        &self,
        messages: Vec<serde_json::Value>,
        model: &str,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<LlmStreamEvent, AppError>> + Send>>, AppError>
    {
        let max_retries = 3u32;
        let mut attempt = 0;

        loop {
            match self.chat_stream(messages.clone(), model).await {
                Ok(stream) => return Ok(stream),
                Err(e) => {
                    attempt += 1;
                    if attempt >= max_retries {
                        return Err(e);
                    }
                    let delay = std::time::Duration::from_secs(1 << (attempt - 1));
                    tokio::time::sleep(delay).await;
                }
            }
        }
    }
}
```

### 4.7 写集成测试

- [ ] 在 `llr.rs` 的 `tests` 模块中追加集成测试（需要真实 API key，标记 `#[ignore]`）：

```rust
#[tokio::test]
#[ignore] // 需要 ANTHROPIC_API_KEY 环境变量
async fn anthropic_chat_stream_integration() {
    let api_key = std::env::var("ANTHROPIC_API_KEY").expect("ANTHROPIC_API_KEY not set");
    let provider = AnthropicProvider::new(api_key);
    let messages = vec![serde_json::json!({
        "role": "user",
        "content": "Say hello in one word."
    })];

    let stream = provider
        .chat_stream_with_retry(messages, "claude-sonnet-4-20250514")
        .await
        .unwrap();

    use futures::StreamExt;
    let events: Vec<_> = stream.collect::<Vec<_>>().await;
    assert!(!events.is_empty(), "should receive at least one event");

    let has_text = events.iter().any(|e| matches!(e, Ok(LlmStreamEvent::TextDelta { .. })));
    assert!(has_text, "should have at least one TextDelta");
}
```

```bash
cargo test --lib services::llm::tests
# 期望：3 个序列化测试通过，集成测试 skipped（#[ignore]）

# 如需运行集成测试：
# ANTHROPIC_API_KEY=sk-xxx cargo test --lib services::llm::tests -- --ignored
```

### 4.8 Commit

- [ ] 提交 LLM Gateway：

```bash
git add src-tauri/src/services/llr.rs src-tauri/src/services/mod.rs
git commit -m "feat(services): add LLM Gateway with Anthropic streaming provider

- LlmProvider trait with chat_stream returning typed Stream
- AnthropicProvider: SSE parsing, event mapping, retry with backoff
- LlmStreamEvent: TextDelta / ThinkingDelta / MessageStop / Error
- Unit tests for serialization roundtrip
- Integration test (#[ignore]) for real API call"
```

---

## Task 5: AgentLoop 主循环

**目标**：实现 `AgentLoop`，消费 LLM 流式事件并转发 `AgentEvent`。

**文件**：`src-tauri/src/services/agent_loop.rs`

---

### 5.1 写 history_to_api_messages 测试

- [ ] 创建 `src-tauri/src/services/agent_loop.rs`，先写测试和辅助函数：

```rust
use crate::error::AppError;
use crate::models::{AgentEvent, TokenUsage, TranscriptEntry};
use crate::services::llm::LlmProvider;
use futures::StreamExt;
use std::sync::Arc;
use tokio::sync::mpsc;

pub struct AgentLoop {
    provider: Arc<dyn LlmProvider>,
    session_id: String,
}

impl AgentLoop {
    pub fn new(provider: Arc<dyn LlmProvider>, session_id: String) -> Self {
        Self { provider, session_id }
    }
}

/// 将 TranscriptEntry 链转为 Anthropic {role, content} 数组
fn history_to_api_messages(history: &[TranscriptEntry]) -> Vec<serde_json::Value> {
    history
        .iter()
        .filter(|entry| matches!(
            entry,
            TranscriptEntry::User { .. } | TranscriptEntry::Assistant { .. }
        ))
        .map(|entry| match entry {
            TranscriptEntry::User { content, .. } => serde_json::json!({
                "role": "user",
                "content": content,
            }),
            TranscriptEntry::Assistant { content, .. } => serde_json::json!({
                "role": "assistant",
                "content": content,
            }),
            _ => unreachable!(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_user_entry(content: &str) -> TranscriptEntry {
        TranscriptEntry::User {
            uuid: "test-uuid".to_string(),
            parent_uuid: None,
            timestamp: "2026-01-01T00:00:00Z".to_string(),
            session_id: "test-session".to_string(),
            content: content.to_string(),
        }
    }

    fn make_assistant_entry(content: &str) -> TranscriptEntry {
        TranscriptEntry::Assistant {
            uuid: "test-uuid".to_string(),
            parent_uuid: None,
            timestamp: "2026-01-01T00:00:00Z".to_string(),
            session_id: "test-session".to_string(),
            content: content.to_string(),
            usage: None,
        }
    }

    fn make_system_entry(content: &str) -> TranscriptEntry {
        TranscriptEntry::System {
            uuid: "test-uuid".to_string(),
            parent_uuid: None,
            timestamp: "2026-01-01T00:00:00Z".to_string(),
            session_id: "test-session".to_string(),
            content: content.to_string(),
        }
    }

    #[test]
    fn history_to_api_messages_filters_system_entries() {
        let history = vec![
            make_system_entry("system prompt"),
            make_user_entry("hello"),
            make_assistant_entry("hi there"),
        ];
        let messages = history_to_api_messages(&history);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[0]["content"], "hello");
        assert_eq!(messages[1]["role"], "assistant");
        assert_eq!(messages[1]["content"], "hi there");
    }

    #[test]
    fn history_to_api_messages_empty() {
        let messages = history_to_api_messages(&[]);
        assert!(messages.is_empty());
    }

    #[test]
    fn history_to_api_messages_preserves_order() {
        let history = vec![
            make_user_entry("first"),
            make_assistant_entry("second"),
            make_user_entry("third"),
        ];
        let messages = history_to_api_messages(&history);
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["content"], "first");
        assert_eq!(messages[1]["content"], "second");
        assert_eq!(messages[2]["content"], "third");
    }
}
```

- [ ] 在 `services/mod.rs` 中添加 `pub mod agent_loop;`

```bash
cargo test --lib services::agent_loop::tests
# 期望：3 个测试通过
```

### 5.2 实现 AgentLoop::run_turn

- [ ] 在 `agent_loop.rs` 中追加 `run_turn` 实现：

```rust
impl AgentLoop {
    pub async fn run_turn(
        &self,
        user_message: String,
        history: Vec<TranscriptEntry>,
        event_tx: tokio::sync::mpsc::UnboundedSender<AgentEvent>,
    ) -> Result<TranscriptEntry, AppError> {
        let mut api_messages = history_to_api_messages(&history);
        api_messages.push(serde_json::json!({
            "role": "user",
            "content": user_message,
        }));

        let model = "claude-sonnet-4-20250514";
        let mut stream = self.provider.chat_stream(api_messages, model).await?;

        let mut full_content = String::new();
        let mut final_usage = TokenUsage {
            input_tokens: 0,
            output_tokens: 0,
        };

        while let Some(item) = stream.next().await {
            match item {
                Ok(crate::services::llm::LlmStreamEvent::TextDelta { delta }) => {
                    full_content.push_str(&delta);
                    let _ = event_tx.send(AgentEvent::TextDelta {
                        session_id: self.session_id.clone(),
                        delta,
                    });
                }
                Ok(crate::services::llm::LlmStreamEvent::ThinkingDelta { delta }) => {
                    let _ = event_tx.send(AgentEvent::ThinkingDelta {
                        session_id: self.session_id.clone(),
                        delta,
                    });
                }
                Ok(crate::services::llm::LlmStreamEvent::MessageStop { usage }) => {
                    final_usage = usage;
                    let _ = event_tx.send(AgentEvent::MessageComplete {
                        session_id: self.session_id.clone(),
                        role: "assistant".to_string(),
                        content: full_content.clone(),
                        usage: final_usage.clone(),
                    });
                }
                Ok(crate::services::llm::LlmStreamEvent::Error { message }) => {
                    let _ = event_tx.send(AgentEvent::Error {
                        session_id: self.session_id.clone(),
                        message: message.clone(),
                    });
                }
                Err(e) => {
                    let _ = event_tx.send(AgentEvent::Error {
                        session_id: self.session_id.clone(),
                        message: e.to_string(),
                    });
                    return Err(e);
                }
            }
        }

        let now = chrono::Utc::now().to_rfc3339();
        Ok(TranscriptEntry::Assistant {
            uuid: uuid::Uuid::new_v4().to_string(),
            parent_uuid: None,
            timestamp: now,
            session_id: self.session_id.clone(),
            content: full_content,
            usage: Some(final_usage),
        })
    }
}
```

```bash
cargo check
# 期望：编译通过
```

### 5.3 实现 extract_api_key

- [ ] 在 `agent_loop.rs` 中追加：

```rust
/// 从环境变量或配置文件读取 Anthropic API key
pub fn extract_api_key() -> Result<String, AppError> {
    if let Ok(key) = std::env::var("ANTHROPIC_API_KEY") {
        return Ok(key);
    }

    let config_path = dirs::home_dir()
        .ok_or_else(|| AppError::Config("cannot find home directory".to_string()))?
        .join(".xyz-agent")
        .join("config.toml");

    if config_path.exists() {
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| AppError::Config(format!("read config failed: {}", e)))?;
        for line in content.lines() {
            let trimmed = line.trim();
            if let Some(key) = trimmed.strip_prefix("anthropic_api_key") {
                let key = key.trim_start_matches(['=', ' ']).trim();
                if !key.is_empty() {
                    return Ok(key.to_string());
                }
            }
        }
    }

    Err(AppError::Config(
        "ANTHROPIC_API_KEY not found in env or ~/.xyz-agent/config.toml".to_string(),
    ))
}
```

- [ ] 写 `extract_api_key` 测试：

```rust
#[cfg(test)]
mod extract_tests {
    use super::*;

    #[test]
    fn extract_api_key_missing_returns_error() {
        // 确保环境变量不存在
        std::env::remove_var("ANTHROPIC_API_KEY");
        let result = extract_api_key();
        assert!(result.is_err());
    }
}
```

```bash
cargo test --lib services::agent_loop
# 期望：4 个测试通过（3 个 history + 1 个 extract）
```

### 5.4 Commit

```bash
git add src-tauri/src/services/agent_loop.rs src-tauri/src/services/mod.rs
git commit -m "feat(services): add AgentLoop with run_turn and history conversion

- AgentLoop consumes LLM stream, forwards AgentEvent via mpsc
- history_to_api_messages filters System entries, maps role/content
- extract_api_key reads from env var or config file
- Unit tests for history conversion and key extraction"
```

---

## Task 6: EventBus + Tauri Command 层

**目标**：实现事件桥接和 Tauri Command 处理器。

**文件**：
- `src-tauri/src/services/event_bus.rs`
- `src-tauri/src/commands/mod.rs`
- `src-tauri/src/commands/session.rs`
- `src-tauri/src/commands/chat.rs`

---

### 6.1 实现 event_bus.rs

- [ ] 创建 `src-tauri/src/services/event_bus.rs`：

```rust
use crate::models::AgentEvent;
use tauri::{AppHandle, Emitter};

/// 桥接 mpsc channel 到 Tauri Event
/// 启动后台 task，从 rx 接收 AgentEvent 并 emit 到前端
pub fn spawn_bridge(
    app_handle: AppHandle,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<AgentEvent>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            let _ = app_handle.emit("agent-event", &event);
        }
    })
}

#[cfg(test)]
mod tests {
    use crate::models::TokenUsage;

    #[test]
    fn agent_event_serializes_for_tauri() {
        let event = crate::models::AgentEvent::TextDelta {
            session_id: "s1".to_string(),
            delta: "hello".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains(r#""type":"TextDelta""#));
        assert!(json.contains(r#""session_id":"s1""#));
    }
}
```

- [ ] 更新 `services/mod.rs`：

```rust
pub mod agent_loop;
pub mod event_bus;
pub mod llm;
```

```bash
cargo check
# 期望：编译通过
```

### 6.2 写 commands/session.rs

- [ ] 创建 `src-tauri/src/commands/mod.rs`：

```rust
pub mod chat;
pub mod session;
```

- [ ] 创建 `src-tauri/src/commands/session.rs`：

```rust
use crate::db::{jsonl, session_index};
use crate::error::AppError;
use serde_json::Value;
use std::path::PathBuf;
use tauri::State;

pub struct AppState {
    pub config_dir: PathBuf,
    // provider 在 lib.rs 集成时添加
}

impl From<AppError> for String {
    fn from(e: AppError) -> String {
        e.to_string()
    }
}

#[tauri::command]
pub async fn new_session(cwd: String, state: State<'_, AppState>) -> Result<Value, String> {
    let session_id = uuid::Uuid::new_v4().to_string();
    let sanitized = cwd.replace('/', "_").replace('\\', "_");
    let dir = state.config_dir.join("projects").join(&sanitized);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create dir failed: {}", e))?;

    let path = dir.join(format!("{}.jsonl", session_id));
    // 写入空的 JSONL 文件（首条 system entry）
    let system_entry = serde_json::json!({
        "type": "system",
        "uuid": uuid::Uuid::new_v4().to_string(),
        "parent_uuid": null,
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "session_id": session_id,
        "content": format!("Session started in {}", cwd),
    });
    std::fs::write(&path, format!("{}\n", system_entry))
        .map_err(|e| format!("write failed: {}", e))?;

    Ok(serde_json::json!({
        "session_id": session_id,
        "path": path.to_string_lossy(),
    }))
}

#[tauri::command]
pub async fn list_sessions(cwd: String, state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let sanitized = cwd.replace('/', "_").replace('\\', "_");
    let dir = state.config_dir.join("projects").join(&sanitized);
    if !dir.exists() {
        return Ok(vec![]);
    }
    session_index::scan_sessions(&dir).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_history(session_id: String, state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    // 扫描所有项目目录找到对应 session 文件
    let projects_dir = state.config_dir.join("projects");
    if !projects_dir.exists() {
        return Err(format!("session {} not found", session_id));
    }

    let entry = walkdir_for_session(&projects_dir, &session_id)
        .ok_or_else(|| format!("session {} not found", session_id))?;

    jsonl::read_chain(&entry)
        .map_err(|e| e.to_string())
}

/// 在 projects 目录下递归查找 session JSONL 文件
fn walkdir_for_session(projects_dir: &PathBuf, session_id: &str) -> Option<PathBuf> {
    for entry in std::fs::read_dir(projects_dir).ok()? {
        let entry = entry.ok()?;
        let path = entry.path();
        if path.is_dir() {
            let target = path.join(format!("{}.jsonl", session_id));
            if target.exists() {
                return Some(target);
            }
        }
    }
    None
}
```

```bash
cargo check
# 期望：编译通过（注意 session_index::scan_sessions 和 jsonl::read_chain 需匹配 Task 3 的签名）
```

### 6.3 写 commands/chat.rs

- [ ] 创建 `src-tauri/src/commands/chat.rs`：

```rust
use crate::commands::session::AppState;
use crate::db::jsonl;
use crate::models::TranscriptEntry;
use crate::services::agent_loop::AgentLoop;
use crate::services::event_bus;
use crate::services::llm::LlmProvider;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub async fn send_message(
    session_id: String,
    content: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let provider = state.provider.clone();
    let config_dir = state.config_dir.clone();

    // 查找 session JSONL 路径
    let session_path = find_session_path(&config_dir, &session_id)
        .ok_or_else(|| format!("session {} not found", session_id))?;

    // 读取历史
    let history = jsonl::read_chain(&session_path).map_err(|e| e.to_string())?;

    // 追加 User entry
    let parent_uuid = history.last().and_then(|e| match e {
        TranscriptEntry::User { uuid, .. } => Some(uuid.clone()),
        TranscriptEntry::Assistant { uuid, .. } => Some(uuid.clone()),
        TranscriptEntry::System { uuid, .. } => Some(uuid.clone()),
        _ => None,
    });
    let user_entry = TranscriptEntry::User {
        uuid: uuid::Uuid::new_v4().to_string(),
        parent_uuid,
        timestamp: chrono::Utc::now().to_rfc3339(),
        session_id: session_id.clone(),
        content: content.clone(),
    };
    jsonl::append_entry(&session_path, &user_entry).map_err(|e| e.to_string())?;

    // 创建 channel + 桥接
    let (event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel();
    event_bus::spawn_bridge(app, event_rx);

    // 运行 AgentLoop
    let agent_loop = AgentLoop::new(provider, session_id.clone());
    let mut history_with_user = history;
    history_with_user.push(
        serde_json::from_value(serde_json::to_value(&user_entry).unwrap()).unwrap(),
    );

    let assistant_entry = agent_loop
        .run_turn(content, history_with_user, event_tx)
        .await
        .map_err(|e| e.to_string())?;

    // 追加 Assistant entry
    jsonl::append_entry(&session_path, &assistant_entry).map_err(|e| e.to_string())?;

    Ok(())
}

fn find_session_path(config_dir: &std::path::PathBuf, session_id: &str) -> Option<std::path::PathBuf> {
    let projects_dir = config_dir.join("projects");
    if !projects_dir.exists() {
        return None;
    }
    for entry in std::fs::read_dir(&projects_dir).ok()? {
        let entry = entry.ok()?;
        let path = entry.path();
        if path.is_dir() {
            let target = path.join(format!("{}.jsonl", session_id));
            if target.exists() {
                return Some(target);
            }
        }
    }
    None
}
```

### 6.4 更新 AppState 包含 provider

- [ ] 更新 `commands/session.rs` 中的 `AppState`：

```rust
use crate::services::llm::LlmProvider;
use std::sync::Arc;

pub struct AppState {
    pub config_dir: PathBuf,
    pub provider: Arc<dyn LlmProvider>,
}
```

```bash
cargo check
# 期望：编译通过
```

### 6.5 在 lib.rs 添加 mod commands

- [ ] 确保 `src-tauri/src/lib.rs` 中有 `mod commands;`

```bash
cargo build
# 期望：编译通过
```

### 6.6 Commit

```bash
git add src-tauri/src/services/event_bus.rs src-tauri/src/commands/
git commit -m "feat(commands): add EventBus bridge and Tauri command handlers

- event_bus: spawns bridge from mpsc channel to Tauri Event
- commands/session: new_session, list_sessions, get_history
- commands/chat: send_message with AgentLoop + JSONL persistence
- AppState holds config_dir and LlmProvider"
```

---

## Task 7: lib.rs 入口集成

**目标**：将所有模块整合到 Tauri Builder。

**文件**：`src-tauri/src/lib.rs`

---

### 7.1 更新 lib.rs

- [ ] 重写 `src-tauri/src/lib.rs`：

```rust
mod commands;
mod db;
mod error;
mod models;
mod services;

use services::agent_loop;
use services::llm::{AnthropicProvider, LlmProvider};
use std::sync::Arc;

pub use commands::session::AppState;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let config_dir = dirs::home_dir()
                .expect("cannot find home directory")
                .join(".xyz-agent");
            std::fs::create_dir_all(&config_dir).ok();

            let api_key = agent_loop::extract_api_key()
                .expect("ANTHROPIC_API_KEY not found");
            let provider: Arc<dyn LlmProvider> = Arc::new(AnthropicProvider::new(api_key));

            app.manage(AppState {
                config_dir,
                provider,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::session::new_session,
            commands::session::list_sessions,
            commands::session::get_history,
            commands::chat::send_message,
        ])
        .run(tauri::generate_context!())
        .expect("error while running xyz-agent");
}
```

### 7.2 确保 main.rs 调用 lib::run

- [ ] 确认 `src-tauri/src/main.rs` 内容为：

```rust
fn main() {
    xyz_agent::run()
}
```

- [ ] 确认 `src-tauri/Cargo.toml` 中 `[lib]` 配置：

```toml
[lib]
name = "xyz_agent"
crate-type = ["staticlib", "cdylib", "lib"]
```

### 7.3 确保 services/mod.rs 完整导出

- [ ] 确认 `src-tauri/src/services/mod.rs`：

```rust
pub mod agent_loop;
pub mod event_bus;
pub mod llm;
```

### 7.4 确保 db/mod.rs 和 models/mod.rs 完整导出

- [ ] 确认 `src-tauri/src/db/mod.rs` 包含：

```rust
pub mod jsonl;
pub mod session_index;
```

- [ ] 确认 `src-tauri/src/models/mod.rs` 包含：

```rust
pub mod event;
pub mod transcript;

pub use event::AgentEvent;
pub use transcript::{TokenUsage, TranscriptEntry};
```

### 7.5 编译验证

```bash
cargo build
# 期望：编译成功，无错误

cargo test --lib
# 期望：所有单元测试通过
```

### 7.6 Commit

```bash
git add src-tauri/src/lib.rs src-tauri/src/main.rs
git commit -m "feat: integrate all modules into Tauri Builder

- lib.rs wires up AppState, LlmProvider, command handlers
- main.rs delegates to xyz_agent::run()
- All modules (commands, db, error, models, services) registered"
```

---

## 完成检查清单

- [ ] `cargo test --lib` 全部通过
- [ ] `cargo build` 无错误
- [ ] Task 4-7 各有独立 commit
- [ ] `LlmProvider` trait 可 mock（`Send + Sync + 'static`）
- [ ] `AgentLoop` 不依赖 Tauri（纯 Rust）
- [ ] `event_bus` 是唯一 import `tauri` 的 services 模块
- [ ] `commands/` 是薄适配层，不含业务逻辑
