# 代码链路分析报告 -- 前后端集成对齐检查

## 概述

- 分析文件：
  - `src/lib/tauri.ts` -- Tauri invoke/listen 封装
  - `src/composables/useChat.ts` -- 对话 composable
  - `src/composables/useSession.ts` -- Session 管理
  - `src/types/index.ts` -- 类型定义
- 对标后端：
  - `src-tauri/src/commands/session.rs`
  - `src-tauri/src/commands/chat.rs`
  - `src-tauri/src/models/event.rs`
  - `src-tauri/src/models/transcript.rs`
  - `src-tauri/src/db/session_index.rs`
  - `src-tauri/src/services/event_bus.rs`
  - `src-tauri/src/services/agent_loop.rs`
- 分析时间：2026-04-09
- 语言类型：TypeScript (前端) / Rust (后端)

## 调用链路图

### 下游调用链（前端 -> Rust）

```
App.vue
  |
  +-- Sidebar.vue
  |     +-- useSession()
  |           +-- listSessions(cwd)  -->  invoke('list_sessions', {cwd})
  |           |                            --> Rust: list_sessions(cwd: String, state)
  |           +-- createNewSession()
  |                 +-- createSession(cwd) --> invoke('new_session', {cwd})
  |                                             --> Rust: new_session(cwd: String, state)
  |                                                 --> session_index::new_session()
  |                                                 --> 返回 {session_id, title} (json!手动构造)
  |
  +-- ChatView.vue
        +-- useChat(sessionIdRef)
              +-- onMounted --> onAgentEvent() --> listen('agent-event')
              |                                 <-- Rust: app_handle.emit("agent-event", &event)
              |                                     <-- event_bus::spawn_bridge()
              |                                         <-- agent_loop::run_turn() 通过 event_tx
              |
              +-- send(content)
              |    +-- sendMessage(sessionId, content) --> invoke('send_message', {sessionId, content})
              |                                          --> Rust: send_message(session_id: String, content: String, state, app)
              |                                              --> find_session_path()
              |                                              --> jsonl::read_all_entries()
              |                                              --> jsonl::append_entry() [写入 user entry]
              |                                              --> event_bus::spawn_bridge()
              |                                              --> AgentLoop::run_turn()
              |                                              --> jsonl::append_entry() [写入 assistant entry]
              |
              +-- loadHistory(sid)
                   +-- getHistory(sessionId) --> invoke('get_history', {sessionId})
                                                 --> Rust: get_history(session_id: String, state)
                                                     --> walkdir_for_session()
                                                     --> jsonl::read_all_entries()
```

### 上游数据流向

```
用户操作
  |
  [点击"新建对话"] --> Sidebar.createNewSession()
  |                     --> createSession('/') --> Rust new_session --> 创建 .jsonl 文件
  |                     --> loadSessions()     --> Rust list_sessions --> 返回 SessionMeta[]
  |                     --> currentSessionId = result.session_id
  |
  [点击 session 列表项] --> Sidebar.selectSession(id)
  |                        --> currentSessionId = id
  |                        --> ChatView watch trigger --> useChat.loadHistory(sid)
  |                                                      --> getHistory(sid) --> Rust get_history
  |
  [输入消息并发送] --> ChatView.handleSend(content)
                       --> useChat.send(content)
                           --> 乐观更新: push user message
                           --> sendMessage(sessionId, content) --> Rust send_message
                           --> AgentLoop 开始流式输出
                           --> event_tx --> event_bus bridge --> app_handle.emit("agent-event")
                           --> 前端 listen 回调接收 AgentEvent
                               --> TextDelta: 累加 streamingText
                               --> MessageComplete: push assistant message, 清空 streamingText
                               --> Error: push system error message
```

## 数据链路图

### 1. invoke 参数名映射（关键对齐点）

