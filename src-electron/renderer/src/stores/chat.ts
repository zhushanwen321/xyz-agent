import { defineStore } from 'pinia'
import { reactive, computed } from 'vue'
import type { Message, ToolCall } from '@xyz-agent/shared'
import { createSystemNotification } from '../lib/system-notification'

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

// ── Magic number constants ────────────────────────────────────
const PERCENT_MAX = 100
const PERCENT_SCALE = 1000
const PERCENT_PRECISION = 10

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

  /**
   * 获取指定 session 的状态分区。如果不存在则自动创建。
   *
   * 无条件创建是有意为之：
   * - 组件 mount 时 ensureSession 依赖此行为确保 state 就绪
   * - WS 事件可能先于 session 注册到达（延迟消息、重连后重放），
   *   此时自动创建空 state 容纳事件，避免消息丢失
   * - removeSession 用于显式清理不再需要的 session
   */
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
      // 收尾：标记未完成的 tool calls 为 completed，折叠未结束的 thinking blocks
      const cleaned: Message = {
        ...s.streamingMessage,
        status: 'complete',
        toolCalls: s.streamingMessage.toolCalls?.map(tc =>
          tc.status === 'running' ? { ...tc, status: 'completed' as const, endTime: Date.now() } : tc
        ),
        thinking: s.streamingMessage.thinking?.map(th =>
          th.collapsed ? th : { ...th, collapsed: true }
        ),
      }
      s.completedMessages = [...s.completedMessages, cleaned]
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
    // Restore context/token data from the latest assistant message with usage
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i]
      if (!isSystemNotification(msg) && msg.role === 'assistant' && msg.usage) {
        s.contextInputTokens = msg.usage.inputTokens
        s.tokenUsage = msg.usage.inputTokens + msg.usage.outputTokens
        s.contextUsagePercent = Math.min(PERCENT_MAX, Math.round((s.contextInputTokens / s.contextLimit) * PERCENT_SCALE) / PERCENT_PRECISION)
        break
      }
    }
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

  // ── 流式消息高层生命周期方法 ──────────────────────────────

  /** 开始新一轮流式消息 */
  function startStreaming(sid: string, msg: Message) {
    const s = getSessionState(sid)
    s.isGenerating = true
    s.streamingMessage = msg
  }

  /** 追加流式文本（streamingMessage 为 null 时忽略） */
  function appendStreamText(delta: string, sid: string) {
    appendToStreaming(delta, sid)
  }

  /** 追加 thinking 内容 */
  function appendStreamThinking(delta: string, sid: string) {
    appendThinkingDelta(delta, sid)
  }

  /** 添加流式 tool call */
  function addStreamToolCall(tc: ToolCall, sid: string) {
    addStreamingToolCall(tc, sid)
  }

  /** 更新流式 tool call 结果 */
  function updateStreamToolCall(id: string, output: string, sid: string) {
    updateStreamingToolCall(id, output, sid)
  }

  /** 完成流式消息，自动重置 isGenerating */
  function completeStream(sid: string) {
    completeStreaming({}, sid)
  }

  /** 终止流式消息（统一封装 reset 三步 + 可选错误通知） */
  function abortStream(sid: string, errorMsg?: string) {
    setGenerating(false, sid)
    setStreaming(null, sid)
    setError(null, sid)
    if (errorMsg) {
      addMessage({
        ...createSystemNotification('alert', errorMsg),
        content: errorMsg,
        status: 'error',
      }, sid)
    }
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

    // 流式消息高层方法
    startStreaming, appendStreamText, appendStreamThinking,
    addStreamToolCall, updateStreamToolCall,
    completeStream, abortStream,
  }
})
