/**
 * EventAdapter — 纯翻译器：pi subprocess RPC 事件 → PiTranslatedEvent[]。
 *
 * [R1 重构] 本文件是 infra 层，只做「翻译」，不做任何业务编排副作用：
 *   ✗ 不调 plugin hook（onBeforeToolCall/onAfterToolResult）
 *   ✗ 不做 file_changes baseline diff（snapshotGitStatus/diffSnapshots）
 *   ✗ 不回写 session 状态（context.update / thinkingLevel 缓存）
 *   ✗ 不路由 status/bridge/extension-ui 到 server
 *   ✗ 不持有可变态（statusBaseline/writeContents/currentMessageId）
 *   ✓ 只产出结构化中间事件（PiTranslatedEvent[]），交由 service 层 EventInterpreter 编排。
 *
 * pi RPC events have this structure:
 * - `message_update` with nested `assistantMessageEvent` containing `type`, `delta`, `contentIndex`
 *   - sub-types: text_start, text_delta, text_end, thinking_start, thinking_delta, thinking_end
 * - `message_start` / `message_end` with `message` containing role, content, usage, stopReason
 * - `agent_start` / `turn_start` / `turn_end` / `agent_end` for lifecycle
 * - `extension_ui_request` for tool approvals etc.
 *
 * Each session gets its own adapter instance. translate() is stateless（一个 pi 事件
 * 产出一组中间事件），可变态由 EventInterpreter 持有。
 */
import type { ServerMessage, ServerMessageType, ExtensionInteractMethod } from '@xyz-agent/shared'
import { EXTENSION_EVENTS } from '@xyz-agent/shared'
import { GUI_WIDGET_MARKER, ASK_USER_MARKER, isGuiComponent } from '@xyz-agent/extension-protocol'
import type { PiEventListener } from '../../services/ports/pi-engine.js'
import type { PiTranslatedEvent } from '../../services/session/types.js'
import { randomUUID } from 'node:crypto'
import { stripAnsi, normalizePiToolResult } from './normalize-tool-result.js'
import type {
  PiEvent,
  PiMessageStartEvent,
  PiMessageUpdateEvent,
  PiAgentEndEvent,
  PiToolExecutionStartEvent,
  PiToolExecutionUpdateEvent,
  PiToolExecutionEndEvent,
  PiTurnEndEvent,
  PiExtensionUiRequestEvent,
  PiExtensionErrorEvent,
  PiAutoRetryStartEvent,
  PiAutoRetryEndEvent,
  PiQueueUpdateEvent,
  PiSessionInfoChangedEvent,
  PiThinkingLevelChangedEvent,
  PiStatusEvent,
  PiErrorEvent,
} from './pi-protocol.js'

// ── Sub-handler types ──────────────────────────────────────────────
//
// [ADR-0033] translate() 入参用 pi-protocol.ts 的 PiEvent 联合类型（真契约）。
// 每个 handler 入参窄化为对应的 Pi*Event interface（如 handleToolExecutionEnd →
// PiToolExecutionEndEvent）。pi 升级时若新增事件类型，PiEvent 联合的 exhaustive
// 检查会提示补 handler 或登记到 NULL_EVENTS。
// 对未知事件类型（联合外）translate() 走 default warn + return []（见文件末尾）。

const STOP_REASON_MAP: Record<string, string> = {
  stop: 'end_turn',
  end_turn: 'end_turn',
  length: 'max_tokens',
  max_tokens: 'max_tokens',
  toolUse: 'tool_use',
  tool_use: 'tool_use',
  error: 'error',
  aborted: 'aborted',
  cancelled: 'aborted',
  content_filter: 'content_filter',
}

/**
 * Interactive extension UI dialog methods that produce extension.ui_request WS events.
 * Must stay in sync with ExtensionInteractMethod SSOT (shared/extension.ts).
 *
 * notify 不在此列——它是 fire-and-forget（pi rpc-mode.ts notify 发后不等回复），
 * 走独立 extension.notify WS 帧 + 前端 toast 渲染（非阻塞）。
 * setStatus/setWidget/set_editor_text/bridge:* 也不在此列——它们走独立分支，不产 ui_request 帧。
 *
 * 用 `as const satisfies readonly ExtensionInteractMethod[]` 实现编译期穷举检查：
 * ExtensionInteractMethod 扩展新方法时，若此数组遗漏，tsc 报错（而非静默 noop 丢弃）。
 */
const INTERACTIVE_UI_METHODS = new Set(
  ['confirm', 'select', 'input', 'editor'] as const satisfies readonly ExtensionInteractMethod[]
)

/** Extension method constant for the editor UI */
const METHOD_EDITOR = 'editor' as const

/** 取工具参数 path（pi 契约权威参数名；file_path 作防御性 fallback，ADR-0024 D2） */
function extractPath(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined
  const p = args.path
  if (typeof p === 'string' && p) return p
  const fp = args.file_path
  return typeof fp === 'string' && fp ? fp : undefined
}

