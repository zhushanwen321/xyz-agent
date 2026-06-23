/**
 * Chat store —— messages（按 sessionId 分区）+ isStreaming。
 *
 * 依赖方向：无（stores 间禁止互相 import）。
 *
 * 响应式策略：messages 是 Map<sessionId, Message[]>，所有变更走「取出 → 新数组 → set」
 * 的不可变更新，确保 Vue 对 Map 的集合响应性可靠触发（避免就地突变 plain 数组元素
 * 不触发响应性的陷阱）。
 *
 * 块类型覆盖（spec §9 G2-006 契约 + draft-message-stream §4 7 类块）：
 * - text（message_start/text_delta/complete）—— 主流式路径
 * - thinking（thinking_start/thinking_delta/thinking_end）—— 折进 trace
 * - tool_call（tool_call_start/tool_call_end）—— 折进 trace，失败整块红框
 * - error（message.error / message.complete stopReason:error）—— 挂最后 assistant 块
 * 历史 fixture（含 summary 收尾 text / 预置 tool_call）由 hydrate 注入，不走流式。
 *
 * FileChanges 通道（flow-2，ADR-0024 + W11 WP-L3-11）：
 * `message.file_changes` 事件由 runtime event-adapter 解析 pi 工具调用后推送
 * （协议类型见 ADR-0024 D7，待 flow-2 实施时加入 ServerMessageType 联合）。
 * 数据流处理骨架见 applyFileChanges()，类型契约已就绪（F2-1），逻辑 DEFERRED。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  ChangeSetStatus,
  FileChange,
  Message,
  ServerMessage,
} from '@xyz-agent/shared'
import { mergeFileChanges } from './chat-readers'
import { applyChunk, findLastAssistantIndex } from './chat-chunk-processor'
export type { RetryState, QueueState } from './chat-store-types'
import type { RetryState, QueueState } from './chat-store-types'

export const useChatStore = defineStore('chat', () => {
  /** 按 sessionId 分区的消息表（UC-2 隔离） */
  const messages = ref<Map<string, Message[]>>(new Map())
  /** 已 hydrate 的 session（避免切换时重复注入历史） */
  const hydrated = ref<Set<string>>(new Set())
  const isStreaming = ref(false)
  /** 按 sessionId 分区的自动重试态（W06-B，auto_retry_start/end） */
  const retryStates = ref<Map<string, RetryState>>(new Map())
  /** 按 sessionId 分区的消息队列态（W06-B，queue_update） */
  const queueStates = ref<Map<string, QueueState>>(new Map())
  /** 按 `${sessionId}:${messageId}` 分区的变更集状态（W10，ChangeSetCard 5 态） */
  const changeSetStatuses = ref<Map<string, ChangeSetStatus>>(new Map())

  /** 取指定 session 的消息数组（空时返回空数组，不写入 Map） */
  function getMessages(sessionId: string): Message[] {
    return messages.value.get(sessionId) ?? []
  }

  /** 取指定 session 的自动重试态（无则 undefined） */
  function getRetryState(sessionId: string): RetryState | undefined {
    return retryStates.value.get(sessionId)
  }

  /** 取指定 session 的消息队列态（无则 undefined） */
  function getQueueState(sessionId: string): QueueState | undefined {
    return queueStates.value.get(sessionId)
  }

  /** 取指定 message 的变更集状态（ChangeSetCard 渲染用，无则 undefined） */
  function getChangeSetStatus(sessionId: string, messageId: string): ChangeSetStatus | undefined {
    return changeSetStatuses.value.get(`${sessionId}:${messageId}`)
  }

  /** 设置变更集状态（用户 Accept/Reject 驱动 partially-reviewed/resolved/superseded） */
  function setChangeSetStatus(sessionId: string, messageId: string, status: ChangeSetStatus): void {
    changeSetStatuses.value = new Map(changeSetStatuses.value).set(`${sessionId}:${messageId}`, status)
  }

  /** 是否已加载历史（用于决定是否调 api.chat.getHistory） */
  function isHydrated(sessionId: string): boolean {
    return hydrated.value.has(sessionId)
  }

  /**
   * 注入历史消息（首次进入 session 时由 useChat 调用）。
   * 不可变 set：深拷贝 fixture 避免外部突变污染源数据，标记 hydrated。
   */
  function hydrate(sessionId: string, history: Message[]): void {
    if (hydrated.value.has(sessionId)) return
    const cloned = history.map((m) => ({ ...m }))
    messages.value.set(sessionId, cloned)
    hydrated.value = new Set(hydrated.value).add(sessionId)
  }

  /** 追加 user 消息（构造完整 Message，立即 complete） */
  function appendUser(sessionId: string, text: string): void {
    const prev = messages.value.get(sessionId) ?? []
    messages.value.set(sessionId, [
      ...prev,
      {
        id: `u-${crypto.randomUUID()}`,
        role: 'user',
        content: text,
        status: 'complete',
        timestamp: Date.now(),
      },
    ])
  }

  /**
   * 按 ServerMessage.type 追加 assistant 流式 chunk（text/thinking/tool_call/error）。
   * - message.message_start → 新建 streaming assistant message
   * - message.text_delta → 文本追加到最后一条 assistant message
   * - message.thinking_* → thinking 块管理
   * - message.tool_call_* → toolCall 块管理
   * - message.complete → 标记 complete（stopReason:error → status:error）
   * - message.error → 标记 error
   *
   * 实现（switch 分发）提取到模块级 applyChunk，避免 setup 函数过长（max-lines-per-function）。
   */
  function appendAssistantChunk(sessionId: string, msg: ServerMessage): void {
    applyChunk(
      { messages, retryStates, queueStates, applyFileChanges },
      sessionId,
      msg,
    )
  }

  function setStreaming(value: boolean): void {
    isStreaming.value = value
  }

  /**
   * 截断指定 session 的消息：删除 messageId（含/不含）及其后所有消息。
   * 编辑重发场景（原地替换 user 消息，非 fork）：truncate(含该 user) → appendUser(新文本) → send。
   * 不可变 set（slice 新数组）保证响应式触发。
   */
  function truncateFrom(sessionId: string, messageId: string, inclusive: boolean): void {
    const prev = messages.value.get(sessionId) ?? []
    const idx = prev.findIndex((m) => m.id === messageId)
    if (idx === -1) return
    const end = inclusive ? idx : idx + 1
    messages.value.set(sessionId, prev.slice(0, end))
  }

  /**
   * 处理 runtime 推送的文件变更帧（flow-2 FileChanges 通道，ADR-0024 D6/D7）。
   *
   * accumulating 帧（isFullSet=false）增量合并进目标 assistant message.fileChanges；
   * ready 帧（isFullSet=true）用 git 对账后的全集替换（真值收口）。
   * 同 filePath 合并、status 取最新。变更集卡 5 态状态机的审查态
   * （partially-reviewed/resolved/superseded）由前端用户交互驱动，不经此函数。
   */
  function applyFileChanges(
    sessionId: string,
    messageId: string,
    changes: FileChange[],
    changeSetStatus: ChangeSetStatus,
    isFullSet: boolean,
  ): void {
    const prev = messages.value.get(sessionId) ?? []
    if (prev.length === 0) return
    const idx = prev.findIndex((m) => m.id === messageId)
    // messageId 未命中时挂到最后一条 assistant message（防御：runtime/前端 id 偶发不一致）
    const targetIdx = idx >= 0 ? idx : findLastAssistantIndex(prev)
    if (targetIdx < 0) return

    const target = prev[targetIdx]
    // ready 全集直接替换（git 对账真值）；accumulating 增量合并（同 filePath 取最新 status/行数）
    const merged = isFullSet
      ? mergeFileChanges(changes, [])
      : mergeFileChanges(changes, target.fileChanges ?? [])

    const next = [...prev]
    next[targetIdx] = { ...target, fileChanges: merged }
    messages.value.set(sessionId, next)

    // 记录变更集状态（供 ChangeSetCard 渲染 5 态）
    const statusKey = `${sessionId}:${messageId}`
    changeSetStatuses.value = new Map(changeSetStatuses.value).set(statusKey, changeSetStatus)
  }

  return {
    messages,
    isStreaming,
    retryStates,
    queueStates,
    changeSetStatuses,
    getMessages,
    getRetryState,
    getQueueState,
    getChangeSetStatus,
    setChangeSetStatus,
    isHydrated,
    hydrate,
    appendUser,
    appendAssistantChunk,
    setStreaming,
    truncateFrom,
    applyFileChanges,
  }
})
