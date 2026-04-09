import { ref, onMounted, onUnmounted, watch, type Ref } from 'vue'
import { sendMessage, getHistory, onAgentEvent, isTauri } from '../lib/tauri'
import type { AgentEvent, ChatMessage, TranscriptEntry } from '../types'

function createMessage(role: ChatMessage['role'], content: string): ChatMessage {
  return { id: crypto.randomUUID(), role, content, timestamp: new Date().toISOString() }
}

export function useChat(sessionId: Ref<string | null>) {
  const messages = ref<ChatMessage[]>([])
  const streamingText = ref('')
  const isStreaming = ref(false)
  let unlisten: (() => void) | null = null

  onMounted(async () => {
    if (!isTauri()) {
      console.warn('[useChat] not in Tauri, event listener skipped')
      return
    }
    unlisten = await onAgentEvent((event: AgentEvent) => {
      console.log('[useChat] agent event received:', event.type, 'session:', event.session_id)
      if (!sessionId.value || event.session_id !== sessionId.value) return

      switch (event.type) {
        case 'TextDelta':
          streamingText.value += event.delta
          break
        case 'ThinkingDelta':
          console.debug('[ThinkingDelta]', event.delta)
          break
        case 'MessageComplete':
          messages.value.push(createMessage('assistant', event.content))
          streamingText.value = ''
          isStreaming.value = false
          break
        case 'Error':
          messages.value.push(createMessage('system', `Error: ${event.message}`))
          isStreaming.value = false
          break
      }
    })
  })

  onUnmounted(() => {
    unlisten?.()
  })

  async function send(content: string) {
    console.log('[useChat] send called, sessionId:', sessionId.value, 'isStreaming:', isStreaming.value)
    if (!sessionId.value || isStreaming.value) {
      console.warn('[useChat] send aborted: sessionId=', sessionId.value, 'isStreaming=', isStreaming.value)
      return
    }
    isStreaming.value = true
    messages.value.push(createMessage('user', content))
    streamingText.value = ''
    console.log('[useChat] calling sendMessage:', sessionId.value, content.slice(0, 50))
    try {
      await sendMessage(sessionId.value, content)
      console.log('[useChat] sendMessage resolved')
    } catch (err) {
      console.error('[useChat] sendMessage rejected:', err)
      messages.value.push(createMessage('system', `发送失败: ${err}`))
      isStreaming.value = false
    }
  }

  async function loadHistory(sid: string) {
    const entries: TranscriptEntry[] = await getHistory(sid)
    messages.value = entries
      .filter((e) => e.type === 'user' || e.type === 'assistant')
      .map((e) => ({
        id: e.uuid,
        role: e.type as 'user' | 'assistant',
        content: e.content,
        timestamp: e.timestamp,
      }))
  }

  watch(sessionId, (newId) => {
    if (newId) loadHistory(newId)
  })

  return { messages, streamingText, isStreaming, send }
}