// ── Sub-handlers（纯函数：PiEvent → PiTranslatedEvent[]，无副作用）────────

/** message_update — streaming text/thinking deltas and stream errors */
function handleMessageUpdate(event: PiMessageUpdateEvent, sid: string): PiTranslatedEvent[] {
  const sub = event.assistantMessageEvent as
    { type: string; delta?: string; content?: string; contentIndex?: number } | undefined
  if (!sub) return [{ kind: 'noop' }]

  switch (sub.type) {
    case 'text_delta':
      return [{ kind: 'message', message: { type: 'message.text_delta', payload: { sessionId: sid, delta: sub.delta ?? '' } } }]
    case 'thinking_start':
      return [{ kind: 'message', message: { type: 'message.thinking_start', payload: { sessionId: sid } } }]
    case 'thinking_delta':
      return [{ kind: 'message', message: { type: 'message.thinking_delta', payload: { sessionId: sid, delta: sub.delta ?? '' } } }]
    case 'thinking_end':
      return [{ kind: 'message', message: { type: 'message.thinking_end', payload: { sessionId: sid } } }]
    case 'toolcall_start': case 'toolcall_delta': case 'toolcall_end':
    case 'text_start': case 'text_end':
      return [{ kind: 'noop' }]
    // FR-5: streaming error — surface as message.stream_error
    // payload 形状与 protocol 契约对齐：content（人类可读）+ kind（分类，可选）
    case 'error':
      return [{ kind: 'message', message: { type: 'message.stream_error', payload: { sessionId: sid, content: sub.content ?? '', kind: 'error' } } }]
    default:
      console.warn('[EventAdapter] Unhandled message_update sub-type:', sub.type)
      return [{ kind: 'noop' }]
  }
}

/**
 * tool_execution_start — 产出 tool-call-start 中间事件（携带原始 input）。
 * EventInterpreter 据此跑 onBeforeToolCall hook（可阻断 / 改写 input）后产出 tool_call_start WS 帧。
 */
function handleToolExecutionStart(event: PiToolExecutionStartEvent, _sid: string): PiTranslatedEvent[] {
  const toolName = event.toolName
  // pi 用 args 是规范字段名（pi 从不发 input，ADR-0033）。
  const input = event.args
  return [{
    kind: 'tool-call-start',
    toolCallId: event.toolCallId,
    toolName,
    input,
  }]
}

/**
 * tool_execution_end — 产出 tool-call-end 中间事件（携带原始 output/details/images）。
 * EventInterpreter 据此跑 onAfterToolResult hook（改写 output）+ 触发 file_changes baseline diff。
 */
function handleToolExecutionEnd(event: PiToolExecutionEndEvent, _sid: string): PiTranslatedEvent[] {
  // pi 用 result 是规范字段名（pi 从不发 output，ADR-0033）。
  // 三态判定 + stripAnsi + images/details 提取统一委托 normalizePiToolResult（W1）。
  const raw = event.result
  const { output, outputRaw, details, images } = normalizePiToolResult(raw)

  const toolCallId = event.toolCallId
  const toolName = event.toolName
  const isError = event.isError

  // write 工具写入的 content（供 EventInterpreter 累积，untracked 行数回退用）。
  // [已知限制] pi tool_execution_end 从不发 args（pi types.ts:430 无此字段）——write 工具的
  // content 在 tool_execution_start 事件里（types.ts:428 args: any）。当前 writeContent 恒为
  // undefined（args 来源缺失）。提取逻辑应迁移到 handleToolExecutionStart 路径（tool_execution_start
  // 发 args），但那涉及 PiTranslatedEvent tool-call-start 中间事件结构变更 + EventInterpreter
  // 改造，属另一个改动范围，此处保留逻辑块 + 显式逃生，待后续优化迁移。
  let writeContent: { filePath: string; content: string } | undefined
  if (!isError && toolName === 'write') {
    const args = (event as unknown as { args?: Record<string, unknown> }).args
    const filePath = extractPath(args)
    if (filePath && typeof args?.content === 'string') {
      writeContent = { filePath, content: args.content }
    }
  }

  return [{
    kind: 'tool-call-end',
    toolCallId,
    output,
    details,
    images,
    toolName,
    isError,
    writeContent,
    outputRaw,
  }]
}

