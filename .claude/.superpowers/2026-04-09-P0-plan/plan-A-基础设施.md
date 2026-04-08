# 基础设施 — 实施计划

> Task 1-3，预计总耗时 45-60 分钟

---

## Task 1: 项目脚手架搭建

### 步骤 1.1: 创建 Tauri v2 + Vue 3 + TypeScript 项目

- [ ] 在项目根目录下初始化 Tauri v2 项目

```bash
cd /Users/zhushanwen/Code/xyz-agent/xyz-agent
npx create-tauri-app@latest --template vue-ts --manager npm .
```

如果交互式命令不可用，手动创建：

```bash
# 创建前端骨架
npm init -y
npm install vue@latest
npm install -D vite @vitejs/plugin-vue typescript vue-tsc

# 添加 Tauri CLI
npm install -D @tauri-apps/cli@latest
npx tauri init
```

`npx tauri init` 交互式回答：
- App name: `xyz-agent`
- Window title: `xyz-agent`
- Dev server URL: `http://localhost:1420`
- Dev command: `npm run dev`
- Build command: `npm run build`
- Frontend dist: `../dist`

**验证**：

```bash
ls src-tauri/src/main.rs src-tauri/Cargo.toml src/App.vue
# 应输出三个文件路径
```

### 步骤 1.2: 安装前端依赖（Tailwind + shadcn-vue）

- [ ] 安装 Tailwind CSS v4

```bash
npm install tailwindcss @tailwindcss/vite
```

- [ ] 配置 `vite.config.ts`

```typescript
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
```

- [ ] 在 `src/assets/main.css` 顶部添加 Tailwind 指令

```css
@import "tailwindcss";
```

- [ ] 初始化 shadcn-vue

```bash
npx shadcn-vue@latest init
```

交互式回答：
- Style: New York
- Base color: Neutral
- CSS file: `src/assets/main.css`

**验证**：

```bash
npx tailwindcss --help
# 应输出 tailwindcss 帮助信息
```

### 步骤 1.3: 配置 Cargo.toml 依赖

- [ ] 编辑 `src-tauri/Cargo.toml`，添加全部 P0 依赖

```toml
[package]
name = "xyz-agent"
version = "0.1.0"
edition = "2021"

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-shell = "2"
tokio = { version = "1", features = ["full"] }
reqwest = { version = "0.12", features = ["stream", "json"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
uuid = { version = "1", features = ["v4"] }
chrono = { version = "0.4", features = ["serde"] }
thiserror = "2"
futures = "0.3"
async-trait = "0.1"
eventsource-stream = "0.2"
dirs = "6"
file-lock = "2"

[dev-dependencies]
tempfile = "3"

[build-dependencies]
tauri-build = { version = "2", features = [] }
```

**验证**：

```bash
cd src-tauri && cargo check 2>&1 | tail -5
# 期望: Finished `dev` profile [unoptimized + debuginfo] target(s) in ...
```

### 步骤 1.4: 创建 Rust 模块目录结构

- [ ] 创建所有模块文件

```bash
cd /Users/zhushanwen/Code/xyz-agent/xyz-agent/src-tauri/src

# models
mkdir -p models
touch models/mod.rs models/transcript.rs models/event.rs

# db
mkdir -p db
touch db/mod.rs db/jsonl.rs db/session_index.rs

# services
mkdir -p services
touch services/mod.rs services/llm.rs services/agent_loop.rs services/event_bus.rs

# commands
mkdir -p commands
touch commands/mod.rs commands/session.rs commands/chat.rs

# 根级文件
touch error.rs
```

- [ ] 写入 `src-tauri/src/main.rs`

```rust
fn main() {
    xyz_agent::run()
}
```

- [ ] 写入 `src-tauri/src/lib.rs`（空壳）

```rust
mod error;
pub mod models;
// 后续 Task 解除注释:
// pub mod db;
// pub mod services;
// pub mod commands;

pub fn run() {
    // Task 7 填充
}
```

- [ ] 写入所有 `mod.rs` 占位

`models/mod.rs`:
```rust
// Task 2 填充
```

`db/mod.rs`:
```rust
// Task 3 填充
```

`services/mod.rs`:
```rust
// plan-B 填充
```

`commands/mod.rs`:
```rust
// plan-B 填充
```

