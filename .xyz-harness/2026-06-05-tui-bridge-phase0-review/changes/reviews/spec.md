---
verdict: pass
---

# Phase 0：TUI Bridge — EventAdapter 前置修改 + 基础设施加固

## Background

pi RPC 模式（`pi --mode rpc`）下，extension 的 TUI 操作通过 JSON-RPC 事件（stdout）推送，xyz-agent 的 `EventAdapter` 负责翻译为 WS 协议 `ServerMessage`。

当前 `EventAdapter` 覆盖约 75% 的事件类型，存在三类缺口：
1. **P0 — 方法遗漏**：`editor` 和 `set_editor_text` 未匹配，导致 `ctx.ui.editor()` 永远挂起、`setEditorText()` 静默失败
2. **P1 — 字段丢失**：`message_start` 未按 role 路由（bashExecution/compactionSummary/branchSummary 数据不完整）、image content 被丢弃、`agent_end` 未透传 responseModel
3. **P1 — 事件丢弃**：`auto_retry_start/end`、`queue_update`、`session_info_changed`、`thinking_level_changed` 被完全丢弃

同时，前端 event-bus 使用 `string type`（无编译检查），随着 WS 事件类型从 60+ 扩展到 70+，类型风险放大。Phase 0 一并做类型加固。

**范围**：仅限 EventAdapter 翻译层 + 事件路由基础设施（event-bus + protocol.ts + useChat handler + ChatStore 字段）。不包含 GUI 组件改动（EditorDialog、ChatPanel UI 等归 Phase 1-2）。

**Date**: 2026-06-05

## Functional Requirements

### FR-1：EventAdapter 增加 editor/set_editor_text/extension_error 修复

- `extension_ui_request` 中 `method === 'editor'` 被匹配并转发为 `extension.ui_request`，payload 含 `title` 和 `prefill`（当前只处理 confirm/select/input/notify 四种）
- `extension_ui_request` 中 `method === 'set_editor_text'` 被匹配并转发为新事件 `extension:setEditorText`，payload 含 `text`
- `extension_error` 的 `extensionName` 字段改为读 `event.extensionPath`（实际字段）而非 `event.extensionName`（永远空字符串），并新增透传 `event.event`（触发错误的原始事件名）

**前置条件**：
- `protocol.ts` 的 `ExtensionUIRequestPayload.method` 类型从 `'confirm' | 'select' | 'input' | 'notify'` 扩展为 `'confirm' | 'select' | 'input' | 'notify' | 'editor'`
- `ServerMessageType` 增加 `'extension:setEditorText'`
- `ExtensionErrorPayload` 增加 `errorEvent?: string` 字段

### FR-2：EventAdapter 按 msg.role 路由特殊消息类型

`message_start` 事件中，按 `msg.role` 而非仅 `msg.customType` 路由：

| role | 转发事件 | payload 内容 |
|------|---------|-------------|
| `bashExecution` | `message.bashExecution` | 完整 BashExecutionMessage（command, output, exitCode, cancelled, truncated, fullOutputPath, excludeFromContext） |
| `compactionSummary` | `message.compactionSummary` | 完整 CompactionSummaryMessage（summary, tokensBefore, timestamp） |
| `branchSummary` | `message.branchSummary` | 完整 BranchSummaryMessage（summary, fromId, timestamp） |
| `custom`（含 customType） | `message.message_start`（加强） | 补传 `details` 和 `display` 字段，`display:false` 的消息前端不渲染 |

**前置条件**：`ServerMessageType` 增加 `'message.bashExecution'`、`'message.compactionSummary'`、`'message.branchSummary'`

### FR-3：EventAdapter 转发 auto_retry/queue_update/session_info_changed/thinking_level_changed

| 事件 | 转发类型 | payload |
|------|---------|---------|
| `auto_retry_start` | `message.auto_retry_start` | attempt, maxAttempts, delayMs, errorMessage |
| `auto_retry_end` | `message.auto_retry_end` | success, attempt, finalError |
| `queue_update` | `message.queue_update` | steering[], followUp[] |
| `session_info_changed` | `session.renamed`（已有类型） | name |
| `thinking_level_changed` | `session.thinkingLevelSet`（已有类型） | level |

**前置条件**：`ServerMessageType` 增加 `'message.auto_retry_start'`、`'message.auto_retry_end'`、`'message.queue_update'`

### FR-4：EventAdapter 保留 image content + details 透传

- `tool_execution_end`：提取 `content` 中的 `type: 'image'` 块（data + mimeType），随 `message.tool_call_end` 的 `images` 字段转发
- `tool_execution_update`：`partialResult` 可能为对象（含 `content` + `details`），当前只取字符串。改为提取 `partialResult.details` 结构化数据（BashToolDetails 的 truncation/fullOutputPath 等）
- `agent_end`：提取 `lastMsg.responseModel` 和 `lastMsg.diagnostics`，随 `message.complete` 的 `responseModel`/`diagnostics` 字段转发