/** agent_end — extract stop reason, usage, responseModel, diagnostics, errorMessage, content */
function handleAgentEnd(event: PiAgentEndEvent, sid: string): PiTranslatedEvent[] {
  // W1：messages 为空数组 / undefined 时降级为 turn-end{stopReason:'error'}，不抛 TypeError。
  // 异常会从 translate() 抛出 → 经 EventAdapter.attach 的整批 try-catch 被吞 →
  // agent_end 整批事件丢失 → isGenerating 永不复位 + message.complete 不送达。
  // messages 可能在 pi 内部异常 / 会话尚未产出任何 assistant 消息时为空。
  const messages = event.messages
  if (!messages || messages.length === 0) {
    console.warn(`[EventAdapter] agent_end with empty messages (degraded to turn-end{error}) sid=${sid}`)
    return [{
      kind: 'turn-end',
      message: { type: 'message.complete', payload: { sessionId: sid, stopReason: 'error' } },
      stopReason: 'error',
    }]
  }
  // pi 事件是强类型契约（ADR-0033）。agent_end.messages 的 usage/stopReason 由 PiAgentEndMessage
  // 覆盖（PiUsage 已镜像 pi 字段名 input/output/cacheRead/cacheWrite）。但 pi 在此还附带
  // responseModel / diagnostics / errorMessage 等运行时字段（超出 PiAgentEndMessage 声明范围，
  // pi AgentMessage 实际形态比声明的 union 更宽）——这些用 as 提取。
  const lastMsg = messages[messages.length - 1]
  const rawReason = lastMsg.stopReason ?? 'stop'
  const usage = lastMsg.usage
  const lastMsgExtra = lastMsg as unknown as {
    responseModel?: string
    diagnostics?: Record<string, unknown>
    errorMessage?: string
    content?: unknown
  }
  const responseModel = lastMsgExtra.responseModel
  const diagnostics = lastMsgExtra.diagnostics
  const errorMessage = (rawReason === 'error' || rawReason === 'tool_use') ? lastMsgExtra.errorMessage : undefined
  // 提取完整文本 content：pi agent_end 携带最终 AssistantMessage，content[] 含 streaming 全部文本。
  // 透出给前端用权威源覆盖客户端累积值，消除末尾 delta 的 async 渲染竞态（如 ** 未闭合不渲染加粗）。abort 路径为空不覆盖。
  // content 在 PiAgentEndMessage 中是 unknown，此处按 pi 运行时形态（content block 数组）提取。
  const finalContent = (Array.isArray(lastMsgExtra.content) ? lastMsgExtra.content : [] as unknown[])
    .filter((c): c is { type: string; text?: string } => typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'text')
    .map((c) => c.text ?? '')
    .join('')
  const message: ServerMessage = {
    type: 'message.complete',
    payload: {
      sessionId: sid,
      stopReason: STOP_REASON_MAP[rawReason] ?? rawReason,
      usage: usage
        ? { inputTokens: usage.input ?? 0, outputTokens: usage.output ?? 0, totalTokens: usage.totalTokens ?? 0 }
        : undefined,
      responseModel,
      diagnostics,
      errorMessage,
      ...(finalContent ? { content: finalContent } : {}),
    },
  }

  return [{
    kind: 'turn-end',
    message,
    // context 占用 = totalTokens（input+output+cacheRead+cacheWrite），与 pi calculateContextTokens 同源。
    // 不能用 usage.input——那是单 turn 增量 input（不含 cacheRead 的 context 大头），值很小。
    inputTokens: usage?.totalTokens,
    totalTokens: usage?.totalTokens ?? 0,
    stopReason: STOP_REASON_MAP[rawReason] ?? rawReason,
    usage,
  }]
}

/**
 * turn_end — 单个 turn 结束时提取 usage，产出 turn-usage（只回写用量，不转发 message.complete）。
 *
 * pi 0.80.3 事件模型：1 个 agent 循环 = N 个 turn，每个 turn_end.message.usage 含本 turn 用量。
 * 与 handleAgentEnd（整个循环结束）的区别：本 handler 不产 message/stopReason/file_changes，
 * 避免每 turn 触发前端 message.complete → setStreaming(false) 闪烁。
 * totalTokens 缺失时返回空（纯工具结果 turn 可能无 usage）。
 */
function handleTurnEndPi(event: PiTurnEndEvent, sid: string): PiTranslatedEvent[] {
  // pi turn_end 事件把 message 放在顶层 message 字段（ADR-0033 契约，pi 从不发 payload）。
  const message = event.message
  const usage = message?.usage
  if (!usage?.totalTokens) return []
  return [{
    kind: 'turn-usage',
    sessionId: sid,
    inputTokens: usage.totalTokens,
    totalTokens: usage.totalTokens,
  }]
}

