# Pi Extension UI 的 RPC 通道清单

> 调研日期：2026-06-04
> 来源：Pi 官方文档 `rpc.md`

## 概述

RPC 模式（`pi --mode rpc`）下，extension 通过 `extension_ui_request` 子协议与外部客户端通信。能力分为 **Dialog**（需回复）和 **Fire-and-forget**（单向推送）两类，加上完整的 RPC 命令通道和事件流。所有依赖直接 TUI 渲染的能力在 RPC 模式下不可用。

---

## 一、Extension UI 子协议

### 1.1 Dialog 方法（stdout 请求 → stdin 回复）

客户端必须在收到 `extension_ui_request` 后发送对应的 `extension_ui_response`（匹配 `id`）。

| 方法 | `method` 值 | 请求字段 | 回复字段 |
|------|------------|---------|---------|
| 选择 | `select` | `title`, `options[]`, `timeout?` | `value` 或 `cancelled: true` |
| 确认 | `confirm` | `title`, `message`, `timeout?` | `confirmed: true/false` 或 `cancelled: true` |
| 输入 | `input` | `title`, `placeholder` | `value` 或 `cancelled: true` |
| 多行编辑 | `editor` | `title`, `prefill` | `value` 或 `cancelled: true` |

**超时机制**：dialog 支持 `timeout`（毫秒），超时后 agent 侧自动 resolve 默认值（select/input/editor → `undefined`，confirm → `false`），客户端无需追踪。

#### 请求/回复格式

```jsonc
// 请求（stdout）
{"type": "extension_ui_request", "id": "uuid-1", "method": "select", "title": "...", "options": [...]}

// 回复 - 值类型（stdin）
{"type": "extension_ui_response", "id": "uuid-1", "value": "selected option"}

// 回复 - 确认类型（stdin）
{"type": "extension_ui_response", "id": "uuid-2", "confirmed": true}

// 回复 - 取消（stdin，适用于所有 dialog）
{"type": "extension_ui_response", "id": "uuid-3", "cancelled": true}
```

### 1.2 Fire-and-forget 方法（只发 stdout，不需要回复）

| 方法 | `method` 值 | 关键字段 | 说明 |
|------|------------|---------|------|
| 通知 | `notify` | `message`, `notifyType` ("info"/"warning"/"error") | 显示通知 |
| Footer 状态 | `setStatus` | `statusKey`, `statusText?` | 设置/清除状态栏条目 |
| Widget | `setWidget` | `widgetKey`, `widgetLines?`, `widgetPlacement?` ("aboveEditor"/"belowEditor") | 设置/清除编辑器上方/下方文本块。**只支持字符串数组，组件工厂模式被忽略** |
| 终端标题 | `setTitle` | `title` | 设置窗口标题 |
| 编辑器文本 | `set_editor_text` | `text` | 预填充输入框文本 |

#### 请求格式

```jsonc
{"type": "extension_ui_request", "id": "uuid-5", "method": "notify", "message": "...", "notifyType": "warning"}
{"type": "extension_ui_request", "id": "uuid-6", "method": "setStatus", "statusKey": "my-ext", "statusText": "..."}
{"type": "extension_ui_request", "id": "uuid-7", "method": "setWidget", "widgetKey": "plan", "widgetLines": ["--- Plan ---", "1. Step one"], "widgetPlacement": "aboveEditor"}
{"type": "extension_ui_request", "id": "uuid-8", "method": "setTitle", "title": "pi - my project"}
{"type": "extension_ui_request", "id": "uuid-9", "method": "set_editor_text", "text": "prefilled text"}
```

---

## 二、RPC 命令通道

直接发送 JSON 命令到 stdin，通过 `type` 字段区分。所有命令支持可选 `id` 字段用于请求/响应关联。

### 2.1 提示与控制

| 命令 | `type` 值 | 说明 |
|------|----------|------|
| 发送消息 | `prompt` | 发送用户消息，流式时需指定 `streamingBehavior`（"steer"/"followUp"） |
| 转向 | `steer` | 流式中转向，agent turn 间插入 |
| 后续 | `follow_up` | agent 完成后执行 |
| 中止 | `abort` | 中止当前 agent 操作 |

### 2.2 状态查询

