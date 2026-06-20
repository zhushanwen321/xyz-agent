/**
 * Chat store —— messages（按 sessionId 分区）+ isStreaming。
 *
 * 依赖方向：无（stores 间禁止互相 import）。
 *
 * 响应式策略：messages 是 Map<sessionId, Message[]>，所有变更走「取出 → 新数组 → set」
 * 的不可变更新，确保 Vue 对 Map 的集合响应性可靠触发（避免就地突变 plain 数组元素
 * 不触发响应性的陷阱）。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Message, ServerMessage } from '@xyz-agent/shared'

export const useChatStore = defineStore('chat', () => {
  /** 按 sessionId 分区的消息表（UC-2 隔离） */
  const messages = ref<Map<string, Message[]>>(new Map())
  const isStreaming = ref(false)

  /** 取指定 session 的消息数组（空时返回空数组，不写入 Map） */
  function getMessages(sessionId: string): Message[] {
    return messages.value.get(sessionId) ?? []
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
   * 按 ServerMessage.type 追加 assistant 流式 chunk：
   * - message.message_start → 新建 streaming assistant message
   * - message.text_delta → 文本追加到最后一条 assistant message
   * - message.complete → 标记最后一条 assistant message 为 complete
   * - 其余 type（thinking_delta / tool_call_*）最小实现不处理，features 层扩展
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
      case 'message.complete': {
        const idx = findLastAssistantIndex(prev)
        if (idx < 0) return
        const last = prev[idx]
        if (last.status !== 'streaming') return
        const next = [...prev]
        next[idx] = { ...last, status: 'complete' }
        messages.value.set(sessionId, next)
        break
      }
      default:
        return
    }
  }

  function setStreaming(value: boolean): void {
    isStreaming.value = value
  }

  return { messages, isStreaming, getMessages, appendUser, appendAssistantChunk, setStreaming }
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