/** extension_ui_request — route by method (setStatus, setWidget, editor, etc.) */
function handleExtensionUIRequest(event: PiExtensionUiRequestEvent, sid: string): PiTranslatedEvent[] {
  const method = event.method as string

  // setStatus → status-set（interpreter 路由 server）+ status-broadcast（WS 帧）
  // 审计项 B（协议 spec §8.1）：保留 text（stripAnsi 后纯文本，向后兼容）+ textRaw（原始 ANSI 文本），
  // 前端可选 textRaw 做 ANSI 着色渲染，text 作纯文本兜底。
  if (method === 'setStatus') {
    const key = String(event.statusKey ?? '')
    const raw = String(event.statusText ?? '')
    const text = stripAnsi(raw)
    return [
      { kind: 'status-set', sessionId: sid, key, text, textRaw: raw },
      {
        kind: 'status-broadcast',
        message: {
          type: EXTENSION_EVENTS.STATUS as ServerMessageType,
          payload: { sessionId: sid, statusKey: key, text, textRaw: raw },
        },
      },
    ]
  }

  // setWidget → WS event（检测 subagent streaming / GUI 协议 marker / 清除语义）
  if (method === 'setWidget') {
    const widgetKey = String(event.widgetKey ?? '')
    const rawLines = Array.isArray(event.widgetLines) ? event.widgetLines as unknown[] : []

    // subagent streaming（路径 A-1）：widgetKey 匹配 subagent-stream-<recordId> 前缀。
    // pi 扩展层合并 text_delta 后用此 key 转发累积全文。短路——不走后续 widget 逻辑。
    const streamMatch = widgetKey.match(/^subagent-stream-(.+)$/)
    if (streamMatch) {
      const recordId = streamMatch[1]
      const lines = rawLines.length > 0 ? rawLines.map((l) => String(l)) : undefined
      return [{ kind: 'subagent-stream', sessionId: sid, recordId, lines }]
    }

    // 清除语义：widgetLines 缺失或空数组 → extension 清除此 widget（guiSetWidget(key, undefined)）。
    // 发 extension:widgetGui 带 gui:null，前端据此删 guiWidgetsByTab 条目 + 清 lines。
    // 不能只发 extension:widget（lines:[]）——前端 widget handler 不触碰 guiWidgetsByTab，
    // 会导致结构化 widget 永驻。
    if (rawLines.length === 0) {
      return [{
        kind: 'message',
        message: {
          type: EXTENSION_EVENTS.WIDGET_GUI as ServerMessageType,
          payload: { sessionId: sid, widgetKey, gui: null },
        },
      }]
    }

    // 检测 GUI 协议 marker：单行以 NUL marker 开头 → 结构化 widget
    if (rawLines.length === 1 && typeof rawLines[0] === 'string' && (rawLines[0] as string).startsWith(GUI_WIDGET_MARKER)) {
      try {
        const json = (rawLines[0] as string).slice(GUI_WIDGET_MARKER.length)
        const gui: unknown = JSON.parse(json)
        // 形状校验：防止异常结构进入渲染层（非合法 GuiComponent → 降级纯文本 widget）
        if (isGuiComponent(gui)) {
          return [{
            kind: 'message',
            message: {
              type: EXTENSION_EVENTS.WIDGET_GUI as ServerMessageType,
              payload: { sessionId: sid, widgetKey, gui },
            },
          }]
        }
        console.warn('[EventAdapter] widgetGui marker decoded but not a valid GuiComponent, falling back to text widget', gui)
      // eslint-disable-next-line taste/no-silent-catch -- console.warn 经 logger.patchConsole tee 到 runtime 日志文件（架构约定 #4），与 logger.ts 内部 catch 容错模式一致
      } catch (e) {
        // marker 检测命中但 JSON 解析失败 → 降级为纯文本 widget
        console.warn('[EventAdapter] widgetGui marker JSON parse failed, falling back to text widget', e)
      }
    }

    // 原有行为：stripAnsi + string[]
    // marker 命中但校验/解析失败的行包含 NUL + marker 前缀（\x00XYZ_GUI_WIDGET:...），
    // 直接展示会给用户看乱码——剥离 marker 前缀后显示剩余 JSON 文本（或空行）。
    const widgetPayload = {
      sessionId: sid,
      widgetKey,
      lines: rawLines.map(l => {
        const s = String(l)
        const stripped = s.startsWith(GUI_WIDGET_MARKER) ? s.slice(GUI_WIDGET_MARKER.length) : s
        return stripAnsi(stripped)
      }),
    }
    return [{ kind: 'message', message: { type: EXTENSION_EVENTS.WIDGET as ServerMessageType, payload: widgetPayload } }]
  }

  // setEditorText → extension:setEditorText
  if (method === 'set_editor_text') {
    return [{ kind: 'message', message: { type: 'extension:setEditorText', payload: { sessionId: sid, text: String(event.text ?? '') } } }]
  }

  // notify → extension.notify（fire-and-forget，pi 不等回复）
  // pi rpc-mode.ts notify 发出 extension_ui_request{method:'notify'} 后不注册 pending、不等 response。
  // 不走 INTERACTIVE_UI_METHODS（不产 extension-ui kind → 不注册 timeout → 不弹模态对话框）。
  // 前端用 toast 渲染（非阻塞）。
  if (method === 'notify') {
    const rawType = String(event.notifyType ?? 'info')
    const level: 'info' | 'warn' | 'error' =
      rawType === 'error' ? 'error' : rawType === 'warning' ? 'warn' : 'info'
    return [{
      kind: 'message',
      message: {
        type: EXTENSION_EVENTS.NOTIFY as ServerMessageType,
        payload: {
          sessionId: sid,
          message: String(event.message ?? ''),
          level,
        },
      },
    }]
  }

  // bridge:* → bridge-ui（interpreter 路由 server）
  if (method?.startsWith('bridge:')) {
    const requestId = String(event.id ?? '')
    const data = event.data as Record<string, unknown> ?? {}
    return [{ kind: 'bridge-ui', requestId, sessionId: sid, method, data }]
  }

  // Interactive dialog methods: confirm, select, input, editor (notify 已在上方独立分支处理)
  if (method && INTERACTIVE_UI_METHODS.has(method as ExtensionInteractMethod)) {
    const dialogMethod = method as ExtensionInteractMethod
    const requestId = String(event.id ?? '')

    // ask-user 富交互请求检测：select title 为 ASK_USER_MARKER → options[0] 是 JSON payload
    // （askUserInteract helper 序列化的 { questions, allowCancel }）。
    // 检测成功后透传 questions 等字段，前端路由到 AskUserOverlay；检测失败（非合法 JSON）
    // 降级为普通 select（下方分支）。
    if (method === 'select' && event.title === ASK_USER_MARKER) {
      const rawOptions = Array.isArray(event.options) ? event.options as unknown[] : []
      let askUserData: { questions?: unknown; allowCancel?: boolean } | undefined
      try {
        askUserData = rawOptions.length > 0 ? JSON.parse(String(rawOptions[0])) : undefined
      // eslint-disable-next-line taste/no-silent-catch -- console.warn 经 logger.patchConsole tee 到 runtime 日志文件（架构约定 #4），降级为普通 select 不中断
      } catch {
        // options[0] 不是合法 JSON → 降级为普通 select（下方统一 return）
      }

      if (Array.isArray(askUserData?.questions) && askUserData.questions.length > 0) {
        return [
          // ★ extension-ui kind 事件：timeout-manager 据此注册 5min 超时。
          // 漏掉这个会导致用户不响应时 pi select Promise 永挂（与普通 select 分支一致）。
          { kind: 'extension-ui', requestId, sessionId: sid, method: dialogMethod },
          {
            kind: 'message',
            message: {
              type: 'extension.ui_request' as ServerMessageType,
              payload: {
                sessionId: sid,
                requestId,
                method: 'select',              // 仍是 select（复用回传通道）
                askUser: true,                 // 标记 ask-user 富交互，前端据此路由到 AskUserOverlay
                askUserQuestions: askUserData.questions,
                allowCancel: askUserData.allowCancel ?? true,
              },
            },
          },
        ]
      }
    }

    // 普通 select / confirm / input / editor
    // [HISTORICAL] options 透传修复：pi select 严格传 string[]（types.ts select 签名 +
    // rpc-mode.js 原样透传），旧代码把 rawOptions 断言为 Array<{label,value}> 后 .map(o=>o.label)
    // 对 string 元素调 .label 产出 undefined[]——普通 select 在前端是坏的。改为 .map(String) 透传。
    const rawOptions = Array.isArray(event.options) ? event.options as unknown[] : undefined
    return [
      { kind: 'extension-ui', requestId, sessionId: sid, method: dialogMethod },
      {
        kind: 'message',
        message: {
          type: 'extension.ui_request',
          payload: {
            sessionId: sid,
            requestId,
            method,
            title: event.title,
            message: event.message,
            options: rawOptions ? rawOptions.map(String) : undefined,
            default: event.default as string | undefined,
            level: event.level as 'info' | 'warn' | 'error' | undefined,
            prefill: method === METHOD_EDITOR ? (event.prefill as string | undefined) : undefined,
          },
        },
      },
    ]
  }

  return [{ kind: 'noop' }]
}

