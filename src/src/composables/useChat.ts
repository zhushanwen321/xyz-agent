import { useChatStore } from '../stores/chat'
import { send } from '../lib/ws-client'
import { on, off } from '../lib/event-bus'
import { onMounted, onUnmounted } from 'vue'
import type { ServerMessage } from '@xyz-agent/shared'

export function useChat() {
  const store = useChatStore()

  function sendMessage(sessionId: string, content: string) {
    store.setGenerating(true)
    send({ type: 'message.send', payload: { sessionId, content } })
  }

  function abort(sessionId: string) {
    send({ type: 'message.abort', payload: { sessionId } })
  }

  function handleEvent(msg: ServerMessage) {
    switch (msg.type) {
      case 'message.text_delta':
        store.setStreaming({
          id: 'streaming',
          role: 'assistant',
          content: '',
          status: 'streaming',
          timestamp: Date.now(),
        })
        store.appendToStreaming(msg.payload.delta as string)
        break
      case 'message.complete':
        store.completeStreaming()
        break
      case 'message.error':
        store.setGenerating(false)
        break
    }
  }

  onMounted(() => {
    on('message.text_delta', handleEvent)
    on('message.complete', handleEvent)
    on('message.error', handleEvent)
  })

  onUnmounted(() => {
    off('message.text_delta', handleEvent)
    off('message.complete', handleEvent)
    off('message.error', handleEvent)
  })

  return { sendMessage, abort, messages: store.messages }
}