| 前端 invoke 调用 | 前端传参 key | Rust 参数名 | Tauri v2 默认行为 | 是否匹配 |
|---|---|---|---|---|
| `invoke('new_session', {cwd})` | `cwd` | `cwd: String` | camelCase -> snake_case | **匹配** |
| `invoke('list_sessions', {cwd})` | `cwd` | `cwd: String` | camelCase -> snake_case | **匹配** |
| `invoke('get_history', {sessionId})` | `sessionId` | `session_id: String` | camelCase -> snake_case 自动转换 | **匹配** |
| `invoke('send_message', {sessionId, content})` | `sessionId` | `session_id: String` | camelCase -> snake_case 自动转换 | **匹配** |
| `invoke('send_message', {sessionId, content})` | `content` | `content: String` | camelCase -> snake_case | **匹配** |

**说明**：Tauri v2 默认 `#[tauri::command]` 将前端的 camelCase 参数名自动转为 Rust 的 snake_case。因此前端传 `sessionId` 会自动映射到 Rust 的 `session_id`。当前四个命令均未使用 `rename_all` 属性，遵循默认行为，参数映射正确。

### 2. Tauri Event 对齐

| 项目 | 前端 | 后端 | 是否匹配 |
|---|---|---|---|
| Event 名称 | `listen('agent-event', ...)` | `app_handle.emit("agent-event", &event)` | **匹配** |
| Payload 类型 | `AgentEvent` (前端 TS 类型) | `AgentEvent` (Rust enum, `#[serde(tag="type")]`) | 见下方详情 |

### 3. AgentEvent 类型对齐

| 前端 TS 定义 | Rust 枚举变体 | serde 序列化后 type 值 | 是否匹配 |
|---|---|---|---|
| `{type:'TextDelta', session_id, delta}` | `TextDelta{session_id, delta}` | `"TextDelta"` | **匹配** |
| `{type:'ThinkingDelta', session_id, delta}` | `ThinkingDelta{session_id, delta}` | `"ThinkingDelta"` | **匹配** |
| `{type:'MessageComplete', session_id, role, content, usage}` | `MessageComplete{session_id, role, content, usage}` | `"MessageComplete"` | **匹配** |
| `{type:'Error', session_id, message}` | `Error{session_id, message}` | `"Error"` | **匹配** |

**字段名对齐**：Rust 端的 `AgentEvent` 未使用 `rename_all`，serde 默认按原字段名序列化（snake_case）。前端 TS 类型定义也使用 snake_case (`session_id`, `input_tokens`, `output_tokens`)，两者一致。

### 4. SessionInfo vs SessionMeta 对齐

| 前端 SessionInfo 字段 | 后端 SessionMeta 字段 | 返回路径 | 是否匹配 |
|---|---|---|---|
| `id: string` | `pub id: String` | `list_sessions` 直接返回 `Vec<SessionMeta>` | **匹配** |
| `title: string` | `pub title: String` | 同上 | **匹配** |
| `created_at: string` | `pub created_at: String` | 同上 | **匹配** |
| `updated_at: string` | `pub updated_at: String` | 同上 | **匹配** |

**注意**：`new_session` 命令不直接返回 `SessionMeta`，而是手动构造 `json!({session_id, title})`。前端 `createSession` 的返回类型定义为 `{session_id: string; path: string}`，但后端实际返回 `{session_id, title}` -- 这里有不一致，详见问题清单。

### 5. TranscriptEntry 类型对齐

| 前端 TS 定义 | Rust 枚举变体 | serde tag 值 | 是否匹配 |
|---|---|---|---|
| `{type:'user', uuid, parent_uuid, timestamp, session_id, content}` | `User{uuid, parent_uuid, timestamp, session_id, content}` | `"user"` | **匹配** |
| `{type:'assistant', uuid, parent_uuid, timestamp, session_id, content, usage}` | `Assistant{uuid, parent_uuid, timestamp, session_id, content, usage}` | `"assistant"` | **匹配** |
| `{type:'system', uuid, parent_uuid, timestamp, session_id, content}` | `System{uuid, parent_uuid, timestamp, session_id, content}` | `"system"` | **匹配** |
| *(前端未定义)* | `CustomTitle{session_id, title}` | `"custom_title"` | 前端缺失 |
| *(前端未定义)* | `Summary{session_id, leaf_uuid, summary}` | `"summary"` | 前端缺失 |

