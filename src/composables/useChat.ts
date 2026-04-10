import { ref, onMounted, onUnmounted, watch, type Ref } from 'vue'
import { sendMessage, getHistory, onAgentEvent, isTauri } from '../lib/tauri'
import type {
  AgentEvent,
  AssistantContentBlock,
  AssistantSegment,
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
  const tokenUsage = ref({ inputTokens: 0, outputTokens: 0 })
  const currentTurnSegments = ref<AssistantSegment[]>([])
  let unlisten: (() => void) | null = null
  let historyLoadPromise: Promise<void> | null = null

  function appendTextToCurrentTurn(text: string) {
    const segs = currentTurnSegments.value
    if (segs.length > 0 && segs[segs.length - 1].type === 'text') {
      ;(segs[segs.length - 1] as { type: 'text'; text: string }).text += text
    } else {
      segs.push({ type: 'text', text })
    }
  }

  function findToolSegment(tool_use_id: string): ToolCallDisplay | undefined {
    const seg = currentTurnSegments.value.find(
      (s): s is { type: 'tool'; call: ToolCallDisplay } =>
        s.type === 'tool' && s.call.tool_use_id === tool_use_id,
    )
    return seg?.call
  }

  onMounted(async () => {
    if (!isTauri()) return
    unlisten = await onAgentEvent((event: AgentEvent) => {
      if (!sessionId.value || event.session_id !== sessionId.value) return

      switch (event.type) {
        case 'TextDelta':
          streamingText.value += event.delta
          appendTextToCurrentTurn(event.delta)
          break
        case 'ThinkingDelta':
          break
        case 'MessageComplete': {
          // TextDelta 已逐字追加到 currentTurnSegments，
          // 这里只清空 streamingText 并更新 tokenUsage
          streamingText.value = ''
          tokenUsage.value = {
            inputTokens: event.usage.input_tokens,
            outputTokens: tokenUsage.value.outputTokens + event.usage.output_tokens,
          }
          break
        }
        case 'TurnComplete': {
          if (currentTurnSegments.value.length > 0) {
            messages.value.push({
              id: crypto.randomUUID(),
              role: 'assistant',
              content: '',
              segments: [...currentTurnSegments.value],
              timestamp: new Date().toISOString(),
            })
            currentTurnSegments.value = []
          }
          isStreaming.value = false
          break
        }
        case 'Error':
          messages.value.push(createMessage('system', `Error: ${event.message}`))
          isStreaming.value = false
          break
        case 'ToolCallStart': {
          currentTurnSegments.value.push({
            type: 'tool',
            call: {
              tool_use_id: event.tool_use_id,
              tool_name: event.tool_name,
              input: event.input,
              status: 'running',
            },
          })
          break
        }
        case 'ToolCallEnd': {
          const tc = findToolSegment(event.tool_use_id)
          if (tc) {
            tc.status = event.is_error ? 'error' : 'completed'
            tc.output = event.output
          }
          break
        }
      }
    })
  })

  onUnmounted(() => { unlisten?.() })

  async function send(content: string) {
    if (!sessionId.value || isStreaming.value) return
    // 等待进行中的历史加载完成，避免 loadHistory 覆盖即将 push 的用户消息
    if (historyLoadPromise) await historyLoadPromise
    isStreaming.value = true
    messages.value.push(createMessage('user', content))
    currentTurnSegments.value = []
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
        if (!hasText) continue
        msgs.push({
          id: entry.uuid,
          role: 'user',
          content: blocks.filter((b) => b.type === 'text').map((b) => (b as { type: 'text'; text: string }).text).join(''),
          timestamp: entry.timestamp,
        })
      } else if (entry.type === 'assistant') {
        const blocks = entry.content as AssistantContentBlock[]
        const segments: AssistantSegment[] = blocks.map((b) => {
          if (b.type === 'text') {
            return { type: 'text' as const, text: b.text }
          } else {
            const result = toolOutputs.get(b.id)
            return {
              type: 'tool' as const,
              call: {
                tool_use_id: b.id,
                tool_name: b.name,
                input: b.input,
                status: result ? (result.is_error ? 'error' as const : 'completed' as const) : 'completed' as const,
                output: result?.output,
              },
            }
          }
        })
        msgs.push({
          id: entry.uuid,
          role: 'assistant',
          content: '',
          segments,
          timestamp: entry.timestamp,
        })
      }
    }

    messages.value = msgs
  }

  watch(sessionId, (newId) => {
    if (newId) {
      historyLoadPromise = loadHistory(newId).finally(() => { historyLoadPromise = null })
    }
  })

  return { messages, streamingText, isStreaming, tokenUsage, send, currentTurnSegments }
}