**验证**：

```bash
cd /Users/zhushanwen/Code/xyz-agent/xyz-agent/src-tauri && cargo check 2>&1 | tail -3
# 期望: Finished ...
```

### 步骤 1.5: 验证 dev 模式能启动

- [ ] 确认 `npm run dev` 和 `cargo build` 均能通过

```bash
cd /Users/zhushanwen/Code/xyz-agent/xyz-agent

# 检查 cargo build
cd src-tauri && cargo build 2>&1 | tail -3

# 回到根目录检查前端构建
cd /Users/zhushanwen/Code/xyz-agent/xyz-agent
npm run build 2>&1 | tail -5
```

**期望输出**：
- `cargo build`: `Finished dev profile ...`
- `npm run build`: 无报错，dist 目录生成

### 步骤 1.6: Commit

```bash
git add -A
git commit -m "feat: initialize Tauri v2 + Vue 3 + TypeScript project scaffold

- Tauri v2 with Vue + TypeScript template
- Tailwind CSS v4 + shadcn-vue configured
- All Rust module directories created (models, db, services, commands)
- Cargo.toml with all P0 dependencies
- Empty module stubs for incremental implementation"
```

---

## Task 2: 数据模型与错误类型

### 步骤 2.1: 写 error.rs 测试

- [ ] 创建 `src-tauri/src/error.rs`，先写测试

```rust
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("LLM API error: {0}")]
    Llm(String),
    #[error("Storage error: {0}")]
    Storage(String),
    #[error("Session not found: {0}")]
    SessionNotFound(String),
    #[error("Config error: {0}")]
    Config(String),
}

// 让 Tauri command 能返回 Result<T, String>
impl From<AppError> for String {
    fn from(err: AppError) -> String {
        err.to_string()
    }
}

// Serialize 用于 Tauri event payload（只取 message）
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_llm_error_to_string() {
        let err = AppError::Llm("rate limited".into());
        assert_eq!(err.to_string(), "LLM API error: rate limited");
    }

    #[test]
    fn test_storage_error_into_string() {
        let err = AppError::Storage("disk full".into());
        let s: String = err.into();
        assert_eq!(s, "Storage error: disk full");
    }

    #[test]
    fn test_session_not_found_serializes_as_str() {
        let err = AppError::SessionNotFound("abc-123".into());
        let json = serde_json::to_string(&err).unwrap();
        assert_eq!(json, "\"Session not found: abc-123\"");
    }

    #[test]
    fn test_all_variants_convert_to_string() {
        let cases: Vec<AppError> = vec![
            AppError::Llm("e1".into()),
            AppError::Storage("e2".into()),
            AppError::SessionNotFound("e3".into()),
            AppError::Config("e4".into()),
        ];
        let strings: Vec<String> = cases.into_iter().map(|e| e.into()).collect();
        assert_eq!(strings[0], "LLM API error: e1");
        assert_eq!(strings[1], "Storage error: e2");
        assert_eq!(strings[2], "Session not found: e3");
        assert_eq!(strings[3], "Config error: e4");
    }
}
```

- [ ] 运行测试确认通过

```bash
cd /Users/zhushanwen/Code/xyz-agent/xyz-agent/src-tauri
cargo test error::tests -- --nocapture
```

**期望输出**：
```
running 4 tests
test error::tests::test_llm_error_to_string ... ok
test error::tests::test_storage_error_into_string ... ok
test error::tests::test_session_not_found_serializes_as_str ... ok
test error::tests::test_all_variants_convert_to_string ... ok
```

### 步骤 2.2: 写 transcript.rs 测试

- [ ] 创建 `src-tauri/src/models/transcript.rs`，先写测试