/** message_start — role-based routing for non-assistant messages */
function handleMessageStart(event: PiMessageStartEvent, sid: string): PiTranslatedEvent[] {
  // pi 事件是强类型契约（ADR-0033），但 message_start.message 含 pi 声明之外的运行时字段
  // （summary / tokensBefore / fromId / customType / details / display），且 assistant turn 开始时
  // message 缺省。此处局部放宽为 Record 提取这些超范围字段。
  const msg = event.message as unknown as Record<string, unknown> | undefined
  if (!msg) {
    // assistant turn 开始（无 role）。生成 messageId 供 file_changes 挂载，并跟踪到 interpreter 态。
    const messageId = `a-${randomUUID()}`
    return [
      { kind: 'turn-start', messageId },
      { kind: 'message', message: { type: 'message.message_start', payload: { sessionId: sid, messageId } } },
    ]
  }

  const role = msg.role as string | undefined

  // [HISTORICAL] user role 的 message_start 必须忽略：pi 0.80.3 agent-loop 在每个 turn
  // 末尾 emit message_start{role:'user'} + message_end（见 agent-loop.ts:112-113）。
  // 若不过滤，前端会为 user prompt 再建一个空气泡（渲染撕裂、findLastAssistantIndex 错位）。
  // fork 0.75.5 不发此事件；切 upstream 0.80.3（ac83b578）后出现。与 toolResult 同属「内部记账」语义。
  if (role === 'user') return [{ kind: 'noop' }]

  // toolResult 是 pi agent-core 工具执行完毕的内部记账（agent-loop.js emitToolResultMessage：
  // executeToolCalls 后 emit message_start/end{role:'toolResult'}）。
  // 前端已通过 tool_execution_end 拿到 output，toolResult message_start 对前端是噪声——
  // 若转发，chat-chunk-processor 会建空 assistant message，干扰 findLastAssistantIndex
  // 导致后续 tool_call_end 匹配错位（toolCall 永久卡 running）。
  // 与历史路径 message-converter.ts:36（toolResult 合并进父 assistant，非独立消息）语义一致。
  if (role === 'toolResult') return [{ kind: 'noop' }]

  if (role === 'compactionSummary') {
    return [{
      kind: 'message',
      message: {
        type: 'message.compactionSummary',
        payload: { sessionId: sid, summary: msg.summary as string | undefined, tokensBefore: msg.tokensBefore as number | undefined, timestamp: msg.timestamp as number | undefined },
      },
    }]
  }
  if (role === 'branchSummary') {
    return [{
      kind: 'message',
      message: {
        type: 'message.branchSummary',
        payload: { sessionId: sid, summary: msg.summary as string | undefined, fromId: msg.fromId as string | undefined, timestamp: msg.timestamp as number | undefined },
      },
    }]
  }
  // custom message from pi.sendMessage（扩展注入的结构化通知，如 subagent-bg-notify）。
  // 用独立 type 'message.customStart'，与 assistant turn 的 message_start 区分——
  // 前端 message_start handler 默认建 role:'assistant' 气泡，custom 不应走那条路径。
  if (msg.customType) {
    return [{
      kind: 'message',
      message: {
        type: 'message.customStart',
        payload: {
          sessionId: sid,
          customType: msg.customType as string,
          content: msg.content as string | undefined,
          details: msg.details as Record<string, unknown> | undefined,
          display: msg.display as boolean | undefined,
        },
      },
    }]
  }
  // 兜底：assistant turn（有 msg 但无 role）—— 同样生成 messageId 供 file_changes 挂载 + 采 baseline。
  const fallbackId = `a-${randomUUID()}`
  return [
    { kind: 'turn-start', messageId: fallbackId },
    { kind: 'message', message: { type: 'message.message_start', payload: { sessionId: sid, messageId: fallbackId } } },
  ]
}

