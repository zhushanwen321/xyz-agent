# 代码修复计划

## 概述
- 批次：batch-20260409-p0-integration-check
- 严重问题：4 个
- 一般问题：6 个
- 轻微问题：5 个

## 优先修复（严重）

### Fix-1: parent_uuid 断链
**文件**: `src-tauri/src/services/agent_loop.rs` + `src-tauri/src/commands/chat.rs`
**评分**: 9

**问题**: `run_turn` 返回的 `TranscriptEntry::Assistant` 的 `parent_uuid` 硬编码为 `None`，对话链断裂。

**修复方案**:
1. 修改 `run_turn` 签名，增加 `parent_uuid: Option<String>` 参数
2. chat.rs 调用时传入 `Some(user_entry.uuid().to_string())`
3. 构造 TranscriptEntry::Assistant 时使用传入的 parent_uuid

```rust
// agent_loop.rs - 修改 run_turn 签名
pub async fn run_turn(
    &self,
    user_message: String,
    history: Vec<TranscriptEntry>,
    parent_uuid: Option<String>,  // 新增
    event_tx: tokio::sync::mpsc::UnboundedSender<AgentEvent>,
) -> Result<TranscriptEntry, AppError> {
    // ... 省略中间代码 ...
    Ok(TranscriptEntry::Assistant {
        uuid: uuid::Uuid::new_v4().to_string(),
        parent_uuid,  // 使用传入的值
        // ...
    })
}

// chat.rs - 调用时传入 parent_uuid
let assistant_entry = agent_loop
    .run_turn(content, history_with_user, Some(user_entry.uuid().to_string()), event_tx)
    .await
    .map_err(|e| e.to_string())?;
```

### Fix-2: 未知 SSE 事件过滤
**文件**: `src-tauri/src/services/llm.rs`
**评分**: 8

**问题**: `ping`、`message_start`、`content_block_start` 等事件被映射为空 TextDelta。

**修复方案**: default 分支改为过滤而非映射：

```rust
// 替换 default 分支
_ => {
    // 忽略不关心的事件类型（ping, message_start, content_block_start 等）
    // 返回一个特殊标记让上层跳过
    Ok(LlmStreamEvent::TextDelta { delta: String::new() })
}
```

更好的方案是让 agent_loop.rs 跳过空 delta：

```rust
// agent_loop.rs run_turn 中
Ok(LlmStreamEvent::TextDelta { delta }) => {
    if delta.is_empty() {
        // 跳过空 delta（来自未知 SSE 事件）
        continue;
    }
    full_content.push_str(&delta);
    let _ = event_tx.send(AgentEvent::TextDelta { ... });
}
```

### Fix-3: createSession 返回类型修正
**文件**: `src/lib/tauri.ts`
**评分**: 8

**修复方案**: 修正返回类型为与后端一致：

```typescript
export async function createSession(cwd: string): Promise<{ session_id: string; title: string }> {
  return invoke('new_session', { cwd })
}
```

### Fix-4: ThinkingDelta 显式处理
**文件**: `src/composables/useChat.ts`
**评分**: 7

**修复方案**: 在 switch 中添加显式处理（P0 暂不展示，仅打印到 console）：

```typescript
case 'ThinkingDelta':
  // P0 暂不展示思考过程
  console.debug('[ThinkingDelta]', event.delta)
  break
```

## 计划修复（一般）

### Fix-5: chat_stream_with_retry 限制重试条件
**文件**: `src-tauri/src/services/llm.rs`
**评分**: 6

只对 429/500/502/503/504 重试：

```rust
Err(e) => {
    let should_retry = e.to_string().contains("429")
        || e.to_string().contains("500")
        || e.to_string().contains("502")
        || e.to_string().contains("503")
        || e.to_string().contains("504");
    if !should_retry || attempt >= max_retries {
        return Err(e);
    }
    // ...
}
```

### Fix-6: 抽取公共 find_session_path
**文件**: `src-tauri/src/commands/session.rs` + `chat.rs`
**评分**: 6

将 `walkdir_for_session` 移到 `db/jsonl.rs` 或 `db/session_index.rs`，两处统一调用。

### Fix-7: 前端 TranscriptEntry 补全变体
**文件**: `src/types/index.ts`
**评分**: 6

添加 CustomTitle 和 Summary 变体定义（或使用过滤策略在 getHistory 时跳过）。

### Fix-8: new_session 返回完整 SessionMeta
**文件**: `src-tauri/src/commands/session.rs`
**评分**: 5

改为直接返回 `session_index::SessionMeta` 而非手动构造 JSON。

### Fix-9: run_turn 使用 chat_stream_with_retry
**文件**: `src-tauri/src/services/agent_loop.rs`
**评分**: 5

在 Fix-5 完成后，将 `self.provider.chat_stream(...)` 改为 `self.provider.chat_stream_with_retry(...)`。需要将 retry 方法提升到 trait 层级或使用具体类型。

### Fix-10: model 参数可配置
**文件**: `src-tauri/src/services/agent_loop.rs`
**评分**: 5

将 model 从函数参数传入或从 AppState 获取，不硬编码。

## 执行建议

1. **先修复 Fix-1（parent_uuid 断链）** — 这是唯一影响数据完整性的严重 bug
2. **再修复 Fix-2 + Fix-3 + Fix-4** — 消除无意义事件和类型不匹配
3. Fix-5~10 可在 P1 阶段处理
