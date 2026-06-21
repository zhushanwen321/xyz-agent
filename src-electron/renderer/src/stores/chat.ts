/**
 * Chat store —— messages（按 sessionId 分区）+ isStreaming。
 *
 * 依赖方向：无（stores 间禁止互相 import）。
 *
 * 响应式策略：messages 是 Map<sessionId, Message[]>，所有变更走「取出 → 新数组 → set」
 * 的不可变更新，确保 Vue 对 Map 的集合响应性可靠触发（避免就地突变 plain 数组元素
 * 不触发响应性的陷阱）。
 *
 * 块类型覆盖（spec §9 G2-006 契约 + draft-message-stream §4 7 类块）：
 * - text（message_start/text_delta/complete）—— 主流式路径
 * - thinking（thinking_start/thinking_delta/thinking_end）—— 折进 trace
 * - tool_call（tool_call_start/tool_call_end）—— 折进 trace，失败整块红框
 * - error（message.error / message.complete stopReason:error）—— 挂最后 assistant 块
 * 历史 fixture（含 summary 收尾 text / 预置 tool_call）由 hydrate 注入，不走流式。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Message, ServerMessage, ToolCall } from '@xyz-agent/shared'

export const useChatStore = defineStore('chat', () => {
  /** 按 sessionId 分区的消息表（UC-2 隔离） */
  const messages = ref<Map<string, Message[]>>(new Map())
  /** 已 hydrate 的 session（避免切换时重复注入历史） */
  const hydrated = ref<Set<string>>(new Set())
  const isStreaming = ref(false)

  /** 取指定 session 的消息数组（空时返回空数组，不写入 Map） */
  function getMessages(sessionId: string): Message[] {
    return messages.value.get(sessionId) ?? []
  }

  /** 是否已加载历史（用于决定是否调 api.chat.getHistory） */
  function isHydrated(sessionId: string): boolean {
    return hydrated.value.has(sessionId)
  }

  /**
   * 注入历史消息（首次进入 session 时由 useChat 调用）。
   * 不可变 set：深拷贝 fixture 避免外部突变污染源数据，标记 hydrated。
   */
  function hydrate(sessionId: string, history: Message[]): void {
    if (hydrated.value.has(sessionId)) return
    const cloned = history.map((m) => ({ ...m }))
    messages.value.set(sessionId, cloned)
    hydrated.value = new Set(hydrated.value).add(sessionId)
  }

  /** 追加 user 消息（构造完整 Message，立即 complete） */
  function appendUser(sessionId: string, text: string): void {
    const prev = messages.value.get(sessionId) ?? []
    messages.value.set(sessionId, [
      ...prev,
      {
        id: `u-${crypto.randomUUID()}`,
        role: 'user',
        content: text,
        status: 'complete',
        timestamp: Date.now(),
      },
    ])
  }

  /**
   * 按 ServerMessage.type 追加 assistant 流式 chunk（text/thinking/tool_call/error）。
   * - message.message_start → 新建 streaming assistant message
   * - message.text_delta → 文本追加到最后一条 assistant message
   * - message.thinking_* → thinking 块管理
   * - message.tool_call_* → toolCall 块管理
   * - message.complete → 标记 complete（stopReason:error → status:error）
   * - message.error → 标记 error
   */
  function appendAssistantChunk(sessionId: string, msg: ServerMessage): void {
    const prev = messages.value.get(sessionId) ?? []
    switch (msg.type) {
      case 'message.message_start': {
        const messageId = readString(msg.payload, 'messageId') ?? `a-${crypto.randomUUID()}`
        messages.value.set(sessionId, [
          ...prev,
          {
            id: messageId,
            role: 'assistant',
            content: '',
            status: 'streaming',
            timestamp: Date.now(),
          },
        ])
        break
      }
      case 'message.text_delta': {
        const idx = findLastAssistantIndex(prev)
        if (idx < 0) return
        const delta = readString(msg.payload, 'delta') ?? ''
        const next = [...prev]
        next[idx] = { ...next[idx], content: next[idx].content + delta }
        messages.value.set(sessionId, next)
        break
      }
      case 'message.thinking_start': {
        const idx = findLastAssistantIndex(prev)
        if (idx < 0) return
        const blockId = readString(msg.payload, 'thinkingId') ?? `th-${crypto.randomUUID()}`
        const next = [...prev]
        const thinking = [...(next[idx].thinking ?? []), { id: blockId, content: '', collapsed: true }]
        next[idx] = { ...next[idx], thinking }
        messages.value.set(sessionId, next)
        break
      }
      case 'message.thinking_delta': {
        const idx = findLastAssistantIndex(prev)
        if (idx < 0) return
        const delta = readString(msg.payload, 'delta') ?? ''
        const next = [...prev]
        const thinking = [...(next[idx].thinking ?? [])]
        const last = thinking[thinking.length - 1]
        if (last) thinking[thinking.length - 1] = { ...last, content: last.content + delta }
        next[idx] = { ...next[idx], thinking }
        messages.value.set(sessionId, next)
        break
      }
      case 'message.tool_call_start': {
        const idx = findLastAssistantIndex(prev)
        if (idx < 0) return
        const callId = readString(msg.payload, 'toolCallId') ?? `tc-${crypto.randomUUID()}`
        const toolName = readString(msg.payload, 'toolName') ?? 'tool'
        const call: ToolCall = {
          id: callId,
          toolName,
          input: msg.payload.input ?? {},
          status: 'running',
          startTime: Date.now(),
        }
        const next = [...prev]
        const toolCalls = [...(next[idx].toolCalls ?? []), call]
        next[idx] = { ...next[idx], toolCalls }
        messages.value.set(sessionId, next)
        break
      }
      case 'message.tool_call_end': {
        const idx = findLastAssistantIndex(prev)
        if (idx < 0) return
        const callId = readString(msg.payload, 'toolCallId')
        const next = [...prev]
        const toolCalls = (next[idx].toolCalls ?? []).map((c) =>
          c.id === callId
            ? {
              ...c,
              output: readString(msg.payload, 'output') ?? c.output,
              status: (readString(msg.payload, 'status') as ToolCall['status']) ?? 'completed',
              error: readString(msg.payload, 'error') ?? c.error,
              endTime: Date.now(),
            }
            : c,
        )
        next[idx] = { ...next[idx], toolCalls }
        messages.value.set(sessionId, next)
        break
      }
      case 'message.complete': {
        const idx = findLastAssistantIndex(prev)
        if (idx < 0) return
        const last = prev[idx]
        if (last.status !== 'streaming') return
        const stopReason = readString(msg.payload, 'stopReason')
        const next = [...prev]
        next[idx] = { ...last, status: stopReason === 'error' ? 'error' : 'complete' }
        messages.value.set(sessionId, next)
        break
      }
      case 'message.stream_error': {
        // FR-5: streaming 错误（pi message_update{error}）。若无前置 assistant 流（prompt
        // 级失败/流启动前即报错），合成 error 消息，避免错误内容丢失（违反规则 #3）。
        const streamErrContent = readString(msg.payload, 'content') ?? ''
        const sIdx = findLastAssistantIndex(prev)
        if (sIdx < 0) {
          messages.value.set(sessionId, [
            ...prev,
            { id: `a-${crypto.randomUUID()}`, role: 'assistant', content: streamErrContent, status: 'error', timestamp: Date.now() },
          ])
          break
        }
        const sNext = [...prev]
        sNext[sIdx] = {
          ...sNext[sIdx],
          content: streamErrContent ? `${sNext[sIdx].content}${streamErrContent}` : sNext[sIdx].content,
          status: 'error',
        }
        messages.value.set(sessionId, sNext)
        break
      }
      case 'message.error': {
        // 规则 #3：错误必须重置 streaming 状态，避免单条气泡卡「生成中」。
        // 两类场景：
        // - 流中途错误（event-adapter error / 进程崩溃）：最后一条 assistant 仍
        //   status:'streaming' → 转为 error 并并入 errorText（保留已生成的部分内容），
        //   不新建气泡。这是 CLAUDE.md 规则 #3 防护的「UI 卡思考中」失败模式。
        // - prompt 级失败 / 闲置 session 崩溃 / hook 拦截：无 streaming assistant
        //   （或最后一条已 complete/error），新建独立 error 消息；不改写历史消息。
        const errorText = readString(msg.payload, 'message') ?? 'Unknown error'
        const idx = findLastAssistantIndex(prev)
        if (idx >= 0 && prev[idx].status === 'streaming') {
          const last = prev[idx]
          const next = [...prev]
          next[idx] = {
            ...last,
            content: last.content ? `${last.content}\n\n${errorText}` : errorText,
            status: 'error',
          }
          messages.value.set(sessionId, next)
          break
        }
        messages.value.set(sessionId, [
          ...prev,
          { id: `a-${crypto.randomUUID()}`, role: 'assistant', content: errorText, status: 'error', timestamp: Date.now() },
        ])
        break
      }
      default:
        return
    }
  }

  function setStreaming(value: boolean): void {
    isStreaming.value = value
  }

  return {
    messages,
    isStreaming,
    getMessages,
    isHydrated,
    hydrate,
    appendUser,
    appendAssistantChunk,
    setStreaming,
  }
})

/** 从后往前找最后一条 assistant message 的下标 */
function findLastAssistantIndex(list: Message[]): number {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].role === 'assistant') return i
  }
  return -1
}

/** 安全读取 payload 字符串字段（payload 是 Record<string, unknown>） */
function readString(payload: Record<string, unknown>, key: string): string | undefined {
  const v = payload[key]
  return typeof v === 'string' ? v : undefined
}
