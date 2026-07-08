/**
 * code-skeleton: stores/chat-message-effects.ts —— handler 改造 + sealed guard（#3）
 *
 * 对应 packages/renderer/src/stores/chat-message-effects.ts 改动：
 * - MessageEffectContext 注入项 setStreaming → finalizeSession + clearPendingSend
 * - message.message_start 加 clearPendingSend(sid)
 * - message.complete/error/stream_error handler 改调 finalizeSession
 * - delta 类 handler 入口加 sealed guard（D-010）
 *
 * 接线层级：
 * - MessageEffectContext: 跨模块 port（chat.ts 构造 ctx 注入；effects 不 import chat.ts，去环 seam）
 * - 终态 handler: 模块内直调（ctx.finalizeSession）
 * - delta handler sealed guard: 模块内直调（isLastAssistantStreaming helper）
 *
 * 骨架密度（Level 1）：
 * - 终态 handler 真接线 ctx.finalizeSession（reason 推导可见数据流）
 * - delta handler 真接线 isLastAssistantStreaming guard
 * - 实体创建/append 为叶子（throw）
 */
import type {
  ChangeSetStatus,
  FileChange,
  Message,
  ServerMessage,
  ServerMessageType,
  SteerFollowUpMode,
} from '@xyz-agent/shared'
import type { FinalizeReason, QueueState, RetryState } from './chat-store-skeleton'

// ── ctx 改造（setStreaming → finalizeSession + clearPendingSend）──

/**
 * message.* 事件副作用上下文（store refs + 收口回调）。
 *
 * [去环 seam] effects 不 import chat.ts，经此 ctx 接收 finalizeSession/clearPendingSend。
 * chat.ts 构造 ctx 时注入自身方法（单一 adapter，store 即实现）。
 */
export interface MessageEffectContext {
  messages: { value: Map<string, Message[]> }
  retryStates: { value: Map<string, RetryState> }
  queueStates: { value: Map<string, QueueState> }
  applyFileChanges: (
    sessionId: string,
    messageId: string,
    changes: FileChange[],
    changeSetStatus: ChangeSetStatus,
    isFullSet: boolean,
  ) => void
  markChangeSetsSuperseded: (sessionId: string) => void
  /** 唯一收口出口（替代 setStreaming）。终态 handler 调。errorText 可选：error/stream_error 时写入。 */
  finalizeSession: (sessionId: string, reason: FinalizeReason, errorText?: string) => void
  /** message_start 清空窗（替代 setStreaming 隐式清 dispatching）。 */
  clearPendingSend: (sessionId: string) => void
  markPendingDelivered: (sessionId: string, text: string, sendMode?: SteerFollowUpMode) => void
}

type MessageEffectHandler = (
  ctx: MessageEffectContext,
  sessionId: string,
  payload: Record<string, unknown>,
) => void

// ── sealed guard helper（D-010）──

/**
 * 最后一条 assistant 是否仍 streaming。
 *
 * [D-010 sealed 不变式] finalizeSession 后实体已终态 → 此函数返回 false →
 * delta handler 早 return（晚到事件幂等丢弃，不污染终态）。
 */
function isLastAssistantStreaming(
  messages: { value: Map<string, Message[]> },
  sid: string,
): boolean {
  const list = messages.value.get(sid)
  if (!list || list.length === 0) return false
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (m.role === 'assistant') return m.status === 'streaming'
  }
  return false
}

// ── handler 改造骨架 ──

