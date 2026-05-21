import { defineStore } from 'pinia'
import { reactive, computed } from 'vue'
import type { Message, ToolCall } from '@xyz-agent/shared'

// SystemNotification: local system notification (not from API)
export interface SystemNotification {
  id: string
  role: 'system'
  status?: string
  content?: string
  notificationType?: 'done' | 'alert' | 'info'
  notificationTitle?: string
  notificationDescription?: string
  notificationAction?: string
  timestamp: number
}

export type ChatMessage = Message | SystemNotification

/** 类型守卫：判断 ChatMessage 是否为 SystemNotification */
export function isSystemNotification(msg: ChatMessage): msg is SystemNotification {
  return 'notificationType' in msg || 'notificationTitle' in msg
}

// ── Types ──────────────────────────────────────────────────────────

export interface PendingApproval {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  dangerLevel: 'safe' | 'caution' | 'danger'
  createdAt: number
}

/** Per-session chat state partition */
export interface ChatSessionState {
  completedMessages: ChatMessage[]
  streamingMessage: Message | null
  isGenerating: boolean
  isLoadingHistory: boolean
  error: string | null
  agentViews: Record<string, Message[]>
  activeAgentId: string
  pendingApprovals: PendingApproval[]
  contextUsagePercent: number
  contextInputTokens: number
  contextLimit: number
  tokenUsage: number
  doneCount: number
  alertCount: number
  isCompacting: boolean
}

// ── Helpers ────────────────────────────────────────────────────────

function createSessionState(): ChatSessionState {
  return {
    completedMessages: [],
    streamingMessage: null,
    isGenerating: false,
    isLoadingHistory: false,
    error: null,
    agentViews: {},
    activeAgentId: 'main',
    pendingApprovals: [],
    contextUsagePercent: 0,
    contextInputTokens: 0,
    contextLimit: 100_000,
    tokenUsage: 0,
    doneCount: 0,
    alertCount: 0,
    isCompacting: false,
  }
}

// ── Store ──────────────────────────────────────────────────────────