/** tool_execution_update — forward detail (partialResult is unknown: string or object, extract details if present) */
function handleToolExecutionUpdate(event: PiToolExecutionUpdateEvent, sid: string): PiTranslatedEvent[] {
  // partialResult 是 unknown（pi 声明 any，运行时形态不定）。按 typeof 分流：
  //   object → 提取 .details（含 __gui__），无 details 时 fallback 用整个对象（兼容 subagent 扁平 progress）。
  //   string → 原样作 detail。
  const partialResult = event.partialResult
  const detail: string | Record<string, unknown> | undefined =
    partialResult != null && typeof partialResult === 'object'
      ? ((partialResult as Record<string, unknown>).details as Record<string, unknown> | undefined)
        ?? (partialResult as Record<string, unknown>)
      : (partialResult as string | undefined)
  return [{
    kind: 'message',
    message: {
      type: 'message.tool_call_update',
      payload: { sessionId: sid, toolCallId: event.toolCallId, detail },
    },
  }]
}

/** extension_error — field rename extensionPath → extensionName + errorEvent */
function handleExtensionError(event: PiExtensionErrorEvent, sid: string): PiTranslatedEvent[] {
  return [{
    kind: 'message',
    message: {
      type: 'extension.error',
      payload: {
        sessionId: sid,
        extensionName: event.extensionPath,
        error: event.error,
        errorEvent: event.event,
      },
    },
  }]
}

/** auto_retry_start → message.auto_retry_start */
function handleAutoRetryStart(event: PiAutoRetryStartEvent, sid: string): PiTranslatedEvent[] {
  return [{
    kind: 'message',
    message: {
      type: 'message.auto_retry_start',
      payload: {
        sessionId: sid,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorMessage: event.errorMessage,
      },
    },
  }]
}

/** auto_retry_end → message.auto_retry_end */
function handleAutoRetryEnd(event: PiAutoRetryEndEvent, sid: string): PiTranslatedEvent[] {
  return [{
    kind: 'message',
    message: {
      type: 'message.auto_retry_end',
      payload: {
        sessionId: sid,
        success: event.success,
        attempt: event.attempt,
        finalError: event.finalError,
      },
    },
  }]
}