const messageEffects: Partial<Record<ServerMessageType, MessageEffectHandler>> = {
  // ── 主流式生命周期 ──

  'message.message_start': (ctx, sid, payload) => {
    // 空窗结束：clearPendingSend（接管 dispatching 语义）
    // [接线] 真接 ctx.clearPendingSend
    ctx.clearPendingSend(sid)
    // 叶子：创建 streaming assistant entity（实现期填，含 contentBlocks:[]）
    void payload
    throw new Error('not implemented: message_start entity creation')
    // 实现期：armStreamingTimer(sid) 由 store 内部在 entity 创建后挂载
  },

  'message.complete': (ctx, sid, payload) => {
    // [接线] reason 从 stopReason 推导 → finalizeSession（数据流可见）
    const stopReason = (payload.stopReason as string | undefined) ?? 'end_turn'
    const reason: FinalizeReason =
      stopReason === 'aborted' ? 'aborted'
      : stopReason === 'error' ? 'error'
      : 'normal'
    ctx.finalizeSession(sid, reason)
    // usage 回填（turn 级聚合，回填最后一条 assistant）—— enrichment，非 status 收口
  },

  'message.error': (ctx, sid, payload) => {
    // [F2 修正] 恢复 payload 读 errorText，保持现行「并入末条 streaming 或新建 error 消息」语义
    const errorText = (payload.message as string | undefined) ?? 'Unknown error'
    // [接线] 真接 ctx.finalizeSession('error', errorText)——errorText 写入实体
    ctx.finalizeSession(sid, 'error', errorText)
  },

  'message.stream_error': (ctx, sid, payload) => {
    // [F2 修正] 恢复 payload 读 streamErrContent，保持现行「无前置流则合成 error 消息」语义
    const streamErrContent = (payload.content as string | undefined) ?? 'Stream error'
    // [接线] 真接 ctx.finalizeSession('stream_error', streamErrContent)
    ctx.finalizeSession(sid, 'stream_error', streamErrContent)
  },

  // ── delta 类（纯 chunk 更新，入口 sealed guard）──

  'message.text_delta': (ctx, sid, payload) => {
    // [D-010 sealed] finalizeSession 后晚到 delta 幂等丢弃
    // [接线] 真接 isLastAssistantStreaming guard
    if (!isLastAssistantStreaming(ctx.messages, sid)) return
    // 叶子：append delta 到 last assistant.content + contentBlocks push text 块
    void payload
    throw new Error('not implemented: text_delta append')
  },

  'message.thinking_start': (ctx, sid, payload) => {
    // [D-010 sealed]
    if (!isLastAssistantStreaming(ctx.messages, sid)) return
    void payload
    throw new Error('not implemented: thinking_start')
  },

  'message.thinking_delta': (ctx, sid, payload) => {
    // [D-010 sealed]
    if (!isLastAssistantStreaming(ctx.messages, sid)) return
    void payload
    throw new Error('not implemented: thinking_delta')
  },

  'message.thinking_end': (ctx, sid) => {
    // [D-010 sealed]
    if (!isLastAssistantStreaming(ctx.messages, sid)) return
    throw new Error('not implemented: thinking_end endTime')
  },

  'message.tool_call_start': (ctx, sid, payload) => {
    // [D-010 sealed]
    if (!isLastAssistantStreaming(ctx.messages, sid)) return
    void payload
    throw new Error('not implemented: tool_call_start')
  },

  'message.tool_call_end': (ctx, sid, payload) => {
    // [D-010 sealed 边界] tool_call_end **不 sealed**（M8/SV-2 决策）——
    // 它是终态确认事件，允许覆盖 finalizeSession 产生的诚实态（end_not_received → completed）。
    // 迟到真实 tool_call_end 携带真实 output，覆盖诚实态是正确语义。
    // 若误 sealed，toolCall 永久卡 end_not_received，真实工具结果丢失（NFR 点名高严重度失败）。
    // 叶子：按现行逻辑更新 toolCall status=completed + output（覆盖 end_not_received）
    void ctx
    void sid
    void payload
    throw new Error('not implemented: tool_call_end (override path, no sealed guard)')
  },

  'message.tool_call_update': (ctx, sid, payload) => {
    // [D-010 sealed]
    if (!isLastAssistantStreaming(ctx.messages, sid)) return
    void payload
    throw new Error('not implemented: tool_call_update')
  },

  // 其余 handler（thinking_end/tool_call_*、customStart、status、bashExecution、
  // compactionSummary、auto_retry_*、queue_update、file_changes、changeSetInvalidated）
  // 保持现行逻辑不变，仅 delta 类加 sealed guard。骨架省略未改动的 handler。
}

/**
 * message.* 事件单一入口（消除 double-dispatch）。
 * 非 message.* 或未注册 type no-op。
 */
export function dispatchMessageEvent(
  ctx: MessageEffectContext,
  sessionId: string,
  msg: ServerMessage,
): void {
  const handler = messageEffects[msg.type as ServerMessageType]
  if (handler) handler(ctx, sessionId, msg.payload as Record<string, unknown>)
}

// 验证：终态 handler 真接线 ctx.finalizeSession（tsc 实证 reason: FinalizeReason 类型匹配）
// 验证：delta handler 真接线 isLastAssistantStreaming（tsc 实证 guard 调用链）
// 验证：messageEffects 注册表 type 键与 ServerMessageType 一致