## 链路详情

### invoke 调用完整追踪

| # | 前端函数 | invoke 命令 | Rust handler | 返回类型 | 状态 |
|---|---|---|---|---|---|
| 1 | `createSession(cwd)` | `new_session` | `commands::session::new_session` | `Result<Value, String>` -> `{session_id, title}` | 有问题 |
| 2 | `listSessions(cwd)` | `list_sessions` | `commands::session::list_sessions` | `Result<Vec<SessionMeta>, String>` | 正常 |
| 3 | `getHistory(sessionId)` | `get_history` | `commands::session::get_history` | `Result<Vec<TranscriptEntry>, String>` | 正常 |
| 4 | `sendMessage(sessionId, content)` | `send_message` | `commands::chat::send_message` | `Result<(), String>` | 正常 |

### Event 流完整追踪

```
AgentLoop::run_turn()
  --> event_tx.send(AgentEvent::TextDelta{...})
  --> event_tx.send(AgentEvent::ThinkingDelta{...})
  --> event_tx.send(AgentEvent::MessageComplete{...})
  --> event_tx.send(AgentEvent::Error{...})
  |
  v
event_bus::spawn_bridge(app_handle, event_rx)
  --> tokio::spawn: rx.recv() --> app_handle.emit("agent-event", &event)
  |
  v
前端 onAgentEvent() --> listen<AgentEvent>('agent-event')
  --> event.payload --> handler(event)
  |
  v
useChat onMounted:
  --> TextDelta: streamingText += event.delta
  --> ThinkingDelta: *(未处理)*
  --> MessageComplete: push message, reset streaming
  --> Error: push error message, reset streaming
```

## 问题清单

### 严重问题（8-10分）

#### P0-1: createSession 返回值类型与后端不匹配（严重度: 9）

- **前端定义**：`createSession` 返回 `Promise<{session_id: string; path: string}>`
- **后端实际返回**：`serde_json::json!({"session_id": meta.id, "title": meta.title})`
- **不匹配点**：
  - 前端期望 `path` 字段，后端返回 `title` 字段
  - 前端不期望 `title` 字段（不会出错但不完整）
  - 前端使用 `result.session_id`，该字段存在，不会运行时崩溃
- **影响**：`useSession.ts` 第20行 `result.session_id` 可正常工作，但 `path` 为 `undefined`。如果后续代码依赖 `path` 会产生 bug。当前代码仅使用 `session_id`，暂无崩溃风险，但类型定义与实际行为不一致，会在 TypeScript 编译时产生错误的安全感。
- **修复建议**：将前端 `createSession` 返回类型改为 `Promise<{session_id: string; title: string}>`，或者后端 `new_session` 返回完整 `SessionMeta`。

#### P0-2: ThinkingDelta 事件前端未处理（严重度: 8）

- **前端 useChat** 的 `switch(event.type)` 只处理了 `TextDelta`、`MessageComplete`、`Error`
- **后端 AgentLoop** 会发送 `ThinkingDelta` 事件
- **影响**：`ThinkingDelta` 事件被静默丢弃，用户无法看到 AI 的思考过程。如果产品需要展示思考过程，这是一个功能缺失。
- **修复建议**：在 `useChat.ts` 的 switch 中添加 `ThinkingDelta` 处理分支，或在前端 UI 中添加思考过程展示区域。

### 一般问题（5-7分）

#### P1-1: TranscriptEntry 前端缺少 CustomTitle 和 Summary 变体（严重度: 6）