```rust
use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsage {
    pub input_tokens: u32,
    pub output_tokens: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum TranscriptEntry {
    #[serde(rename = "user")]
    User {
        uuid: String,
        parent_uuid: Option<String>,
        timestamp: String,
        session_id: String,
        content: String,
    },
    #[serde(rename = "assistant")]
    Assistant {
        uuid: String,
        parent_uuid: Option<String>,
        timestamp: String,
        session_id: String,
        content: String,
        usage: Option<TokenUsage>,
    },
    #[serde(rename = "system")]
    System {
        uuid: String,
        parent_uuid: Option<String>,
        timestamp: String,
        session_id: String,
        content: String,
    },
    #[serde(rename = "custom_title")]
    CustomTitle {
        session_id: String,
        title: String,
    },
    #[serde(rename = "summary")]
    Summary {
        session_id: String,
        leaf_uuid: String,
        summary: String,
    },
}

impl TranscriptEntry {
    pub fn new_user(session_id: &str, content: &str, parent_uuid: Option<String>) -> Self {
        Self::User {
            uuid: Uuid::new_v4().to_string(),
            parent_uuid,
            timestamp: Utc::now().to_rfc3339(),
            session_id: session_id.to_string(),
            content: content.to_string(),
        }
    }

    pub fn new_assistant(
        session_id: &str,
        content: &str,
        parent_uuid: Option<String>,
        usage: Option<TokenUsage>,
    ) -> Self {
        Self::Assistant {
            uuid: Uuid::new_v4().to_string(),
            parent_uuid,
            timestamp: Utc::now().to_rfc3339(),
            session_id: session_id.to_string(),
            content: content.to_string(),
            usage,
        }
    }

    pub fn uuid(&self) -> &str {
        match self {
            TranscriptEntry::User { uuid, .. } => uuid,
            TranscriptEntry::Assistant { uuid, .. } => uuid,
            TranscriptEntry::System { uuid, .. } => uuid,
            TranscriptEntry::CustomTitle { .. } => "",
            TranscriptEntry::Summary { .. } => "",
        }
    }

    pub fn parent_uuid(&self) -> Option<&str> {
        match self {
            TranscriptEntry::User { parent_uuid, .. } => parent_uuid.as_deref(),
            TranscriptEntry::Assistant { parent_uuid, .. } => parent_uuid.as_deref(),
            TranscriptEntry::System { parent_uuid, .. } => parent_uuid.as_deref(),
            TranscriptEntry::CustomTitle { .. } => None,
            TranscriptEntry::Summary { .. } => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_user_entry_serialization_roundtrip() {
        let entry = TranscriptEntry::User {
            uuid: "u1".to_string(),
            parent_uuid: None,
            timestamp: "2026-01-01T00:00:00Z".to_string(),
            session_id: "s1".to_string(),
            content: "hello".to_string(),
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("\"type\":\"user\""));
        assert!(json.contains("\"content\":\"hello\""));

        let de: TranscriptEntry = serde_json::from_str(&json).unwrap();
        assert!(matches!(de, TranscriptEntry::User { .. }));
    }

    #[test]
    fn test_assistant_entry_with_usage() {
        let entry = TranscriptEntry::Assistant {
            uuid: "a1".to_string(),
            parent_uuid: Some("u1".to_string()),
            timestamp: "2026-01-01T00:00:00Z".to_string(),
            session_id: "s1".to_string(),
            content: "response".to_string(),
            usage: Some(TokenUsage {
                input_tokens: 100,
                output_tokens: 50,
            }),
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("\"type\":\"assistant\""));
        assert!(json.contains("\"input_tokens\":100"));

        let de: TranscriptEntry = serde_json::from_str(&json).unwrap();
        if let TranscriptEntry::Assistant { usage, .. } = de {
            assert_eq!(usage.unwrap().input_tokens, 100);
        } else {
            panic!("Expected Assistant variant");
        }
    }

    #[test]
    fn test_custom_title_no_uuid_fields() {
        let entry = TranscriptEntry::CustomTitle {
            session_id: "s1".to_string(),
            title: "My Chat".to_string(),
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("\"type\":\"custom_title\""));
        assert!(!json.contains("uuid"));

        let de: TranscriptEntry = serde_json::from_str(&json).unwrap();
        assert!(matches!(de, TranscriptEntry::CustomTitle { .. }));
    }

    #[test]
    fn test_summary_entry_serialization() {
        let entry = TranscriptEntry::Summary {
            session_id: "s1".to_string(),
            leaf_uuid: "leaf-1".to_string(),
            summary: "conversation about X".to_string(),
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("\"type\":\"summary\""));

        let de: TranscriptEntry = serde_json::from_str(&json).unwrap();
        assert!(matches!(de, TranscriptEntry::Summary { .. }));
    }

    #[test]
    fn test_new_user_helper() {
        let entry = TranscriptEntry::new_user("s1", "hi", None);
        assert!(matches!(entry, TranscriptEntry::User { .. }));
        assert_eq!(entry.parent_uuid(), None);
        assert!(!entry.uuid().is_empty());
    }

    #[test]
    fn test_new_assistant_helper() {
        let entry = TranscriptEntry::new_assistant(
            "s1",
            "hello!",
            Some("parent-uuid".to_string()),
            None,
        );
        assert!(matches!(entry, TranscriptEntry::Assistant { .. }));
        assert_eq!(entry.parent_uuid(), Some("parent-uuid"));
    }

    #[test]
    fn test_parent_uuid_chain() {
        let user = TranscriptEntry::new_user("s1", "q", None);
        let user_uuid = user.uuid().to_string();
        let assistant = TranscriptEntry::new_assistant(
            "s1",
            "a",
            Some(user_uuid.clone()),
            None,
        );
        assert_eq!(assistant.parent_uuid(), Some(user_uuid.as_str()));
    }
}
```

