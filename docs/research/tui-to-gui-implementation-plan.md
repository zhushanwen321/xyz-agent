# Pi TUI 操作 → xyz-agent GUI 实现方案

> 基于审计报告和组件映射规格的逐项实现方案
> 日期：2026-06-05
> 参考源：`docs/research/tui-to-gui-mapping-audit.md`、`docs/research/tui-to-gui-component-mapping.md`、`docs/research/pi-extension-tui-channels.md`、`docs/research/pi-extension-rpc-channels.md`

---

## 目录

1. [框架总览：TUI 六个布局区域 → GUI 实现](#一框架总览)
2. [Phase 0：EventAdapter 前置修改（必须先做）](#二phase-0eventadapter-前置修改)
3. [Phase 1：新建组件](#三phase-1新建组件)
4. [Phase 2：增强已有组件](#四phase-2增强已有组件)
5. [Phase 3：需改 pi / bridge extension 方案](#五phase-3需改-pi--bridge-extension-方案)
6. [附录：所有 TUI 渠道的 GUI 覆盖状态速查表](#六附录所有-tui-渠道的-gui-覆盖状态速查表)

---

## 一、框架总览

### 1.1 TUI 六个布局区域 → GUI 映射

```
┌──────────────────────────────────────────────────┐
│ Header（TUI）                                    │
│   → AppHeader.vue（✅ 已有，无关）               │
├──────────────────────────────────────────────────┤
│ 消息区（TUI）                                    │
│   → MessageBubble / StreamingMessage /           │
│     ToolCallCard / SystemNotification（✅ 已有）  │
│   → CustomMessageRenderer.vue（🔨 新建）         │
│   → 特殊消息类型（compaction/branch/skill）增强   │
├──────────────────────────────────────────────────┤
│ Widget - aboveEditor（TUI）                      │
│   → WidgetDock.vue（⚡ 增强）                    │
│     当前只支持纯文本 lines，需支持 placement    │
├──────────────────────────────────────────────────┤
│ Working Indicator（TUI）                         │
│   → ChatPanel "思考中..."（⚡ 增强）            │
│     需支持倒计时重试、排队消息指示              │
├──────────────────────────────────────────────────┤
│ Editor 输入区（TUI）                             │
│   → ChatInput.vue（⚡ 增强）                    │
│     预填充文本、Autocomplete provider            │
│   → EditorDialog.vue（🔨 新建）                 │
│     用于 extension 的 ctx.ui.editor() 多行编辑    │
├──────────────────────────────────────────────────┤
│ Widget - belowEditor（TUI）                      │
│   → WidgetDock.vue placement 支持（⚡ 增强）    │
├──────────────────────────────────────────────────┤
│ Footer（TUI）                                    │
│   → AppStatusbar.vue（⚡ 增强）                 │
│     需合并 extension status + thinking level     │
└──────────────────────────────────────────────────┘
```

### 1.2 总体实现优先级

| 优先级 | 阶段 | 内容 | 影响 |
|--------|------|------|------|
| 🔴 P0 | Phase 0 | EventAdapter 前置修正（editor、set_editor_text、extension_error 字段名） | 否则功能不可用/永远挂起 |
| 🔴 P0 | Phase 0 | EventAdapter 增加 editor/set_editor_text method 匹配 | extension 调用 ctx.ui.editor() 永远挂起；setEditorText() 静默失败 |
| 🟡 P1 | Phase 0 | EventAdapter 消息路由增强（区分 role、保留 image、透传 details） | 特殊消息类型、图片内容、bash 截断数据不可见 |
| 🟡 P1 | Phase 0 | EventAdapter 转发 auto_retry/queue_update/session_info_changed/thinking_level_changed | 用户无意识、排队不可见、session 改名不更新 |
| 🟡 P1 | Phase 0-1 | EditorDialog + ExtensionUIDialog editor 分支 | ctx.ui.editor() 可用 |
| 🟡 P1 | Phase 2 | AppStatusbar + ChatPanel 增强（自动重试、排队、responseModel） | 用户感知体验 |
| 🟢 P2 | Phase 2 | 特殊消息类型（compaction/branch/skill） | 信息完整度 |
| 🟢 P2 | Phase 2 | Tool renderer 细节增强（diff 高亮、截断、图片） | 视觉体验 |
| 🔴 需改 pi | Phase 3 | setWorkingMessage/setWorkingVisible/setToolsExpanded/addAutocompleteProvider | 需修改 pi rpc-mode.ts 才可用 |

---

## 二、Phase 0：EventAdapter 前置修改

这是所有 GUI 改动的前提。**必须先改 EventAdapter，再改前端组件。**

### 2.1 🔴 P0：extension_ui_request 增加 editor method 匹配

**现状**：EventAdapter 只匹配 `confirm/select/input/notify`，`editor` method 落入 return null 分支。

**后果**：extension 调用 `ctx.ui.editor(title, prefill)` 永远挂起，不会超时（虽然 pi 侧有超时注入默认值，但前端没收到事件没回复，用户永远不知道）。

**改动**：在 EventAdapter `extension_ui_request` case 中增加 `method === 'editor'` 分支：

```typescript
if (method === 'editor') {
  const requestId = String(event.id ?? '')
  this.options?.onExtensionUIRequest?.(requestId, sid, method)
  return {
    type: 'extension.ui_request',
    payload: {
      sessionId: sid,
      requestId,
      method, // 'editor'
      title: event.title,
      message: event.prefill, // prefill 文本作为 message 传给前端
    },
  }
}
```

**前置工作**：`ServerMessageType` 中 `extension.ui_request` 的 `ExtensionUIRequestPayload` 需要扩展 `method` 类型到 `'confirm' | 'select' | 'input' | 'notify' | 'editor'`（当前是 `'confirm' | 'select' | 'input' | 'notify'`）。

### 2.2 🔴 P0：extension_ui_request 增加 set_editor_text method 匹配

**现状**：EventAdapter 不匹配 `set_editor_text`，静默丢弃。

**后果**：extension 调用 `ctx.ui.setEditorText(text)` 后，ChatInput 不预填充文本。

**改动**：在 EventAdapter `extension_ui_request` case 中增加 `method === 'set_editor_text'` 分支：

```typescript
if (method === 'set_editor_text') {
  return {
    type: 'extension:setEditorText', // 新的 ServerMessageType
    payload: {
      sessionId: sid,
      text: String(event.text ?? ''),
    },
  }
}
```

**前置工作**：
1. `protocol.ts` 增加 `'extension:setEditorText'` 到 `ServerMessageType`
2. `ExtensionStatusPayload` style 的新 payload 类型

### 2.3 🔴 P0：extension_error 字段名 bug 修复

**现状**：EventAdapter 读 `event.extensionName`（永远是空字符串），但 pi 实际发出的是 `event.extensionPath`（全路径如 `/path/to/extension/index.ts`）

**后果**：前端显示 `Extension: ` 空名称，且丢失 `event.event`（触发错误的原始事件名）。

**改动**：

```typescript
case 'extension_error':
  return {
    type: 'extension.error',
    payload: {
      sessionId: sid,
      extensionName: event.extensionPath ?? event.extensionName ?? '',
      errorEvent: event.event as string | undefined, // 新增
      error: event.error ?? 'Unknown extension error',
    },
  }
```

**前置工作**：`ExtensionErrorPayload` 增加 `errorEvent?: string` 字段。

### 2.4 🟡 P1：message_start 按 msg.role 路由增强

**现状**：`message_start` 只检查 `msg.customType`，不区分 `msg.role`。`"bashExecution"`、`"compactionSummary"`、`"branchSummary"` 三种 role 的消息被当作普通 message_start 转发，丢失完整数据。

**后果**：
- BashExecutionMessage（用户 `!` 执行的命令）：command、exitCode、cancelled、truncated 等完整数据丢失
- CompactionSummaryMessage：tokensBefore、summary 数据丢失
- BranchSummaryMessage：fromId、summary 数据丢失

**改动**：

```typescript
case 'message_start': {
  const msg = event.message as Record<string, unknown> | undefined
  const role = msg?.role as string | undefined
  
  // 特殊 role 消息：bashExecution / compactionSummary / branchSummary
  if (role && ['bashExecution', 'compactionSummary', 'branchSummary'].includes(role)) {
    return {
      type: `message.${role}` as ServerMessageType, // 新类型
      payload: {
        sessionId: sid,
        role,
        ...msg, // 透传全部字段
      },
    }
  }
  
  // custom 消息
  if (msg?.customType) {
    const details = (msg?.details as Record<string, unknown>) ?? {}
    const display = (msg?.display as boolean) ?? true
    return {
      type: 'message.message_start',
      payload: {
        sessionId: sid,
        customType: msg.customType as string,
        content: msg.content as string,
        details,
        display,
      },
    }
  }
  return {
    type: 'message.message_start',
    payload: { sessionId: sid },
  }
}
```

**前置工作**：`ServerMessageType` 增加：
- `'message.bashExecution'`
- `'message.compactionSummary'`
- `'message.branchSummary'`

### 2.5 🟡 P1：tool_execution_end 保留 image content

**现状**：当前只提取 `type: 'text'` 的 content blocks，`type: 'image'` 的被丢弃。

**后果**：ToolResultMessage 中包含的图片（如 bash 生成的截图）在前端不可见。

**改动**：

```typescript
// 处理 tool_execution_end 的 output
const contentArr = (raw as Record<string, unknown>).content as Array<Record<string, unknown>> | undefined
const textParts: string[] = []
const imageParts: Array<{ data: string; mimeType: string }> = []
if (contentArr) {
  for (const c of contentArr) {
    if (c.type === 'text') {
      textParts.push((c.text as string) ?? '')
    } else if (c.type === 'image') {
      imageParts.push({ data: c.data as string, mimeType: (c.mimeType as string) ?? 'image/png' })
    }
  }
}
output = textParts.join('\n')

return {
  type: 'message.tool_call_end',
  payload: {
    sessionId: sid,
    toolCallId,
    output,
    images: imageParts.length > 0 ? imageParts : undefined, // 新增
    details,
    error: event.isError ? output : event.error,
  },
}
```

### 2.6 🟡 P1：tool_execution_update 透传 partialResult.details

**现状**：当前 `tool_execution_update` 只提取 `event.partialResult` 为字符串，丢失 BashToolDetails（truncation、fullOutputPath）等结构化数据。

**后果**：BashToolRenderer 无法在流式输出中实时判断截断状态和完整输出路径。

**改动**：

```typescript
case 'tool_execution_update': {
  const partialResult = event.partialResult
  let detail: string | undefined
  let details: Record<string, unknown> | undefined
  
  if (typeof partialResult === 'string') {
    detail = partialResult
  } else if (partialResult && typeof partialResult === 'object') {
    detail = (partialResult as Record<string, unknown>).content as string | undefined
    details = (partialResult as Record<string, unknown>).details as Record<string, unknown> | undefined
  }
  
  return {
    type: 'message.tool_call_update',
    payload: {
      sessionId: sid,
      toolCallId: event.toolCallId ?? '',
      detail,
      details, // 新增
    },
  }
}
```

### 2.7 🟡 P1：转发 auto_retry_start / auto_retry_end

**现状**：EventAdapter 当前丢弃这两个事件（注释："auto-retry 事件暂不转发"）。

**后果**：agent 出错自动重试时，前端无任何提示，用户以为卡死了。

**改动**：

```typescript
case 'auto_retry_start':
  return {
    type: 'message.auto_retry_start',
    payload: {
      sessionId: sid,
      attempt: event.attempt,
      maxAttempts: event.maxAttempts,
      delayMs: event.delayMs,
      errorMessage: event.errorMessage as string | undefined,
    },
  }
case 'auto_retry_end':
  return {
    type: 'message.auto_retry_end',
    payload: {
      sessionId: sid,
      success: event.success,
      attempt: event.attempt,
      finalError: event.finalError as string | undefined,
    },
  }
```

**前置工作**：`ServerMessageType` 增加 `'message.auto_retry_start'` 和 `'message.auto_retry_end'`

### 2.8 🟡 P1：转发 queue_update

**现状**：EventAdapter 不处理 `queue_update`。

**后果**：用户 steer/follow_up 的消息在 agent 忙时排队，前端不显示排队状态。

**改动**：

```typescript
case 'queue_update':
  return {
    type: 'message.queue_update',
    payload: {
      sessionId: sid,
      steering: event.steering as string[],
      followUp: event.followUp as string[],
    },
  }
```

**前置工作**：`ServerMessageType` 增加 `'message.queue_update'`

### 2.9 🟡 P1：转发 session_info_changed

**现状**：EventAdapter 不处理 `session_info_changed`。

**后果**：session 被重命名后 UI 不更新。

**改动**：

```typescript
case 'session_info_changed':
  return {
    type: 'session.renamed',
    payload: {
      sessionId: sid,
      name: event.name as string | undefined,
    },
  }
```

> 注意：`session.renamed` 在 `ServerMessageType` 中已存在（`session.renamed`），可以直接复用。

### 2.10 🟡 P1：转发 thinking_level_changed

**现状**：EventAdapter 不处理 `thinking_level_changed`。

**后果**：thinking level 被变更后 AppStatusbar 不更新。

**改动**：

```typescript
case 'thinking_level_changed':
  return {
    type: 'session.thinkingLevelSet',
    payload: {
      sessionId: sid,
      level: event.level,
    },
  }
```

> 注意：`session.thinkingLevelSet` 在 `ServerMessageType` 中已存在。

### 2.11 🟡 P1：agent_end 附带 responseModel + diagnostics

**现状**：`agent_end` 只提取 `stopReason` 和 `usage`，不提取 `responseModel` 和 `diagnostics`。

**后果**：
- 模型指示器无法显示实际使用的模型（当模型配置为 auto router 时）
- diagnostics（provider 错误恢复记录）丢失，调试困难

**改动**：

```typescript
case 'agent_end': {
  const messages = event.messages as Array<Record<string, unknown>> | undefined
  const lastMsg = messages?.[messages.length - 1]
  const rawReason = (lastMsg?.stopReason as string) ?? 'stop'
  const usage = lastMsg?.usage as ...
  const responseModel = lastMsg?.responseModel as string | undefined
  const diagnostics = lastMsg?.diagnostics as Array<Record<string, unknown>> | undefined
  
  // 省略现有 usage 处理...
  
  return {
    type: 'message.complete',
    payload: {
      sessionId: sid,
      stopReason: STOP_REASON_MAP[rawReason] ?? rawReason,
      usage: ...,
      responseModel, // 新增
      diagnostics,   // 新增（可选）
    },
  }
}
```

### 2.12 🟡 P1：message_start 补传 custom message 的 details + display

**现状**：CustomMessage 的 `details`（扩展数据）和 `display`（是否渲染到聊天流）被丢弃。

**后果**：`display: false` 的消息不应渲染到聊天流，但前端无法区分。

**改动**：见上文 2.4 中的 custom message 分支改动。

### 2.13 🟢 P2：message_update 增加 error 子类型转发

**现状**：`message_update` 中 `assistantMessageEvent.type === "error"` 落入 default 分支，打印 warn 后丢弃。

**后果**：provider 出错或 abort 时，前端只能通过 agent_end 的通用 stopReason 感知，无法显示具体错误消息。

**改动**：

```typescript
case 'error': {
  const errorMsg = sub.message as Record<string, unknown> | undefined
  return {
    type: 'message.stream_error',
    payload: {
      sessionId: sid,
      reason: sub.reason,
      content: errorMsg?.content as string ?? '',
    },
  }
}
```

### 2.14 🟢 P2：extension_ui_request 匹配 setTitle

**现状**：setTitle method 不处理。

**改动**：成本极低，增加匹配后转发到 Electron 窗口标题。

```typescript
if (method === 'setTitle') {
  return {
    type: 'extension:setTitle',
    payload: {
      sessionId: sid,
      title: String(event.title ?? ''),
    },
  }
}
```

### 2.15 EventAdapter 修改汇总

| 编号 | 修改点 | 优先级 | 新 ServerMessageType | 对应 GUI 组件 |
|------|--------|--------|---------------------|-------------|
| 2.1 | editor method 匹配 | 🔴 P0 | 复用 `extension.ui_request` | EditorDialog |
| 2.2 | set_editor_text method 匹配 | 🔴 P0 | `extension:setEditorText`（新增） | ChatInput |
| 2.3 | extension_error 字段名修复 | 🔴 P0 | 复用 `extension.error` | SystemNotification |
| 2.4 | message_start role 路由 | 🟡 P1 | `message.bashExecution`、`message.compactionSummary`、`message.branchSummary`（新增） | BashToolRenderer、SystemNotification |
| 2.5 | tool_execution_end 保留 image | 🟡 P1 | 复用 `message.tool_call_end` | ToolCallCard |
| 2.6 | tool_execution_update details | 🟡 P1 | 复用 `message.tool_call_update` | BashToolRenderer |
| 2.7 | auto_retry_start/end | 🟡 P1 | `message.auto_retry_start`、`message.auto_retry_end`（新增） | ChatPanel |
| 2.8 | queue_update | 🟡 P1 | `message.queue_update`（新增） | ChatPanel |
| 2.9 | session_info_changed | 🟡 P1 | 复用 `session.renamed` | ChatStore |
| 2.10 | thinking_level_changed | 🟡 P1 | 复用 `session.thinkingLevelSet` | AppStatusbar |
| 2.11 | agent_end 附带 responseModel/diagnostics | 🟡 P1 | 复用 `message.complete` | ChatPanel |
| 2.12 | message_start 补传 details/display | 🟡 P1 | 复用 `message.message_start` | CustomMessageRenderer |
| 2.13 | message_update error 子类型 | 🟢 P2 | `message.stream_error`（新增） | ChatPanel |
| 2.14 | setTitle matcher | 🟢 P2 | `extension:setTitle`（新增） | Electron 窗口 |

---

## 三、Phase 1：新建组件

### 3.1 🔨 EditorDialog.vue

**用途**：Extension 调用 `ctx.ui.editor(title, prefill)` 时弹出的多行文本编辑器。

**前置条件**：Phase 0 - EventAdapter 2.1（editor method 匹配）

**文件**：`src-electron/renderer/src/components/extension/EditorDialog.vue`

**规格**：
- 基于 `xyz-ui Dialog` 组件
- 多行文本编辑器（Textarea），等宽字体 `font-mono`
- Enter 提交（需 Shift+Enter 换行），Escape 取消
- 预填充 prefill 文本
- 标题显示

**Props**：
```typescript
{
  open: boolean
  title: string
  prefill?: string
  onConfirm: (value: string) => void
  onCancel: () => void
}
```

**集成**：
1. `ExtensionUIDialog.vue` 新增 `method === 'editor'` 分支
2. 渲染 `EditorDialog.vue`（或内联在 ExtensionUIDialog 中，因为后者已封装 Dialog）
3. 用户确认后 → `extension.ui_response` → pi extension 收到编辑器内容

### 3.2 🔨 CustomMessageRenderer.vue

**用途**：渲染 pi extension 通过 `pi.sendMessage({ customType, content, display: true })` 发送的自定义消息。

**前置条件**：Phase 0 - EventAdapter 2.4（补传 details + display）+ 2.12

**文件**：`src-electron/renderer/src/components/extension/CustomMessageRenderer.vue`

**规格**：
- 按 `customType` 查找注册的渲染器（插件注册表）
- 无匹配时 fallback 到通用渲染（显示 customType 标签 + content 文本）
- `display: false` 的消息不渲染
- 支持 expanded 模式展示 details

**Props**：
```typescript
{
  customType: string
  content: string | (TextContent | ImageContent)[]
  details?: Record<string, unknown>
  display: boolean
  expanded?: boolean
}
```

**消息路由**：
- `useChat.ts` 的 `onMessageStart` 中检测 `msg.customType`
- 如果是特殊 type（如 `'plan-mode'`、`'git-checkpoint'`），不进入普通消息流而是路由到 CustomMessageRenderer

---

## 四、Phase 2：增强已有组件

### 4.1 ⚡ ExtensionUIDialog.vue - 增加 editor 分支

**改动**：
1. 在 `<template>` 的 method 判断中增加 `editor` 分支
2. 复用现有 Dialog 框架，嵌入 Textarea
3. 处理 Enter/Shift+Enter 逻辑

```vue
<template v-else-if="method === 'editor'">
  <div class="flex flex-col gap-3">
    <p v-if="activeRequest?.message" class="text-sm leading-relaxed text-muted">
      {{ activeRequest.message }}
    </p>
    <textarea
      v-model="editorValue"
      class="font-mono text-sm p-3 border border-border rounded-sm bg-bg text-fg resize-y min-h-[120px]"
      :placeholder="activeRequest?.default ?? ''"
      @keydown.enter.prevent="handleEditorSubmit"
    />
    <div class="flex justify-end gap-2">
      <Button variant="outline" size="sm" @click="handleCancel">取消</Button>
      <Button variant="primary" size="sm" @click="handleEditorSubmit">提交</Button>
    </div>
  </div>
</template>
```

### 4.2 ⚡ ChatInput.vue - 预填充支持

**前置条件**：Phase 0 - EventAdapter 2.2（set_editor_text method 匹配）

**改动**：
1. 在 `useChat.ts`（或 `ChatPanel.vue`）中注册 `extension:setEditorText` 事件
2. 收到事件后更新 ChatInput 的 v-model 值
3. 不覆盖用户正在编辑的内容（只在 ChatInput 为空或焦点未激活时预填充）

```typescript
// useChat.ts 增加
function onSetEditorText(msg: ServerMessage) {
  const sid = getSid(msg)
  if (!sid) return
  const text = msg.payload.text as string
  // 这里需要与 ChatInput 通信
  store.setPendingEditorText(text, sid)
}
```

### 4.3 ⚡ AppStatusbar.vue - 合并 extension status + thinking level

**前置条件**：Phase 0 - EventAdapter 2.10（thinking_level_changed）

**改动**：
1. 新建 `extensionStatusItems` 数据源（来自 `extension:status` WS 事件）
2. 在 right 区域显示 thinking level 指示器（从 ChatStore 获取）
3. 合并现有 plugin statusBarItems 显示

```vue
<!-- 新增 thinking level 指示器 -->
<span v-if="currentThinkingLevel" class="inline-flex items-center gap-1 text-[10px] text-muted">
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
  </svg>
  {{ currentThinkingLevel }}
</span>
```

### 4.4 ⚡ ChatPanel.vue - 自动重试指示器

**前置条件**：Phase 0 - EventAdapter 2.7（auto_retry_start/end）

**改动**：
1. 新增 `autoRetryState` 响应式状态
2. 监听 `message.auto_retry_start` → 显示倒计时指示器
3. 监听 `message.auto_retry_end` → 隐藏指示器

```vue
<!-- 在 Thinking indicator 位置附近 -->
<div v-if="autoRetryState.active" class="flex items-center gap-2 px-4 py-2 bg-warning-light border border-warning rounded-sm text-sm">
  <span class="inline-block w-1.5 h-1.5 rounded-full bg-warning shrink-0 animate-pulse"></span>
  <span class="font-mono text-[11px] text-warning">
    正在重试 ({{ autoRetryState.attempt }}/{{ autoRetryState.maxAttempts }})...
    <span v-if="autoRetryState.delayMs > 0">{{ Math.ceil(autoRetryState.delayMs / 1000) }}s</span>
  </span>
  <button class="ml-auto text-xs text-muted hover:text-fg underline" @click="cancelRetry">取消</button>
</div>
```

### 4.5 ⚡ ChatPanel.vue - 排队消息可视化

**前置条件**：Phase 0 - EventAdapter 2.8（queue_update）

**改动**：
1. 新增 `queuedMessages` 状态：`{ steering: string[], followUp: string[] }`
2. 在 ChatInput 上方或右下角显示 "X 条消息排队中"

```vue
<div v-if="queuedCount > 0" class="px-4 py-1 text-[10px] text-muted bg-surface border-t border-border">
  <span>{{ queuedCount }} 条消息排队中</span>
  <button class="ml-2 underline hover:text-fg" @click="showQueuePreview">查看</button>
</div>
```

### 4.6 ⚡ ChatPanel.vue - responseModel 显示

**前置条件**：Phase 0 - EventAdapter 2.11

**改动**：在 `message.complete` 事件中提取 `responseModel`，在模型指示器中显示实际模型名。

### 4.7 ⚡ WidgetDock.vue - placement 支持和结构化数据

**前置条件**：EventAdapter 已支持 setWidget 的 widgetPlacement 字段

**改动**：
1. 新增 `placement` prop（`'aboveEditor'` / `'belowEditor'`）
2. 两个 WidgetDock 实例分别渲染在 ChatPanel 的不同位置
3. 支持 `{ type, data }` 结构化 widget 数据（延后，P2）

```vue
<!-- ChatPanel.vue 中两个 WidgetDock -->
<WidgetDock :widgets="aboveEditorWidgets" placement="aboveEditor" />
<!-- ... ChatInput ... -->
<WidgetDock :widgets="belowEditorWidgets" placement="belowEditor" />
```

### 4.8 ⚡ ToolCallCard.vue - 截断 + 图片渲染 + 自定义工具

**前置条件**：Phase 0 - EventAdapter 2.5（image content）+ 2.6（details）

**改动**：
1. **截断**：bash 输出过长时显示折叠状态，显示行数 + "展开"按钮 + "查看完整输出"链接
2. **图片**：检测 `images` 字段，渲染为 `<img>`（inline Base64 data URL）
3. **自定义工具**：非内置工具名尝试查找注册的自定义渲染器

### 4.9 ⚡ EditToolRenderer.vue - Diff 高亮

**前置条件**：EventAdapter 已透传 `details.diff`

**改动**：
1. 解析 tool result details 中的 diff 文本
2. 行颜色：added（绿）/ removed（红）/ context（默认）
3. 折叠/展开（折叠时只显示统计 "+X/-Y"）

### 4.10 ⚡ SystemNotification.vue - 特殊消息类型

**前置条件**：Phase 0 - EventAdapter 2.4（role 路由）

**改动**：
1. **Compaction Summary**：显示 tokensBefore、节省比例、summary 文本
2. **Branch Summary**：显示 fromId 和 summary 文本
3. **Skill Invocation**：解析 `<skill:name>...</skill>` 标签，渲染为 skill 调用卡片

### 4.11 ⚡ useChat.ts - 全局事件处理增强

**前置条件**：Phase 0 所有 EventAdapter 修改

**改动**：为每个新事件注册 handler：

| 事件 | Handler | 对应 Store 操作 |
|------|---------|----------------|
| `extension:setEditorText` | `onSetEditorText` | ChatStore.setPendingEditorText / ChatInput v-model |
| `message.bashExecution` | `onBashExecution` | 创建系统消息显示命令+输出+退出码 |
| `message.compactionSummary` | `onCompactionSummary` | 创建系统消息显示摘要 |
| `message.branchSummary` | `onBranchSummary` | 创建系统消息显示分支摘要 |
| `message.auto_retry_start` | `onAutoRetryStart` | ChatStore.setAutoRetryState |
| `message.auto_retry_end` | `onAutoRetryEnd` | ChatStore.setAutoRetryState |
| `message.queue_update` | `onQueueUpdate` | ChatStore.setQueueState |
| `session.renamed` | `onSessionRenamed` | SessionStore.updateSessionName |
| `session.thinkingLevelSet` | `onThinkingLevelSet` | ChatStore.setThinkingLevel |
| `extension:setTitle` | `onExtensionSetTitle` | 通过 electronAPI 设置窗口标题 |
| `message.stream_error` | `onStreamError` | 插入错误消息 |

### 4.12 ⚡ ChatStore - 新增状态字段

ChatStore 需要新增以下状态字段（均按 `sessionId` 分区）：

```typescript
interface ChatSessionState {
  // 现有...
  
  // 新增：
  pendingEditorText?: string          // extension 预填充文本
  autoRetryState?: AutoRetryState     // 自动重试状态
  queueState?: QueueState             // 排队消息
  thinkingLevel?: ThinkingLevel       // 当前 thinking level
  responseModel?: string              // 实际模型名
}

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

---

## 五、Phase 3：需改 pi / bridge extension 方案

以下 TUI 能力在 RPC 模式下**完全静默 no-op**（pi 不发出任何事件），无法通过 EventAdapter 适配。需要修改 pi 源码或由 bridge extension 自行提供替代方案。

### 5.1 🔴 需改 pi：setWorkingMessage / setWorkingVisible

**现状**：RPC 模式完全丢弃，不发出任何事件。bridge extension 无法拦截——这些是 pi 内部调用。

**出路**：修改 pi `rpc-mode.ts` 的 `createExtensionUIContext()`，让这两个方法也 emit `extension_ui_request`。

**替代方案**：xyz-agent 前端自行根据 `agent_start` → 首个 `message_update` / `tool_execution_start` 推算 working 状态。在 agent_start 到第一个 delta 之间显示 "思考中..."，不依赖 extension 自定义文案。

**建议**：使用替代方案，不依赖修改 pi。

### 5.2 🔴 需改 pi：addAutocompleteProvider

**现状**：RPC 模式完全静默 no-op。

**出路**：修改 pi RPC 模式 emit 事件；或由 bridge extension 自行提供补全数据源。

**建议**：使用 bridge extension 提供的自定义补全数据，通过 WS 事件 `plugin:autocomplete` 传递。

### 5.3 🔴 需改 pi：setToolsExpanded

**现状**：RPC 模式完全静默 no-op。

**建议**：xyz-agent 前端不做此支持。ToolCallCard 的展开/折叠由用户手动控制，extension 不需要控制。

### 5.4 🟡 bridge extension 方案：Widget 结构化数据

**现状**：setWidget 在 RPC 模式下只支持字符串数组，不支持组件工厂模式。

**出路**：bridge extension 通过 WS 通道自行发送结构化 widget 数据（如 `{ type: 'progress', value: 50, label: '处理中' }`），前端 WidgetDock 根据 type 渲染。

### 5.5 RPC no-op 渠道处理决策总表

| UI 方法 | 处理决策 | 方案 | 优先级 |
|---------|---------|------|--------|
| setWorkingMessage | ❌ 不做 | 前端自动推算 | 🟢 不影响用户体验 |
| setWorkingVisible | ❌ 不做 | 前端自动推算 | 🟢 不影响用户体验 |
| setWorkingIndicator | ❌ 不做 | CSS 动画更优 | 🟢 不影响用户体验 |
| addAutocompleteProvider | 🟡 替代方案 | bridge extension 自行提供补全数据 | 🟢 P3 延后 |
| setToolsExpanded | ❌ 不做 | 用户手动控制展开/折叠 | 🟢 不影响用户体验 |
| setEditorComponent | ❌ 不做 | 前端自带编辑器 | 🟢 GUI 不需要 |
| setHeader | ❌ 不做 | GUI 无对应场景 | 🟢 不影响 |
| setFooter | ❌ 不做 | AppStatusbar 是固定布局 | 🟢 不影响 |
| onTerminalInput | ❌ 不做 | GUI 不适用 | 🟢 不影响 |
| setHiddenThinkingLabel | ❌ 不做 | GUI 不需要 | 🟢 不影响 |
| custom() 全屏组件 | ⏸️ 延后 | 成本高，Widget+Dialogs 够用 | 🟢 P3 延后 |
| registerMessageRenderer | ❌ 不做 | 前端按 customType 自行路由 | ✅ 已有方案 |
| registerTool renderCall/renderResult | ❌ 不做 | 前端按 toolName 自行渲染 | ✅ 已有方案 |
| getAllThemes / setTheme | ❌ 不做 | 前端自有主题系统 | 🟢 不影响 |

---

## 六、附录：所有 TUI 渠道的 GUI 覆盖状态速查表

### 消息区

| TUI 渠道 | GUI 状态 | 实现文件 | 备注 |
|---------|---------|---------|------|
| UserMessage | ✅ 已有 | MessageBubble.vue | role=user |
| AssistantMessage text | ✅ 已有 | StreamingMessage.vue → MessageBubble.vue | 流式渲染 |
| ThinkingBlock | ✅ 已有 | ThinkingBlock.vue | 折叠/展开 |
| CustomMessage (customType) | 🔨 新建 | CustomMessageRenderer.vue | 按 customType 路由 |
| ToolExecution (bash) | ⚡ 增强 | BashToolRenderer.vue | 流式输出实时追加、fullOutputPath 链接 |
| ToolExecution (edit) | ⚡ 增强 | EditToolRenderer.vue | Diff 高亮 |
| ToolExecution (write) | ✅ 已有 | WriteToolRenderer.vue | — |
| ToolExecution (read) | ✅ 已有 | ReadToolRenderer.vue | 截断提示 |
| ToolExecution (默认) | ✅ 已有 | DefaultToolRenderer.vue | — |
| Compaction Summary | ⚡ 增强 | SystemNotification.vue | 新增 compaction 分支 |
| Branch Summary | ⚡ 增强 | SystemNotification.vue | 新增 branch 分支 |
| Skill Invocation | ⚡ 增强 | SystemNotification.vue | 解析 skill 标签块 |
| BashExecutionMessage | ⚡ 增强 | MessageBubble.vue | role 路由 + 新渲染 |

### Header / Widget / Editor / Working / Footer

| TUI 渠道 | GUI 状态 | 实现文件 | 备注 |
|---------|---------|---------|------|
| setHeader | ❌ 不做 | — | GUI 无对应场景 |
| setWidget (text) | ✅ 已有 | WidgetDock.vue | 纯文本 lines |
| setWidget (component) | ⏸️ 延后 | WidgetDock.vue 增强 | 需独立 WS 协议 |
| setWidget (placement) | ⚡ 增强 | WidgetDock.vue | 支持 belowEditor 位置 |
| setEditorText / pasteToEditor | ⚡ 增强 | ChatInput.vue | 预填充支持 |
| addAutocompleteProvider | ⏸️ 延后 | ChatInput.vue | 替代方案 |
| setWorkingMessage | ❌ 不做 | — | 前端自动推算 |
| setWorkingVisible | ❌ 不做 | — | 前端自动推算 |
| setStatus | ⚡ 增强 | AppStatusbar.vue | 合并 extension status |
| setFooter | ❌ 不做 | — | 固定 AppStatusbar |
| setTitle | ⏸️ 延后 | Electron 窗口 | 成本极低 |

### Dialogs / Overlays / 主题

| TUI 渠道 | GUI 状态 | 实现文件 | 备注 |
|---------|---------|---------|------|
| confirm | ✅ 已有 | ExtensionUIDialog.vue | — |
| select | ✅ 已有 | ExtensionUIDialog.vue | — |
| input | ✅ 已有 | ExtensionUIDialog.vue | — |
| editor | 🔨 新建 | EditorDialog.vue + ExtensionUIDialog 增强 | P0 |
| notify | ✅ 已有 | ToastContainer.vue | — |
| 倒计时 dialog | ⚡ 增强 | ExtensionUIDialog.vue | timeout prop |
| custom() 全屏 | ⏸️ 延后 | — | ROI 低 |
| custom({ overlay }) | ⏸️ 延后 | DrawerOverlay.vue | 已有基础 |
| setTheme / getAllThemes | ❌ 不做 | ThemeProvider.vue | 前端自有 |
| ctx.ui.theme | ❌ 不做 | CSS 变量 | 前端自有 |

### Session 级事件

| TUI 事件 | GUI 状态 | 说明 |
|---------|---------|------|
| queue_update | ⚡ 增强 | 排队消息可视化 |
| auto_retry_start/end | ⚡ 增强 | 重试指示器 |
| session_info_changed | ⚡ 增强 | 更新 UI session 名称 |
| thinking_level_changed | ⚡ 增强 | 更新状态栏 |
| compaction_start/end | ⚡ 增强 | 当前 session-service 手动发送 |

### RPC Commands（xyz-agent → pi 主动命令）

| RPC Command | GUI 状态 | 说明 |
|------------|---------|------|
| prompt / steer / follow_up | ✅ 已有 | — |
| abort | ✅ 已有 | — |
| new_session / switch_session | ✅ 已有 | — |
| get_state / get_messages | ✅ 已有 | — |
| get_session_stats | ⏸️ 延后 | Context Window 进度条 |
| get_commands | ⚡ 增强 | SlashMenu 从 pi 获取 |
| set_model / cycle_model | ✅ 已有 | — |
| set_thinking_level / cycle_thinking_level | ✅ 已有 | — |
| set_steering_mode / set_follow_up_mode | ⚡ 增强 | 需前端设置入口 |
| set_auto_compaction | ⚡ 增强 | 需前端设置入口 |
| set_auto_retry / abort_retry | ⚡ 增强 | 新命令，配合自动重试 UI |
| bash / abort_bash | ⏸️ 延后 | 终端面板 |
| fork / clone | ✅ 已有 / ⚡ 增强 | clone 新命令 |
| set_session_name | ⚡ 增强 | 已有 session.rename WS 消息 |
| get_last_assistant_text | ⚡ 增强 | "复制最后回复"功能 |
| export_html | ⏸️ 延后 | 导出分享 |