/** queue_update → message.queue_update */
function handleQueueUpdate(event: PiQueueUpdateEvent, sid: string): PiTranslatedEvent[] {
  return [{
    kind: 'message',
    message: {
      type: 'message.queue_update',
      payload: {
        sessionId: sid,
        steering: [...event.steering],
        followUp: [...event.followUp],
      },
    },
  }]
}

/** session_info_changed → session.renamed */
function handleSessionInfoChanged(event: PiSessionInfoChangedEvent, sid: string): PiTranslatedEvent[] {
  return [{
    kind: 'message',
    message: {
      type: 'session.renamed',
      payload: { sessionId: sid, name: event.name },
    },
  }]
}

/** thinking_level_changed → session.thinkingLevelSet + 回写 session 缓存（interpreter 处理） */
function handleThinkingLevelChanged(event: PiThinkingLevelChangedEvent, sid: string): PiTranslatedEvent[] {
  const level = event.level
  return [
    // 回写 session.thinkingLevel 缓存（interpreter 调 sessionService）
    { kind: 'thinking-level', level },
    { kind: 'message', message: { type: 'session.thinkingLevelSet', payload: { sessionId: sid, level } } },
  ]
}

/** status → message.status passthrough */
function handleStatus(event: PiStatusEvent, sid: string): PiTranslatedEvent[] {
  return [{
    kind: 'message',
    message: {
      type: 'message.status',
      payload: { sessionId: sid, status: event.status, detail: event.detail },
    },
  }]
}

/** error → message.error passthrough */
function handleError(event: PiErrorEvent, sid: string): PiTranslatedEvent[] {
  return [{
    kind: 'message',
    message: {
      type: 'message.error',
      payload: { sessionId: sid, message: event.message },
    },
  }]
}

// ── Null-event types (lifecycle events not forwarded to frontend) ──
// 注意：turn_end 不在此列——它经 handleTurnEndPi 提取 usage 触发 context.update（见 DISPATCHER）。
// agent_settled 是 pi 0.80.3 稳态事件（无待处理工具/消息），xyz-agent 不消费——显式登记忽略。
const NULL_EVENTS = new Set([
  'agent_start', 'turn_start', 'message_end',
  'extension_config', 'extension_ui_response', 'response',
  'compaction_start', 'compaction_end', 'agent_settled',
])

// ── Dispatcher map ─────────────────────────────────────────────────
// handler 入参是窄类型（PiMessageUpdateEvent 等），DISPATCHER value 是联合入参签名。
// TS 逆变：窄入参 handler 不能直接赋给联合入参函数类型，注册处用 as 断言（运行时 event
// 已由 translate 按 type 分派，handler 只会收到匹配类型的 event）。
type Handler = (event: PiEvent, sid: string) => PiTranslatedEvent[]
const DISPATCHER = new Map<string, Handler>()
;(function registerHandlers() {
  DISPATCHER.set('message_update', handleMessageUpdate as Handler)
  DISPATCHER.set('tool_execution_start', handleToolExecutionStart as Handler)
  DISPATCHER.set('tool_execution_end', handleToolExecutionEnd as Handler)
  DISPATCHER.set('agent_end', handleAgentEnd as Handler)
  DISPATCHER.set('turn_end', handleTurnEndPi as Handler)
  DISPATCHER.set('extension_ui_request', handleExtensionUIRequest as Handler)
  DISPATCHER.set('message_start', handleMessageStart as Handler)
  DISPATCHER.set('tool_execution_update', handleToolExecutionUpdate as Handler)
  DISPATCHER.set('extension_error', handleExtensionError as Handler)
  DISPATCHER.set('auto_retry_start', handleAutoRetryStart as Handler)
  DISPATCHER.set('auto_retry_end', handleAutoRetryEnd as Handler)
  DISPATCHER.set('queue_update', handleQueueUpdate as Handler)
  DISPATCHER.set('session_info_changed', handleSessionInfoChanged as Handler)
  DISPATCHER.set('thinking_level_changed', handleThinkingLevelChanged as Handler)
  // Simple passthrough handlers
  DISPATCHER.set('status', handleStatus as Handler)
  DISPATCHER.set('error', handleError as Handler)
})()