- [ ] 运行测试

```bash
cd /Users/zhushanwen/Code/xyz-agent/xyz-agent/src-tauri
cargo test models::transcript::tests -- --nocapture
```

**期望输出**：
```
running 7 tests
... all ok
```

### 步骤 2.3: 写 event.rs 测试

- [ ] 创建 `src-tauri/src/models/event.rs`

```rust
use serde::{Deserialize, Serialize};

use super::transcript::TokenUsage;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AgentEvent {
    TextDelta {
        session_id: String,
        delta: String,
    },
    ThinkingDelta {
        session_id: String,
        delta: String,
    },
    MessageComplete {
        session_id: String,
        role: String,
        content: String,
        usage: TokenUsage,
    },
    Error {
        session_id: String,
        message: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_text_delta_serialization() {
        let event = AgentEvent::TextDelta {
            session_id: "s1".to_string(),
            delta: "Hello".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"TextDelta\""));
        assert!(json.contains("\"delta\":\"Hello\""));

        let de: AgentEvent = serde_json::from_str(&json).unwrap();
        assert!(matches!(de, AgentEvent::TextDelta { .. }));
    }

    #[test]
    fn test_thinking_delta_serialization() {
        let event = AgentEvent::ThinkingDelta {
            session_id: "s1".to_string(),
            delta: "thinking...".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"ThinkingDelta\""));
    }

    #[test]
    fn test_message_complete_serialization() {
        let event = AgentEvent::MessageComplete {
            session_id: "s1".to_string(),
            role: "assistant".to_string(),
            content: "full response".to_string(),
            usage: TokenUsage {
                input_tokens: 200,
                output_tokens: 100,
            },
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"MessageComplete\""));
        assert!(json.contains("\"input_tokens\":200"));

        let de: AgentEvent = serde_json::from_str(&json).unwrap();
        if let AgentEvent::MessageComplete { usage, .. } = de {
            assert_eq!(usage.input_tokens, 200);
        } else {
            panic!("Expected MessageComplete");
        }
    }

    #[test]
    fn test_error_event_serialization() {
        let event = AgentEvent::Error {
            session_id: "s1".to_string(),
            message: "API key missing".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"Error\""));
        assert!(json.contains("\"message\":\"API key missing\""));
    }

    #[test]
    fn test_event_deserialization_from_json_str() {
        let json = r#"{"type":"TextDelta","session_id":"abc","delta":"x"}"#;
        let event: AgentEvent = serde_json::from_str(json).unwrap();
        if let AgentEvent::TextDelta { session_id, delta, .. } = event {
            assert_eq!(session_id, "abc");
            assert_eq!(delta, "x");
        } else {
            panic!("Expected TextDelta");
        }
    }
}
```

- [ ] 运行测试

```bash
cd /Users/zhushanwen/Code/xyz-agent/xyz-agent/src-tauri
cargo test models::event::tests -- --nocapture
```

**期望输出**：
```
running 5 tests
... all ok
```

### 步骤 2.4: 更新 models/mod.rs 和 lib.rs

- [ ] 写入 `src-tauri/src/models/mod.rs`

