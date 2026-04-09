import { ref, onMounted, onUnmounted, watch, type Ref } from 'vue'
import { sendMessage, getHistory, onAgentEvent, isTauri } from '../lib/tauri'
import type {
  AgentEvent,
  AssistantContentBlock,
  ChatMessage,
  ToolCallDisplay,
  UserContentBlock,
} from '../types'

function createMessage(role: ChatMessage['role'], content: string): ChatMessage {
  return { id: crypto.randomUUID(), role, content, timestamp: new Date().toISOString() }
}

export function useChat(sessionId: Ref<string | null>) {
  const messages = ref<ChatMessage[]>([])
  const streamingText = ref('')
  const isStreaming = ref(false)
  let unlisten: (() => void) | null = null

  /** 找到最后一条 assistant 消息，将工具调用直接挂上去 */
  function attachToolCallToLastAssistant(tc: ToolCallDisplay) {
    const last = messages.value[messages.value.length - 1]
    if (last?.role === 'assistant') {
      if (!last.toolCalls) last.toolCalls = []
      last.toolCalls.push(tc)
    }
  }

  /** 在最后一条 assistant 消息中更新工具调用状态 */
  function updateToolCallOnLastAssistant(tool_use_id: string, status: ToolCallDisplay['status'], output?: string) {
    const last = messages.value[messages.value.length - 1]
    if (last?.role === 'assistant' && last.toolCalls) {
      const tc = last.toolCalls.find((t) => t.tool_use_id === tool_use_id)
      if (tc) {
        tc.status = status
        if (output !== undefined) tc.output = output
      }
    }
  }

  onMounted(async () => {
    if (!isTauri()) {
      console.warn('[useChat] not in Tauri, event listener skipped')
      return
    }
    unlisten = await onAgentEvent((event: AgentEvent) => {
      if (!sessionId.value || event.session_id !== sessionId.value) return

      switch (event.type) {
        case 'TextDelta':
          streamingText.value += event.delta
          break
        case 'ThinkingDelta':
          break
        case 'MessageComplete': {
          streamingText.value = ''
          messages.value.push(createMessage('assistant', event.content))
          break
        }
        case 'TurnComplete':
          isStreaming.value = false
          break
        case 'Error':
          messages.value.push(createMessage('system', `Error: ${event.message}`))
          isStreaming.value = false
          break
        case 'ToolCallStart': {
          attachToolCallToLastAssistant({
            tool_use_id: event.tool_use_id,
            tool_name: event.tool_name,
            input: event.input,
            status: 'running',
          })
          break
        }
        case 'ToolCallEnd': {
          updateToolCallOnLastAssistant(
            event.tool_use_id,
            event.is_error ? 'error' : 'completed',
            event.output,
          )
          break
        }
      }
    })
  })

  onUnmounted(() => {
    unlisten?.()
  })

  async function send(content: string) {
    if (!sessionId.value || isStreaming.value) return
    isStreaming.value = true
    messages.value.push(createMessage('user', content))
    streamingText.value = ''
    try {
      await sendMessage(sessionId.value, content)
    } catch (err) {
      messages.value.push(createMessage('system', `发送失败: ${err}`))
      isStreaming.value = false
    }
  }

  async function loadHistory(sid: string) {
    const result = await getHistory(sid)
    const msgs: ChatMessage[] = []

    // 预扫描：建立 tool_use_id → { output, is_error } 映射
    const toolOutputs = new Map<string, { output: string; is_error: boolean }>()
    for (const entry of result.entries) {
      if (entry.type === 'user') {
        for (const block of entry.content as UserContentBlock[]) {
          if (block.type === 'tool_result') {
            toolOutputs.set(block.tool_use_id, {
              output: block.content,
              is_error: block.is_error,
            })
          }
        }
      }
    }

    if (result.conversation_summary) {
      msgs.push(createMessage('system', `[对话摘要] ${result.conversation_summary}`))
    }

    for (const entry of result.entries) {
      if (entry.type === 'user') {
        const blocks = entry.content as UserContentBlock[]
        const hasText = blocks.some((b) => b.type === 'text')
        if (!hasText) continue // 纯 tool_result 的 user entry 不渲染
        msgs.push({
          id: entry.uuid,
          role: 'user',
          content: extractTextContent(blocks),
          timestamp: entry.timestamp,
        })
      } else if (entry.type === 'assistant') {
        const blocks = entry.content as AssistantContentBlock[]
        const text = extractTextContent(blocks)
        const toolCalls = blocks
          .filter((b): b is Extract<AssistantContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
          .map((b) => {
            const result = toolOutputs.get(b.id)
            return {
              tool_use_id: b.id,
              tool_name: b.name,
              input: b.input,
              status: result ? (result.is_error ? 'error' as const : 'completed' as const) : 'completed' as const,
              output: result?.output,
            }
          })
        msgs.push({
          id: entry.uuid,
          role: 'assistant',
          content: text,
          timestamp: entry.timestamp,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        })
      }
    }

    messages.value = msgs
  }

  function extractTextContent(blocks: Array<{ type: string; text?: string }>): string {
    return blocks
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text!)
      .join('')
  }

  watch(sessionId, (newId) => {
    if (newId) loadHistory(newId)
  })

  return { messages, streamingText, isStreaming, send }
}