**前置条件**：`message.tool_call_end` payload 的类型定义需支持 `images?: Array<{data: string; mimeType: string}>`

### FR-5：EventAdapter 增加 message_update error 子类型

`message_update` 中 `assistantMessageEvent.type === "error"` 当前落入 default 分支打印 warn 后丢弃。改为转发为 `message.stream_error`，含 `reason`（aborted/error）和具体错误内容。

**前置条件**：`ServerMessageType` 增加 `'message.stream_error'`

### FR-6：EventAdapter 增加 setTitle matcher

`extension_ui_request` 中 `method === 'setTitle'` 转发为 `extension:setTitle`。

**前置条件**：`ServerMessageType` 增加 `'extension:setTitle'`

### FR-7：event-bus 类型加固

将 event-bus 的 `on(event: string, handler)` / `emit(event: string, data)` 签名改为：

```typescript
on(event: ServerMessageType, handler: (msg: ServerMessage) => void): () => void
emit(event: ServerMessageType, msg: ServerMessage): void
```

**关键约束**：
- 所有现有 handler 签名已经是 `(msg: ServerMessage) => void`，迁移无侵入
- `off()` 和 `clear()` 保持向后兼容

### FR-8：useChat 新增全局事件 handler

以下事件在 `useChat.ts` 的 `createGlobalHandlers()` 中注册 handler：

| WS 事件 | handler 名 | 操作 |
|---------|-----------|------|
| `extension:setEditorText` | `onSetEditorText` | 写入 `ChatStore.sessionState.pendingEditorText` |
| `message.bashExecution` | `onBashExecution` | 创建系统消息显示命令+输出+退出码 |
| `message.compactionSummary` | `onCompactionSummary` | 创建系统消息显示摘要 |
| `message.branchSummary` | `onBranchSummary` | 创建系统消息显示分支摘要 |
| `message.auto_retry_start` | `onAutoRetryStart` | 写入 `ChatStore.sessionState.autoRetryState` |
| `message.auto_retry_end` | `onAutoRetryEnd` | 清除 `autoRetryState` |
| `message.queue_update` | `onQueueUpdate` | 写入 `ChatStore.sessionState.queueState` |
| `session.renamed` | `onSessionRenamed` | 更新 `SessionStore` 中的 session 名称 |
| `session.thinkingLevelSet` | `onThinkingLevelSet` | 写入 `ChatStore.sessionState.thinkingLevel` |
| `extension:setTitle` | `onExtensionSetTitle` | 通过 `window.electronAPI` 设置窗口标题 |
| `message.stream_error` | `onStreamError` | 插入系统错误消息 |

### FR-9：ChatStore 新增字段

每个字段均为纯 session 分区（可选，无值时不出现在序列化结果中）：

| 字段 | 类型 | 默认值 | 用途 |
|------|------|--------|------|
| `pendingEditorText` | `string \| undefined` | undefined | extension 预填充输入框 |
| `autoRetryState` | `AutoRetryState \| undefined` | undefined | 自动重试状态 |
| `queueState` | `QueueState \| undefined` | undefined | 排队消息 |
| `thinkingLevel` | `string \| undefined` | undefined | 当前 thinking level |
| `responseModel` | `string \| undefined` | undefined | 实际模型名 |

```typescript
interface AutoRetryState {
  active: boolean
  attempt: number
  maxAttempts: number
  delayMs: number
  errorMessage?: string
}

interface QueueState {
  steering: string[]
  followUp: string[]
}
```

## Acceptance Criteria

### AC-1：EventAdapter 翻译正确定

- [AC-1.1] 输入 pi `extension_ui_request`（method='editor'），输出 WS `extension.ui_request`（payload.method='editor', title, prefill）
- [AC-1.2] 输入 pi `extension_ui_request`（method='set_editor_text'），输出 WS `extension:setEditorText`（payload.text）
- [AC-1.3] 输入 pi `extension_error`（含 extensionPath='a/b/c.ts'），输出 WS `extension.error`（payload.extensionName='a/b/c.ts'）
- [AC-1.4] 输入 pi `message_start`（role='bashExecution'），输出 WS `message.bashExecution`（payload 含 command, output, exitCode）
- [AC-1.5] 输入 pi `message_start`（role='compactionSummary'），输出 WS `message.compactionSummary`（payload 含 summary, tokensBefore）
- [AC-1.6] 输入 pi `message_start`（role='branchSummary'），输出 WS `message.branchSummary`（payload 含 summary, fromId）
- [AC-1.7] 输入 pi `auto_retry_start`（含 attempt=2, maxAttempts=3），输出 WS `message.auto_retry_start`（payload.attempt=2, maxAttempts=3）
- [AC-1.8] 输入 pi `queue_update`（含 steering=['msg1']），输出 WS `message.queue_update`（payload.steering=['msg1']）
- [AC-1.9] 输入 pi `tool_execution_end`（content 含 type:'image'），输出 WS `message.tool_call_end`（payload.images[0].mimeType 匹配）
- [AC-1.10] 输入 pi `agent_end`（lastMsg.responseModel='gpt-4o'），输出 WS `message.complete`（payload.responseModel='gpt-4o'）
- [AC-1.11] 输入 pi `message_update`（type='error'），输出 WS `message.stream_error`
- [AC-1.12] 输入 pi `session_info_changed`（name='new-name'），输出 WS `session.renamed`（payload.name='new-name'）
- [AC-1.13] 输入 pi `thinking_level_changed`（level='high'），输出 WS `session.thinkingLevelSet`（payload.level='high'）
- [AC-1.14] 输入 pi `extension_ui_request`（method='setTitle'），输出 WS `extension:setTitle`（payload.title）