```rust
pub mod event;
pub mod transcript;

pub use event::AgentEvent;
pub use transcript::{TokenUsage, TranscriptEntry};
```

- [ ] 更新 `src-tauri/src/lib.rs`

```rust
mod error;
pub mod models;
// 后续 Task 解除注释:
// pub mod db;
// pub mod services;
// pub mod commands;

pub fn run() {
    // Task 7 填充
}
```

### 步骤 2.5: 全量测试 + Commit

- [ ] 运行全部测试

```bash
cd /Users/zhushanwen/Code/xyz-agent/xyz-agent/src-tauri
cargo test 2>&1 | tail -10
```

**期望输出**：
```
running 16 tests
... all ok
test result: ok. 16 passed; 0 failed; 0 ignored
```

- [ ] Commit

```bash
git add -A
git commit -m "feat: add data models (TranscriptEntry, AgentEvent, AppError)

TDD: tests first, then implementation.
- AppError with thiserror, Serialize, From<AppError> for String
- TranscriptEntry enum with serde tag='type' and rename
- AgentEvent enum for streaming events
- Helper constructors for User and Assistant entries
- 16 tests all passing"
```

---

## Task 3: JSONL 存储层

### 步骤 3.1: 写 jsonl.rs 测试（append + read）

- [ ] 创建 `src-tauri/src/db/jsonl.rs`，先写测试和函数签名