| 命令 | `type` 值 | 返回数据 |
|------|----------|---------|
| 状态 | `get_state` | model, thinkingLevel, isStreaming, isCompacting, sessionFile, sessionId, sessionName, autoCompactionEnabled, messageCount, pendingMessageCount, steeringMode, followUpMode |
| 消息 | `get_messages` | messages[] (AgentMessage[]) |
| Session 统计 | `get_session_stats` | tokens (input/output/cacheRead/cacheWrite/total), cost, contextUsage (tokens/contextWindow/percent) |
| 可用命令 | `get_commands` | commands[] (name, description, source, location, path) |
| Fork 消息 | `get_fork_messages` | messages[] (entryId, text) |
| 最后 assistant 文本 | `get_last_assistant_text` | text: string \| null |

### 2.3 模型与思考级别

| 命令 | `type` 值 | 说明 |
|------|----------|------|
| 设置模型 | `set_model` | `provider` + `modelId` |
| 切换模型 | `cycle_model` | 下一个可用模型 |
| 可用模型列表 | `get_available_models` | models[] |
| 设置思考级别 | `set_thinking_level` | "off"/"minimal"/"low"/"medium"/"high"/"xhigh" |
| 切换思考级别 | `cycle_thinking_level` | 循环切换 |

### 2.4 Compaction

| 命令 | `type` 值 | 说明 |
|------|----------|------|
| 手动 compact | `compact` | 可选 `customInstructions` |
| 自动 compact | `set_auto_compaction` | `enabled: boolean` |

### 2.5 Session 管理

| 命令 | `type` 值 | 说明 |
|------|----------|------|
| 新 session | `new_session` | 可选 `parentSession` |
| 切换 session | `switch_session` | `sessionPath` |
| Fork | `fork` | `entryId` |
| Clone | `clone` | 复制当前分支 |
| 设置 session 名 | `set_session_name` | `name` |
| 导出 HTML | `export_html` | 可选 `outputPath` |

### 2.6 Bash 执行

| 命令 | `type` 值 | 说明 |
|------|----------|------|
| 执行命令 | `bash` | `command`，返回 output/exitCode/cancelled/truncated/fullOutputPath |
| 中止 bash | `abort_bash` | 中止运行中的命令 |

**注意**：bash 结果通过 `BashExecutionMessage` 存储，在下一次 `prompt` 时作为 UserMessage 的一部分发送给 LLM，不会独立触发事件。

### 2.7 队列与重试

| 命令 | `type` 值 | 说明 |
|------|----------|------|
| Steering 模式 | `set_steering_mode` | "all" / "one-at-a-time" |
| FollowUp 模式 | `set_follow_up_mode` | "all" / "one-at-a-time" |
| 自动重试 | `set_auto_retry` | `enabled: boolean` |
| 中止重试 | `abort_retry` | 取消正在进行的重试等待 |

---

## 三、RPC 事件流（stdout 推送）

事件没有 `id` 字段（只有 response 才有）。

### 3.1 Agent 生命周期事件

| 事件 | 说明 |
|------|------|
| `agent_start` | Agent 开始处理 prompt |
| `agent_end` | Agent 完成，包含所有 messages[] |
| `turn_start` | 新 turn 开始 |
| `turn_end` | Turn 完成，包含 message + toolResults[] |

### 3.2 消息事件

| 事件 | 说明 |
|------|------|
| `message_start` | 消息开始，包含完整 message |
| `message_update` | 流式更新，包含 partial message + `assistantMessageEvent` delta |
| `message_end` | 消息完成 |

#### assistantMessageEvent delta 类型

| type | 说明 |
|------|------|
| `start` | 消息生成开始 |
| `text_start` / `text_delta` / `text_end` | 文本内容块 |
| `thinking_start` / `thinking_delta` / `thinking_end` | Thinking 内容块 |
| `toolcall_start` / `toolcall_delta` / `toolcall_end` | 工具调用（toolcall_end 包含完整 toolCall） |
| `done` | 完成（reason: "stop"/"length"/"toolUse"） |
| `error` | 错误（reason: "aborted"/"error"） |

### 3.3 工具执行事件

| 事件 | 说明 |
|------|------|
| `tool_execution_start` | 工具开始执行（toolCallId, toolName, args） |
| `tool_execution_update` | 流式进度（partialResult 是累积输出，不是增量） |
| `tool_execution_end` | 工具完成（result, isError） |

用 `toolCallId` 关联三个事件。

### 3.4 系统事件

