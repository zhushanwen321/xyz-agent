import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { Message } from '@xyz-agent/shared'

export const useChatStore = defineStore('chat', () => {
  const messages = ref<Message[]>([])
  const streamingMessage = ref<Message | null>(null)
  const isGenerating = ref(false)
  const contextTokens = ref(0)
  const contextLimit = ref(100000)

  const contextUsagePercent = computed(() =>
    contextLimit.value > 0 ? Math.round((contextTokens.value / contextLimit.value) * 100) : 0
  )

  function addMessage(msg: Message) {
    messages.value = [...messages.value, msg]
  }

  function setStreaming(msg: Message | null) {
    streamingMessage.value = msg
  }

  function appendToStreaming(delta: string) {
    if (streamingMessage.value) {
      streamingMessage.value = {
        ...streamingMessage.value,
        content: streamingMessage.value.content + delta,
      }
    }
  }

  function completeStreaming() {
    if (streamingMessage.value) {
      messages.value = [...messages.value, { ...streamingMessage.value, status: 'complete' }]
      streamingMessage.value = null
    }
    isGenerating.value = false
  }

  function setGenerating(v: boolean) { isGenerating.value = v }
  function setContextTokens(t: number) { contextTokens.value = t }
  function clearMessages() { messages.value = []; streamingMessage.value = null }

  return {
    messages, streamingMessage, isGenerating,
    contextTokens, contextLimit, contextUsagePercent,
    addMessage, setStreaming, appendToStreaming,
    completeStreaming, setGenerating, setContextTokens, clearMessages,
  }
})
