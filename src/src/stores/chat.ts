import { defineStore } from 'pinia'
import { ref, computed, readonly } from 'vue'
import type { Message, ToolCall } from '@xyz-agent/shared'

interface PendingApproval {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  dangerLevel: 'safe' | 'caution' | 'danger'
  createdAt: number
}

const DEFAULT_CONTEXT_TOKEN_LIMIT = 100000
const PERCENT_MULTIPLIER = 100

export const useChatStore = defineStore('chat', () => {
  const completedMessages = ref<Message[]>([])
  const streamingMessage = ref<Message | null>(null)
  const isGenerating = ref(false)
  const contextTokens = ref(0)
  const contextLimit = ref(DEFAULT_CONTEXT_TOKEN_LIMIT)
  const contextInputTokens = ref(0)
  const pendingApprovals = ref<PendingApproval[]>([])
  const isLoading = ref(false)
  const error = ref<string | null>(null)
  const activeAgentId = ref('main')
  const agentViews = ref<Record<string, Message[]>>({})
  const tokenUsage = ref(0)

  // Server-authoritative usage percentage; set via updateContextInfo
  const contextUsagePercent = ref(0)

  const messageCount = computed(() => completedMessages.value.length)
  const lastMessage = computed(() => completedMessages.value[completedMessages.value.length - 1])
  const hasError = computed(() => error.value !== null)
  const allMessages = computed(() => {
    const msgs = [...completedMessages.value]
    if (streamingMessage.value) msgs.push(streamingMessage.value)
    return msgs
  })

  const allAgentOptions = computed(() => [
    { id: 'main', label: '主线对话', color: 'var(--success)' },
    ...Object.keys(agentViews.value).map(id => ({ id, label: id, color: 'var(--accent)' })),
  ])

  function addMessage(msg: Message) {
    completedMessages.value = [...completedMessages.value, msg]
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
      completedMessages.value = [...completedMessages.value, { ...streamingMessage.value, status: 'complete' }]
      streamingMessage.value = null
    }
    isGenerating.value = false
  }

  function setGenerating(v: boolean) { isGenerating.value = v }
  function setContextTokens(t: number) { contextTokens.value = t }
  function clearMessages() { completedMessages.value = []; streamingMessage.value = null }

  function replaceMessages(msgs: Message[]) { completedMessages.value = msgs }

  function appendThinkingDelta(delta: string) {
    if (streamingMessage.value) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const current = (streamingMessage.value as any).thinkingContent ?? ''
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const updated = { ...streamingMessage.value } as any
      updated.thinkingContent = current + delta
      streamingMessage.value = updated
    }
  }

  function addStreamingToolCall(tc: ToolCall) {
    if (streamingMessage.value) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const calls = [...((streamingMessage.value as any).toolCalls ?? []), tc]
      streamingMessage.value = { ...streamingMessage.value, toolCalls: calls }
    }
  }

  function updateStreamingToolCall(id: string, output: string) {
    if (streamingMessage.value) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const calls = ((streamingMessage.value as any).toolCalls ?? []).map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (tc: any) => tc.id === id ? { ...tc, output, status: 'completed' as const } : tc
      )
      streamingMessage.value = { ...streamingMessage.value, toolCalls: calls }
    }
  }

  function addPendingApproval(pending: PendingApproval) { pendingApprovals.value = [...pendingApprovals.value, pending] }
  function removePendingApproval(toolCallId: string) { pendingApprovals.value = pendingApprovals.value.filter(p => p.toolCallId !== toolCallId) }
  function startLoading() { isLoading.value = true }
  function stopLoading() { isLoading.value = false }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- placeholder for future implementation
  function updateUsage(_usage: { inputTokens: number; outputTokens: number; totalTokens: number }) { /* update relevant refs */ }
  function updateContextInfo(usagePercent: number, inputTokens: number, ctxLimit: number) {
    contextUsagePercent.value = usagePercent
    contextInputTokens.value = inputTokens
    contextLimit.value = ctxLimit
  }
  function setError(err: string | null) { error.value = err }
  function switchAgent(agentId: string) { activeAgentId.value = agentId }
  function setTokenUsage(usage: number) { tokenUsage.value = usage }

  return {
    completedMessages, streamingMessage, isGenerating,
    contextTokens, contextLimit, contextInputTokens, contextUsagePercent,
    activeAgentId, agentViews, tokenUsage,
    allAgentOptions,
    pendingApprovals, isLoading, error,
    messageCount, lastMessage, hasError, allMessages,
    addMessage, setStreaming, appendToStreaming,
    completeStreaming, setGenerating, setContextTokens, clearMessages,
    replaceMessages, appendThinkingDelta, addStreamingToolCall,
    updateStreamingToolCall, addPendingApproval, removePendingApproval,
    startLoading, stopLoading, updateUsage, updateContextInfo, setError,
    switchAgent, setTokenUsage,
  }
})