```rust
use std::fs::{File, OpenOptions};
use std::io::{BufRead, Write};
use std::path::Path;

use file_lock::FileLock;
use serde_json;

use crate::error::AppError;
use crate::models::transcript::TranscriptEntry;

/// 追加一行 JSONL，使用文件锁防止并发冲突
pub fn append_entry(path: &Path, entry: &TranscriptEntry) -> Result<(), AppError> {
    // 先确保父目录存在
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::Storage(format!("create dir failed: {e}")))?;
    }

    // 获取文件锁（若文件不存在则创建）
    let should_create = !path.exists();
    let lock_path = path.to_path_buf();
    let mut file_lock = FileLock::lock(
        &lock_path,
        should_create,
        OpenOptions::new().append(true).create(true),
    )
    .map_err(|e| AppError::Storage(format!("file lock failed: {e}")))?;

    let json_line = serde_json::to_string(entry)
        .map_err(|e| AppError::Storage(format!("serialize failed: {e}")))?;

    writeln!(file_lock.file, "{json_line}")
        .map_err(|e| AppError::Storage(format!("write failed: {e}")))?;

    file_lock.file.flush()
        .map_err(|e| AppError::Storage(format!("flush failed: {e}")))?;

    // drop 时自动释放锁
    Ok(())
}

/// 读取全部 JSONL 条目
pub fn read_all_entries(path: &Path) -> Result<Vec<TranscriptEntry>, AppError> {
    if !path.exists() {
        return Ok(vec![]);
    }

    let file = File::open(path)
        .map_err(|e| AppError::Storage(format!("open failed: {e}")))?;

    let reader = std::io::BufReader::new(file);
    let mut entries = Vec::new();

    for (line_num, line) in reader.lines().enumerate() {
        let line = line.map_err(|e| AppError::Storage(format!("read line failed: {e}")))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let entry: TranscriptEntry = serde_json::from_str(trimmed).map_err(|e| {
            AppError::Storage(format!("parse line {} failed: {e}", line_num + 1))
        })?;
        entries.push(entry);
    }

    Ok(entries)
}

/// 将文件路径转为安全的目录名（替换 / 为 -）
pub fn sanitize_path(path: &str) -> String {
    let sanitized = path.replace('/', "-");
    // 去掉开头的 -
    sanitized.trim_start_matches('-').to_string()
}

/// 通过 parent_uuid 回溯构建对话链
/// leaf_uuid 为 None 时返回全部条目；为 Some 时回溯到根节点
pub fn build_conversation_chain(
    entries: &[TranscriptEntry],
    leaf_uuid: Option<&str>,
) -> Vec<TranscriptEntry> {
    let leaf = match leaf_uuid {
        Some(uuid) => uuid,
        None => return entries.to_vec(),
    };

    // 建立 uuid -> entry 索引
    let mut index = std::collections::HashMap::new();
    for entry in entries {
        let uuid = entry.uuid();
        if !uuid.is_empty() {
            index.insert(uuid.to_string(), entry.clone());
        }
    }

    // 从 leaf 回溯到根
    let mut chain = Vec::new();
    let mut current_uuid = Some(leaf.to_string());

    while let Some(uuid) = current_uuid {
        if let Some(entry) = index.get(&uuid) {
            current_uuid = entry.parent_uuid().map(|s| s.to_string());
            chain.push(entry.clone());
        } else {
            break;
        }
    }

    // 反转使得根在前
    chain.reverse();
    chain
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::transcript::TokenUsage;
    use tempfile::TempDir;

    fn make_user(uuid: &str, parent: Option<&str>, session: &str, content: &str) -> TranscriptEntry {
        TranscriptEntry::User {
            uuid: uuid.to_string(),
            parent_uuid: parent.map(|s| s.to_string()),
            timestamp: "2026-01-01T00:00:00Z".to_string(),
            session_id: session.to_string(),
            content: content.to_string(),
        }
    }

    fn make_assistant(uuid: &str, parent: &str, session: &str, content: &str) -> TranscriptEntry {
        TranscriptEntry::Assistant {
            uuid: uuid.to_string(),
            parent_uuid: Some(parent.to_string()),
            timestamp: "2026-01-01T00:00:01Z".to_string(),
            session_id: session.to_string(),
            content: content.to_string(),
            usage: Some(TokenUsage { input_tokens: 10, output_tokens: 5 }),
        }
    }

    #[test]
    fn test_append_and_read() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.jsonl");

        let entry1 = make_user("u1", None, "s1", "hello");
        let entry2 = make_assistant("a1", "u1", "s1", "hi there");

        append_entry(&path, &entry1).unwrap();
        append_entry(&path, &entry2).unwrap();

        let entries = read_all_entries(&path).unwrap();
        assert_eq!(entries.len(), 2);

        // 验证序列化保持了 type tag
        assert!(matches!(entries[0], TranscriptEntry::User { .. }));
        assert!(matches!(entries[1], TranscriptEntry::Assistant { .. }));
    }

    #[test]
    fn test_read_empty_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nonexistent.jsonl");

        let entries = read_all_entries(&path).unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn test_append_creates_parent_dirs() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nested/deep/test.jsonl");

        let entry = make_user("u1", None, "s1", "hello");
        append_entry(&path, &entry).unwrap();

        assert!(path.exists());
        let entries = read_all_entries(&path).unwrap();
        assert_eq!(entries.len(), 1);
    }

    #[test]
    fn test_sanitize_path() {
        assert_eq!(sanitize_path("/Users/test/projects/my-app"), "Users-test-projects-my-app");
        assert_eq!(sanitize_path("C:\\Users\\test"), "C:\\Users\\test");
        assert_eq!(sanitize_path(""), "");
        assert_eq!(sanitize_path("/"), "");
    }

    #[test]
    fn test_build_chain_linear() {
        // u1 -> a1 -> u2 -> a2 (线性链)
        let u1 = make_user("u1", None, "s1", "q1");
        let a1 = make_assistant("a1", "u1", "s1", "r1");
        let u2 = make_user("u2", Some("a1"), "s1", "q2");
        let a2 = make_assistant("a2", "u2", "s1", "r2");

        let entries = vec![u1, a1.clone(), u2.clone(), a2.clone()];

        // 从 a2 回溯
        let chain = build_conversation_chain(&entries, Some("a2"));
        assert_eq!(chain.len(), 4);
        assert_eq!(chain[0].uuid(), "u1");
        assert_eq!(chain[3].uuid(), "a2");
    }

    #[test]
    fn test_build_chain_from_middle() {
        let u1 = make_user("u1", None, "s1", "q1");
        let a1 = make_assistant("a1", "u1", "s1", "r1");
        let u2 = make_user("u2", Some("a1"), "s1", "q2");

        let entries = vec![u1, a1, u2.clone()];

        // 从 u2 回溯（不包含 u2 之后的条目）
        let chain = build_conversation_chain(&entries, Some("u2"));
        assert_eq!(chain.len(), 3);
        assert_eq!(chain[0].uuid(), "u1");
        assert_eq!(chain[2].uuid(), "u2");
    }

    #[test]
    fn test_build_chain_none_returns_all() {
        let u1 = make_user("u1", None, "s1", "q1");
        let a1 = make_assistant("a1", "u1", "s1", "r1");

        let entries = vec![u1, a1];
        let chain = build_conversation_chain(&entries, None);
        assert_eq!(chain.len(), 2);
    }

    #[test]
    fn test_build_chain_unknown_leaf() {
        let u1 = make_user("u1", None, "s1", "q1");
        let entries = vec![u1];
        let chain = build_conversation_chain(&entries, Some("nonexistent"));
        assert!(chain.is_empty());
    }
}
```