### AC-2：event-bus 类型安全

- [AC-2.1] `on('message.text_delta', handler)` 编译通过，handler 参数类型为 `ServerMessage`
- [AC-2.2] `emit('message.text_delta', msg)` 编译通过，msg 类型被约束到 `ServerMessage` 结构
- [AC-2.3] 传入不存在的 event type 时编译报错
- [AC-2.4] 所有现有 `on()` 调用不变更 handler 签名的情况下编译通过

### AC-3：useChat handler 正确路由

- [AC-3.1] `onAutoRetryStart` 收到事件后，ChatStore 对应 session 分区的 `autoRetryState.active === true`
- [AC-3.2] `onQueueUpdate` 收到事件后，ChatStore 对应 session 分区的 `queueState.steering` 长度匹配
- [AC-3.3] `onSessionRenamed` 收到事件后，SessionStore 中对应 session 的 name 被更新
- [AC-3.4] 所有新 handler 在 sessionId 不匹配时静默忽略（session 隔离性）

### AC-4：ChatStore 新增字段

- [AC-4.1] 新增字段均为可选，`getSessionState` 创建新 session 时不包含这些字段
- [AC-4.2] 设置/读取/清空各字段的值正确
- [AC-4.3] `removeSession` 后这些字段一并删除

### AC-5：无回归

- [AC-5.1] 所有现有 EventAdapter 测试（event-adapter-bridge.test.ts + event-adapter-extension.test.ts）全部通过
- [AC-5.2] 所有现有 useChat 测试（useChat.test.ts + useChat-subagent.test.ts + useChat-subagent-boundary.test.ts）全部通过
- [AC-5.3] 原有的 `message.tool_call_start/end`、`message.text_delta` 等事件流不受影响

## Constraints

### C-1：pi RPC 事件格式不变
- pi 的 RPC 事件结构（`extension_ui_request`、`message_start`、`tool_execution_update` 等）已审计确定，EventAdapter 基于当前 pi 0.75.5-xyz-0.1 版本实现
- 不修改 pi 源码

### C-2：现有 handler 签名不变
- event-bus 类型加固（方案 B）不能改变 handler 签名 `(msg: ServerMessage) => void`
- 所有现有 `on()` 调用无需修改 handler body

### C-3：向后兼容
- 所有新增 ServerMessageType 是新增类型，不会删除或重命名现有类型
- ChatStore 新增字段全部可选，不影响现有 session 序列化/恢复

### C-4：Session 隔离
- 所有新事件 handler 必须按 `payload.sessionId` 路由到正确的 ChatStore 分区
- 缺失 sessionId 的事件被忽略（与现有 `useChat` 行为一致）

### C-5：无 GUI 组件改动
- Phase 0 不包含任何 Vue 组件改动（EditorDialog、ChatPanel、AppStatusbar、WidgetDock 等归 Phase 1-2）

## Complexity Assessment

| 维度 | 评估 |
|------|------|
| 代码量 | ~450 行（EventAdapter ~180、protocol.ts ~50、event-bus ~30、useChat ~140、ChatStore ~50） |
| 测试量 | ~380 行 |
| 涉及文件 | ~8 个（5 个改 + 3 个新增测试） |
| 技术风险 | 🟡 中等 — EventAdapter 是核心翻译层，15 处修改需要完备的单测覆盖 |
| 耦合度 | 🟡 中 — 改动集中在 runtime/ 和 shared/，renderer 的改动（useChat + ChatStore）是纯增量 |
| 回退难度 | 🟢 低 — 所有修改是新增 case / 新增字段 / 新增 handler，不破坏现有逻辑，可以逐个 revert |
| 总评估 | 🟢 低-中复杂度，~450 行代码 + ~380 行测试，预计 2-3 天完成 |
