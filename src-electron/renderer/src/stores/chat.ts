/**
 * Chat store —— messages（按 sessionId 分区）+ isStreaming。
 *
 * 依赖方向：无（stores 间禁止互相 import）。
 * 骨架阶段：state 合法初始值（空 Map / false），action throw。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Message } from '@xyz-agent/shared'

export const useChatStore = defineStore('chat', () => {
  /** 按 sessionId 分区的消息表（UC-2 隔离） */
  const messages = ref<Map<string, Message[]>>(new Map())
  const isStreaming = ref(false)

  /** 追加 user 消息 —— 实现阶段填 */
  function appendUser(sessionId: string, text: string): void {
    throw new Error(`not implemented: appendUser(${sessionId}, ${text})`)
  }

  /** 追加 assistant 流式 chunk —— 实现阶段填 */
  function appendAssistantChunk(sessionId: string, chunk: unknown): void {
    throw new Error(`not implemented: appendAssistantChunk(${sessionId}, ${typeof chunk})`)
  }

  function setStreaming(value: boolean): void {
    throw new Error(`not implemented: setStreaming(${value})`)
  }

  return { messages, isStreaming, appendUser, appendAssistantChunk, setStreaming }
})