- [ ] 运行 jsonl 测试

```bash
cd /Users/zhushanwen/Code/xyz-agent/xyz-agent/src-tauri
cargo test db::jsonl::tests -- --nocapture
```

**期望输出**：
```
running 8 tests
... all ok
```

### 步骤 3.2: 写 session_index.rs 测试和实现

- [ ] 创建 `src-tauri/src/db/session_index.rs`

```rust
use std::path::Path;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::AppError;
use crate::models::transcript::TranscriptEntry;

use super::jsonl::{self, read_all_entries};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMeta {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
}

/// 扫描目录下的 .jsonl 文件，提取 session 元数据
pub fn list_sessions(projects_dir: &Path, cwd: &str) -> Result<Vec<SessionMeta>, AppError> {
    let safe_cwd = jsonl::sanitize_path(cwd);
    let session_dir = projects_dir.join("projects").join(&safe_cwd);

    if !session_dir.exists() {
        return Ok(vec![]);
    }

    let mut sessions = Vec::new();

    let entries = std::fs::read_dir(&session_dir)
        .map_err(|e| AppError::Storage(format!("read dir failed: {e}")))?;

    for entry in entries {
        let entry = entry.map_err(|e| AppError::Storage(format!("dir entry failed: {e}")))?;
        let path = entry.path();

        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }

        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown");

        // 从文件内容提取元数据
        let entries = read_all_entries(&path)?;
        let title = extract_title(&entries).unwrap_or_else(|| stem.to_string());
        let created_at = entries
            .first()
            .and_then(|e| match e {
                TranscriptEntry::User { timestamp, .. } => Some(timestamp.clone()),
                TranscriptEntry::Assistant { timestamp, .. } => Some(timestamp.clone()),
                TranscriptEntry::System { timestamp, .. } => Some(timestamp.clone()),
                _ => None,
            })
            .unwrap_or_default();

        let updated_at = path
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .map(|t| {
                let dt: chrono::DateTime<Utc> = t.into();
                dt.to_rfc3339()
            })
            .unwrap_or_default();

        sessions.push(SessionMeta {
            id: stem.to_string(),
            title,
            created_at,
            updated_at,
        });
    }

    // 按更新时间倒序
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(sessions)
}

/// 创建新的 session，返回元数据
pub fn new_session(projects_dir: &Path, cwd: &str) -> Result<SessionMeta, AppError> {
    let safe_cwd = jsonl::sanitize_path(cwd);
    let session_dir = projects_dir.join("projects").join(&safe_cwd);
    std::fs::create_dir_all(&session_dir)
        .map_err(|e| AppError::Storage(format!("create session dir failed: {e}")))?;

    let session_id = Uuid::new_v4().to_string();
    let path = session_dir.join(format!("{session_id}.jsonl"));

    let now = Utc::now().to_rfc3339();
    let system_entry = TranscriptEntry::System {
        uuid: Uuid::new_v4().to_string(),
        parent_uuid: None,
        timestamp: now.clone(),
        session_id: session_id.clone(),
        content: "New session started".to_string(),
    };

    jsonl::append_entry(&path, &system_entry)?;

    Ok(SessionMeta {
        id: session_id,
        title: "New Session".to_string(),
        created_at: now,
        updated_at: Utc::now().to_rfc3339(),
    })
}

/// 从 entries 中提取标题（取第一条 user 消息的前 50 字符）
fn extract_title(entries: &[TranscriptEntry]) -> Option<String> {
    entries.iter().find_map(|e| match e {
        TranscriptEntry::User { content, .. } => {
            let chars: Vec<char> = content.chars().collect();
            let title = if chars.len() > 50 {
                let truncated: String = chars[..50].iter().collect();
                format!("{}...", truncated)
            } else {
                content.clone()
            };
            Some(title)
        }
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_new_session_creates_file() {
        let dir = TempDir::new().unwrap();
        let meta = new_session(dir.path(), "/Users/test/project").unwrap();

        assert!(!meta.id.is_empty());
        assert_eq!(meta.title, "New Session");
        assert!(!meta.created_at.is_empty());

        // 验证文件存在
        let safe_cwd = jsonl::sanitize_path("/Users/test/project");
        let file_path = dir.path()
            .join("projects")
            .join(&safe_cwd)
            .join(format!("{}.jsonl", meta.id));
        assert!(file_path.exists());

        // 验证内容包含 system 条目
        let entries = read_all_entries(&file_path).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(matches!(entries[0], TranscriptEntry::System { .. }));
    }

    #[test]
    fn test_list_sessions_empty() {
        let dir = TempDir::new().unwrap();
        let sessions = list_sessions(dir.path(), "/some/path").unwrap();
        assert!(sessions.is_empty());
    }

    #[test]
    fn test_list_sessions_with_data() {
        let dir = TempDir::new().unwrap();

        // 创建两个 session
        let meta1 = new_session(dir.path(), "/project").unwrap();
        let meta2 = new_session(dir.path(), "/project").unwrap();

        // 给第一个 session 添加 user 消息（用于提取标题）
        let safe_cwd = jsonl::sanitize_path("/project");
        let file1 = dir.path()
            .join("projects")
            .join(&safe_cwd)
            .join(format!("{}.jsonl", meta1.id));
        let user_entry = TranscriptEntry::new_user(&meta1.id, "This is my first question", None);
        jsonl::append_entry(&file1, &user_entry).unwrap();

        let sessions = list_sessions(dir.path(), "/project").unwrap();
        assert_eq!(sessions.len(), 2);

        // 按更新时间倒序，最新的在前
        assert_eq!(sessions[0].id, meta2.id);
        assert_eq!(sessions[1].id, meta1.id);

        // 第一个 session 有 user 消息作为标题
        assert_eq!(sessions[1].title, "This is my first question");
    }

    #[test]
    fn test_new_session_different_cwd() {
        let dir = TempDir::new().unwrap();

        new_session(dir.path(), "/project-a").unwrap();
        new_session(dir.path(), "/project-b").unwrap();

        let sessions_a = list_sessions(dir.path(), "/project-a").unwrap();
        let sessions_b = list_sessions(dir.path(), "/project-b").unwrap();

        assert_eq!(sessions_a.len(), 1);
        assert_eq!(sessions_b.len(), 1);
    }
}
```