| 事件 | 说明 |
|------|------|
| `queue_update` | steering/followUp 队列变化 |
| `compaction_start` | Compaction 开始（reason: "manual"/"threshold"/"overflow"） |
| `compaction_end` | Compaction 完成（result, aborted, willRetry） |
| `auto_retry_start` | 自动重试开始（attempt, maxAttempts, delayMs, errorMessage） |
| `auto_retry_end` | 自动重试完成（success, attempt, finalError?） |
| `extension_error` | Extension 抛错（extensionPath, event, error） |

---

## 四、RPC 模式下不可用的 TUI 能力

| API | RPC 行为 | 原因 |
|-----|---------|------|
| `ctx.ui.custom()` | 返回 `undefined` | 需要直接 TUI 渲染 |
| `setWorkingMessage()` | no-op | 依赖 TUI 行内渲染 |
| `setWorkingIndicator()` | no-op | 依赖 TUI 动画帧 |
| `setWorkingVisible()` | no-op | TUI 可见性控制 |
| `setFooter()` | no-op | 需要直接替换 TUI footer |
| `setHeader()` | no-op | 需要直接替换 TUI header |
| `setEditorComponent()` | no-op | 需要直接替换 TUI editor |
| `setToolsExpanded()` | no-op | TUI 展开控制 |
| `getEditorText()` | 返回 `""` | 无 TUI editor 实例 |
| `getToolsExpanded()` | 返回 `false` | 无 TUI 状态 |
| `pasteToEditor()` | 降级为 `setEditorText()` | 无 paste/collapse 处理 |
| `getAllThemes()` | 返回 `[]` | 无 TUI 主题系统 |
| `getTheme()` | 返回 `undefined` | 无 TUI 主题实例 |
| `setTheme()` | 返回 `{ success: false }` | 无 TUI 主题切换 |
| `addAutocompleteProvider()` | no-op | 无 TUI 补全 UI |
| `setWidget` 组件工厂 | 忽略 | 只支持字符串数组 |
| `registerMessageRenderer()` | 不生效 | 无 TUI 消息渲染 |
| `registerTool` renderCall/renderResult | 不生效 | 无 TUI 工具渲染 |

**`ctx.hasUI` 在 RPC 模式下为 `true`**，因为 dialog 和 fire-and-forget 方法通过 extension UI 子协议可用。

---

## 五、对 xyz-agent 架构的启示

### 5.1 可利用的 RPC 渠道

xyz-agent 作为 RPC 客户端，可利用的能力：

| 类别 | 可做 | 不可做 |
|------|------|--------|
| 消息流 | 完整接收 agent_start → message_update → agent_end | 自定义消息/工具的渲染（需要在 xyz-agent 侧自行渲染） |
| 用户交互 | 通过 extension_ui_request 实现 select/confirm/input/editor | custom() 全屏组件、overlay |
| 状态展示 | setStatus（Footer 状态）、setWidget（Widget 区文本） | setFooter（完全替换）、setHeader、setWorkingMessage |
| 编辑器 | set_editor_text（预填充） | setEditorComponent（替换编辑器）、addAutocompleteProvider |
| 主题 | 不可用 | 完全不可用 |

### 5.2 需要在 xyz-agent 侧自行实现的 TUI 能力

由于 RPC 不透传渲染，以下 TUI 能力需要在 xyz-agent 前端自行实现：

1. **消息渲染**：基于 `message_update` 事件流 + `AgentMessage` 类型
2. **工具调用渲染**：基于 `tool_execution_*` 事件 + tool result content
3. **Working indicator**：基于 `agent_start` → 首个 `message_update` 间隔
4. **Widget 组件**：虽然 `setWidget` 可传字符串，但富组件（带主题/交互）需前端实现
5. **Footer 信息**：基于 `get_state` / `get_session_stats` 轮询或事件驱动
6. **Thinking 展示**：基于 `thinking_delta` 事件
7. **Diff 高亮**：基于 tool result content 中的 diff 文本

### 5.3 Widget 的 RPC 传递限制

`setWidget` 在 RPC 模式下只支持**字符串数组**，不支持组件工厂。这意味着：
- 简单文本 Widget：可直接传递，xyz-agent 侧简单渲染
- 富 Widget（进度条、交互列表等）：需要设计独立的通信协议（如通过 tool result details 或 extension event bus 传递结构化数据）