- **后端 Rust** 定义了 5 种 `TranscriptEntry` 变体：User, Assistant, System, CustomTitle, Summary
- **前端 TS** 只定义了 3 种：user, assistant, system
- **影响**：`get_history` 返回的 JSONL 文件可能包含 `custom_title` 和 `summary` 类型的条目。前端 `loadHistory` 通过 `filter(e => e.type === 'user' || e.type === 'assistant')` 过滤，所以这些条目不会显示，不会导致崩溃。但 TypeScript 类型检查无法覆盖这些变体，如果未来需要展示 summary 则需要扩展。
- **修复建议**：在前端 `TranscriptEntry` 类型中补充 `CustomTitle` 和 `Summary` 变体定义，保持类型完整性。

#### P1-2: new_session 后端手动构造 JSON 而非返回结构体（严重度: 5）

- **后端 `new_session` 命令**使用 `serde_json::json!({session_id, title})` 手动构造返回值
- **`list_sessions` 命令**直接返回 `Vec<SessionMeta>`（包含 id, title, created_at, updated_at）
- **不一致**：同一实体的两个接口返回不同结构和字段数
- **影响**：`new_session` 缺少 `created_at` 和 `updated_at` 字段。虽然前端当前未使用这些字段，但接口不一致会在后续扩展时造成困惑。
- **修复建议**：将 `new_session` 改为直接返回 `SessionMeta` 结构体，与 `list_sessions` 保持一致。

### 轻微问题（1-4分）

#### P2-1: listSessions 和 createSession 硬编码 cwd 为 '/'（严重度: 3）

- **前端 `useSession.ts`** 第10行 `listSessions('/')` 和第18行 `createSession('/')`
- **影响**：无法按项目目录区分 session，所有 session 都存储在根路径下。这可能是早期开发阶段的硬编码，后续需要改为动态 cwd。
- **修复建议**：通过 Tauri API 获取当前工作目录，或让用户在 UI 中选择项目路径。

#### P2-2: useChat 中 loadHistory 未处理错误（严重度: 2）

- **前端 `useChat.ts`** 第59行 `loadHistory` 函数中，`getHistory(sid)` 的 await 没有 try-catch
- **影响**：如果 Rust 端返回错误（session 文件不存在等），Promise reject 会导致未捕获的异常
- **修复建议**：添加 try-catch 包裹，在错误时显示提示或清空消息列表。

#### P2-3: StatusBar 硬编码 model-name（严重度: 1）

- **前端 `App.vue`** 第19行 `<StatusBar :is-streaming="false" model-name="claude-sonnet-4-5" />`
- **后端实际使用**：`agent_loop.rs` 第32行 `let model = "claude-sonnet-4-20250514"`
- **影响**：UI 显示的模型名与实际调用模型不一致。且 `is-streaming` 始终为 false，未与实际流式状态联动。
- **修复建议**：将 is-streaming 绑定到 useChat 的 isStreaming ref，将 model-name 改为动态获取或与后端保持一致。

## 建议

### 高优先级

1. **修复 createSession 返回类型**：将 `tauri.ts` 中 `createSession` 的返回类型从 `{session_id, path}` 改为 `{session_id, title}`，与后端 `json!` 构造一致。或让后端返回完整的 `SessionMeta`。

2. **处理 ThinkingDelta 事件**：在 `useChat.ts` 中添加 `ThinkingDelta` case，至少将思考过程累积显示，避免信息丢失。

### 中优先级

3. **补全 TranscriptEntry 类型**：在前端类型定义中添加 `CustomTitle` 和 `Summary` 变体，保持类型系统完整。

4. **统一 new_session 返回结构**：后端 `new_session` 改为返回 `SessionMeta`，与 `list_sessions` 保持一致。

### 低优先级

5. **动态 cwd**：将硬编码的 `'/'` 改为可配置的项目路径。

6. **错误处理**：在 `loadHistory` 和 `send` 中添加 try-catch 错误处理。