- [ ] 运行 session_index 测试

```bash
cd /Users/zhushanwen/Code/xyz-agent/xyz-agent/src-tauri
cargo test db::session_index::tests -- --nocapture
```

**期望输出**：
```
running 4 tests
... all ok
```

### 步骤 3.3: 更新 db/mod.rs 和 lib.rs

- [ ] 写入 `src-tauri/src/db/mod.rs`

```rust
pub mod jsonl;
pub mod session_index;
```

- [ ] 更新 `src-tauri/src/lib.rs`

```rust
mod error;
pub mod models;
pub mod db;
// 后续 Task 解除注释:
// pub mod services;
// pub mod commands;

pub fn run() {
    // Task 7 填充
}
```

### 步骤 3.4: 全量测试 + Commit

- [ ] 运行全部测试

```bash
cd /Users/zhushanwen/Code/xyz-agent/xyz-agent/src-tauri
cargo test 2>&1 | tail -15
```

**期望输出**：
```
running 28 tests
... all ok
test result: ok. 28 passed; 0 failed; 0 ignored
```

(16 个模型测试 + 8 个 jsonl 测试 + 4 个 session_index 测试)

- [ ] Commit

```bash
git add -A
git commit -m "feat: add JSONL storage layer with session index

TDD: tests first, then implementation.
- db/jsonl: append_entry (with file lock), read_all_entries, build_conversation_chain, sanitize_path
- db/session_index: SessionMeta, list_sessions, new_session
- tempfile as dev-dependency for isolated tests
- 12 new tests (8 jsonl + 4 session_index), total 28 passing"
```