export const useChatStore = defineStore('chat', () => {
  // 唯一数据源：按 sessionId 分区
  const chatSessions = reactive(new Map<string, ChatSessionState>())

  // ── Session 管理 ────────────────────────────────────────────

  function getSessionState(sessionId: string): ChatSessionState {
    if (!chatSessions.has(sessionId)) {
      chatSessions.set(sessionId, createSessionState())
    }
    return chatSessions.get(sessionId)!
  }

  function ensureSession(sessionId: string): void {
    getSessionState(sessionId)
  }

  function removeSession(sessionId: string): void {
    chatSessions.delete(sessionId)
  }

  // ── Store 级 computed（跨 session 聚合）────────────────────

  const allAgentOptions = computed(() => [
    { id: 'main', label: '主线对话', color: 'var(--success)' },
  ])

  // ── 消息操作（全部要求显式 sessionId）──────────────────────

  function addMessage(msg: ChatMessage, sessionId: string) {
    const s = getSessionState(sessionId)
    s.completedMessages = [...s.completedMessages, msg]
  }

  function setStreaming(msg: Message | null, sessionId: string) {
    getSessionState(sessionId).streamingMessage = msg
  }

  function appendToStreaming(delta: string, sessionId: string) {
    const s = getSessionState(sessionId)
    if (s.streamingMessage) {
      s.streamingMessage = {
        ...s.streamingMessage,
        content: s.streamingMessage.content + delta,
      }
    }
  }

  function completeStreaming(opts: { keepGenerating?: boolean } | undefined, sessionId: string) {
    const s = getSessionState(sessionId)
    if (s.streamingMessage) {
      s.completedMessages = [...s.completedMessages, { ...s.streamingMessage, status: 'complete' }]
      s.streamingMessage = null
    }
    if (!opts?.keepGenerating) {
      s.isGenerating = false
    }
  }

  function setGenerating(v: boolean, sessionId: string) {
    getSessionState(sessionId).isGenerating = v
  }

  function clearMessages(sessionId: string) {
    const s = getSessionState(sessionId)
    s.completedMessages = []
    s.streamingMessage = null
  }

  function replaceMessages(msgs: ChatMessage[], sessionId: string) {
    const s = getSessionState(sessionId)
    s.completedMessages = msgs
    s.isLoadingHistory = false
  }

  function setLoadingHistory(v: boolean, sessionId: string) {
    getSessionState(sessionId).isLoadingHistory = v
  }

  function appendThinkingDelta(delta: string, sessionId: string) {
    const s = getSessionState(sessionId)
    if (s.streamingMessage) {
      const current = (s.streamingMessage as unknown as Record<string, unknown>).thinkingContent ?? ''
      s.streamingMessage = {
        ...s.streamingMessage,
        thinkingContent: current + delta,
      } as Message
    }
  }

  function addStreamingToolCall(tc: ToolCall, sessionId: string) {
    const s = getSessionState(sessionId)
    if (s.streamingMessage) {
      const calls = [...((s.streamingMessage as unknown as Record<string, unknown>).toolCalls as ToolCall[] ?? []), tc]
      s.streamingMessage = { ...s.streamingMessage, toolCalls: calls } as Message
    }
  }

  function updateStreamingToolCall(id: string, output: string, sessionId: string) {
    const s = getSessionState(sessionId)
    if (s.streamingMessage) {
      const calls = ((s.streamingMessage as unknown as Record<string, unknown>).toolCalls as ToolCall[] ?? []).map(
        (tc) => tc.id === id ? { ...tc, output, status: 'completed' as const } : tc,
      )
      s.streamingMessage = { ...s.streamingMessage, toolCalls: calls } as Message
    }
  }

  function addPendingApproval(pending: PendingApproval, sessionId: string) {
    const s = getSessionState(sessionId)
    s.pendingApprovals = [...s.pendingApprovals, pending]
  }

  function removePendingApproval(toolCallId: string, sessionId: string) {
    const s = getSessionState(sessionId)
    s.pendingApprovals = s.pendingApprovals.filter(p => p.toolCallId !== toolCallId)
  }

  // ── 状态 / 上下文 ──────────────────────────────────────────

  function updateContextInfo(usagePercent: number, inputTokens: number, ctxLimit: number, sessionId: string) {
    const s = getSessionState(sessionId)
    s.contextUsagePercent = usagePercent
    s.contextInputTokens = inputTokens
    s.contextLimit = ctxLimit
  }

  function setError(err: string | null, sessionId: string) {
    getSessionState(sessionId).error = err
  }

  function switchAgent(agentId: string, sessionId: string) {
    getSessionState(sessionId).activeAgentId = agentId
  }

  function setTokenUsage(usage: number, sessionId: string) {
    getSessionState(sessionId).tokenUsage = usage
  }

  function setDoneCount(n: number, sessionId: string) {
    getSessionState(sessionId).doneCount = n
  }

  function setAlertCount(n: number, sessionId: string) {
    getSessionState(sessionId).alertCount = n
  }

  function setCompacting(v: boolean, sessionId: string) {
    getSessionState(sessionId).isCompacting = v
  }

  return {
    // State
    chatSessions,

    // Session 管理
    getSessionState, ensureSession, removeSession,

    // Store 级 computed
    allAgentOptions,

    // 消息操作
    addMessage, setStreaming, appendToStreaming,
    completeStreaming, setGenerating, clearMessages,
    replaceMessages, appendThinkingDelta, addStreamingToolCall,
    updateStreamingToolCall, addPendingApproval, removePendingApproval,

    // 状态
    updateContextInfo, setError, switchAgent,
    setTokenUsage, setDoneCount, setAlertCount, setCompacting,
    setLoadingHistory,
  }
})