/**
 * 诊断日志开关：`XYZ_DEBUG_PI_EVENTS=1` 时打印每个 pi 原始事件。
 *
 * 用途：定位「pi 卡死/坏 session」类问题（handoff 2026-07-04 P1）。坏 session 的特征
 * 是 JSONL 只有 session + session_info 两行、零 message——pi 接收了 prompt 创建了
 * session 但 LLM 调用从未成功产出 assistant 回复。开启此开关可观察坏 session 产生时
 * pi 到底发了什么事件（或什么都没发），从而区分：
 *   - 情况 A：pi 子进程静默卡死（无任何事件）→ 需 runtime 加 watchdog
 *   - 情况 B：pi 发了异常事件流（被 adapter 误吞/误译）→ adapter 逻辑修复
 *
 * 默认关闭，生产无噪声。复现步骤：dev 模式启动前 `export XYZ_DEBUG_PI_EVENTS=1`，
 * 复现坏 session 后查 runtime stdout 中该 sessionId 的事件序列。
 */
const DEBUG_PI_EVENTS = process.env.XYZ_DEBUG_PI_EVENTS === '1'

/**
 * 纯翻译：把单个 pi 事件翻译为 0~N 个中间事件。
 *
 * 无副作用、无可变态、不 import services 域类型。组合根负责把 translate 的结果
 * 喂给 EventInterpreter 做业务编排。
 */
export function translate(event: PiEvent, sessionId: string): PiTranslatedEvent[] {
  const eventType = event.type as string

  if (DEBUG_PI_EVENTS) {
    // 抓 pi 原始事件全貌：type + sessionId + 完整 JSON。安全起见不截断（复现场景事件量可控）。
    // JSON.stringify 对含循环引用的 pi 事件会 throw，降级打印对象本身（诊断目的已达成）。
    let serialized: string
    try {
      serialized = JSON.stringify(event)
    } catch {
      serialized = '(JSON.stringify failed)'
    }
    console.log(`[PiEvent:raw] type=${eventType} sid=${sessionId} ${serialized}`, serialized === '(JSON.stringify failed)' ? event : '')
  }

  // Lifecycle events that produce no output
  if (NULL_EVENTS.has(eventType)) return []

  // agent_start — 仅产 hook 事件（interpreter 触发 onPiEvent/agent_start hook）
  if (eventType === 'agent_start') {
    return [{ kind: 'hook', eventType: 'agent_start', data: {} }]
  }

  // Dispatch to registered handler
  const handler = DISPATCHER.get(eventType)
  if (handler) return handler(event, sessionId)

  console.warn('[EventAdapter] Unhandled pi event type:', eventType)
  return []
}

/**
 * 记录 interpret 隔离失败：单批翻译事件的编排（hook/diff/WS 转发）抛错时调用。
 *
 * 设计决策——为何此处只记录而不 re-throw / 不向用户广播：
 * - 不 re-throw：listener 跑在 pi 事件订阅回调里，re-throw 会让后续事件
 *   （含 agent_end / 最终消息）无法投递，单条坏事件炸掉整条事件流。
 * - 不在此广播 error 事件给用户：EventAdapter 是 infra 纯翻译器，按设计不持有
 *   WS send 句柄（副作用收敛在 service 层 EventInterpreter）。用户可感知的错误
 *   反馈应由 interpreter 在其自身 try 边界内负责，而非本层。
 * 故此处仅做诊断日志 + 隔离（订阅保持存活，后续事件照常处理）。
 */
function logInterpretFailure(sessionId: string, eventCount: number, err: unknown): void {
  console.error(
    `[EventAdapter] interpret error (isolated; stream continues) sid=${sessionId} events=${eventCount}:`,
    err,
  )
}

// ── EventAdapter class ─────────────────────────────────────────────

export type WsSender = (msg: ServerMessage) => void

/**
 * 绑定一个 pi session 的事件适配器：订阅事件 → 翻译 → 经 interpreter 回调消费。
 *
 * 纯订阅器：不持有业务态（statusBaseline/writeContents/currentMessageId 全部移到 interpreter），
 * 不直接 send —— 把翻译结果交给注入的 interpreter 回调（interpreter 决定副作用：转发/hook/diff/回写）。
 */
export class EventAdapter {
  private unsub: (() => void) | null = null

  constructor(
    private sessionId: string,
    private interpret: (events: PiTranslatedEvent[]) => void,
  ) {}

  /** Start listening to events from an RpcClient. */
  attach(client: { onEvent: (listener: PiEventListener) => (() => void) }): void {
    this.unsub = client.onEvent((event) => {
      // PiEventListener 的 event 是 unknown（pi 动态 JSON），断言为 PiEvent 联合翻译。
      const events = translate(event as unknown as PiEvent, this.sessionId)
      if (events.length === 0) return
      // interpret 同步执行（message/status WS 帧即时送出）；
      // 仅 tool-call-* 的 hook 改写异步（handler 内部 await），不阻塞本回调。
      try {
        this.interpret(events)
      } catch (err: unknown) {
        // 单批事件编排失败被隔离——订阅保持存活，后续事件（含 agent_end）照常投递。
        logInterpretFailure(this.sessionId, events.length, err)
      }
    })
  }

  /** Stop listening. */
  detach(): void {
    if (this.unsub) {
      this.unsub()
      this.unsub = null
    }
  }
}
