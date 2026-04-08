import { ref, onMounted, onUnmounted, watch, type Ref } from 'vue'
import { sendMessage, getHistory, onAgentEvent } from '../lib/tauri'
import type { AgentEvent, ChatMessage, TranscriptEntry } from '../types'

export function useChat(sessionId: Ref<string | null>) {
  const messages = ref<ChatMessage[]>([])
  const streamingText = ref('')
  const isStreaming = ref(false)
  let unlisten: (() => void) | null = null

  onMounted(async () => {
    unlisten = await onAgentEvent((event: AgentEvent) => {
      if (!sessionId.value || event.session_id !== sessionId.value) return

      switch (event.type) {
        case 'TextDelta':
          streamingText.value += event.delta
          break
        case 'MessageComplete':
          messages.value.push({
            id: crypto.randomUUID(),
            role: event.role as 'assistant',
            content: event.content,
            timestamp: new Date().toISOString(),
          })
          streamingText.value = ''
          isStreaming.value = false
          break
        case 'Error':
          messages.value.push({
            id: crypto.randomUUID(),
            role: 'system',
            content: `Error: ${event.message}`,
            timestamp: new Date().toISOString(),
          })
          isStreaming.value = false
          break
      }
    })
  })

  onUnmounted(() => {
    unlisten?.()
  })

  async function send(content: string) {
    if (!sessionId.value || isStreaming.value) return
    isStreaming.value = true
    messages.value.push({
      id: crypto.randomUUID(),
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
    })
    streamingText.value = ''
    await sendMessage(sessionId.value, content)
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
