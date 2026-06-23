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
  ToolCall,
} from '@xyz-agent/shared'

export const useChatStore = defineStore('chat', () => {
  /** 按 sessionId 分区的消息表（UC-2 隔离） */
  const messages = ref<Map<string, Message[]>>(new Map())
  /** 已 hydrate 的 session（避免切换时重复注入历史） */
  const hydrated = ref<Set<string>>(new Set())
  const isStreaming = ref(false)

  /** 取指定 session 的消息数组（空时返回空数组，不写入 Map） */
  function getMessages(sessionId: string): Message[] {
    return messages.value.get(sessionId) ?? []
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
   */
  function appendAssistantChunk(sessionId: string, msg: ServerMessage): void {
    const prev = messages.value.get(sessionId) ?? []
    switch (msg.type) {
      case 'message.message_start': {
        const messageId = readString(msg.payload, 'messageId') ?? `a-${crypto.randomUUID()}`
        messages.value.set(sessionId, [
          ...prev,
          {
            id: messageId,
            role: 'assistant',
            content: '',
            status: 'streaming',
            timestamp: Date.now(),
          },
        ])
        break
      }
      case 'message.text_delta': {
        const idx = findLastAssistantIndex(prev)
        if (idx < 0) return
        const delta = readString(msg.payload, 'delta') ?? ''
        const next = [...prev]
        next[idx] = { ...next[idx], content: next[idx].content + delta }
        messages.value.set(sessionId, next)
        break
      }
      case 'message.thinking_start': {
        const idx = findLastAssistantIndex(prev)
        if (idx < 0) return
        const blockId = readString(msg.payload, 'thinkingId') ?? `th-${crypto.randomUUID()}`
        const next = [...prev]
        const thinking = [...(next[idx].thinking ?? []), { id: blockId, content: '', collapsed: true, startTime: Date.now() }]
        next[idx] = { ...next[idx], thinking }
        messages.value.set(sessionId, next)
        break
      }
      case 'message.thinking_end': {
        // W05-A：给最后 ThinkingBlock 设 endTime（字段已存在 message.ts:30）。
        // payload 仅 {sessionId}（event-adapter thinking_end 不带额外字段）。
        const idx = findLastAssistantIndex(prev)
        if (idx < 0) return
        const thinking = prev[idx].thinking
        if (!thinking || thinking.length === 0) return
        const lastIdx = thinking.length - 1
        const next = [...prev]
        const nextThinking = [...thinking]
        nextThinking[lastIdx] = { ...nextThinking[lastIdx], endTime: Date.now() }
        next[idx] = { ...next[idx], thinking: nextThinking }
        messages.value.set(sessionId, next)
        break
      }
      case 'message.thinking_delta': {
        const idx = findLastAssistantIndex(prev)
        if (idx < 0) return
        const delta = readString(msg.payload, 'delta') ?? ''
        const next = [...prev]
        const thinking = [...(next[idx].thinking ?? [])]
        const last = thinking[thinking.length - 1]
        if (last) thinking[thinking.length - 1] = { ...last, content: last.content + delta }
        next[idx] = { ...next[idx], thinking }
        messages.value.set(sessionId, next)
        break
      }
      case 'message.tool_call_start': {
        const idx = findLastAssistantIndex(prev)
        if (idx < 0) return
        const callId = readString(msg.payload, 'toolCallId') ?? `tc-${crypto.randomUUID()}`
        const toolName = readString(msg.payload, 'toolName') ?? 'tool'
        const call: ToolCall = {
          id: callId,
          toolName,
          input: readRecord(msg.payload, 'input'),
          status: 'running',
          startTime: Date.now(),
        }
        const next = [...prev]
        const toolCalls = [...(next[idx].toolCalls ?? []), call]
        next[idx] = { ...next[idx], toolCalls }
        messages.value.set(sessionId, next)
        break
      }
      case 'message.tool_call_end': {
        const idx = findLastAssistantIndex(prev)
        if (idx < 0) return
        const callId = readString(msg.payload, 'toolCallId')
        const next = [...prev]
        const toolCalls = (next[idx].toolCalls ?? []).map((c) =>
          c.id === callId
            ? {
              ...c,
              output: readString(msg.payload, 'output') ?? c.output,
              status: (readString(msg.payload, 'status') as ToolCall['status']) ?? 'completed',
              error: readString(msg.payload, 'error') ?? c.error,
              endTime: Date.now(),
            }
            : c,
        )
        next[idx] = { ...next[idx], toolCalls }
        messages.value.set(sessionId, next)
        break
      }
      case 'message.tool_call_update': {
        // W05-A：Extension 工具调用进度更新。event-adapter tool_execution_update
        // 生产端只发 detail（string | object），消费对齐生产端（不臆造 progress）。
        const idx = findLastAssistantIndex(prev)
        if (idx < 0) return
        const callId = readString(msg.payload, 'toolCallId')
        if (!callId) return
        const detail = readDetail(msg.payload, 'detail')
        const next = [...prev]
        const toolCalls = (next[idx].toolCalls ?? []).map((c) =>
          c.id === callId ? { ...c, detail } : c,
        )
        next[idx] = { ...next[idx], toolCalls }
        messages.value.set(sessionId, next)
        break
      }
      case 'message.complete': {
        const idx = findLastAssistantIndex(prev)
        if (idx < 0) return
        const last = prev[idx]
        if (last.status !== 'streaming') return
        const stopReason = readString(msg.payload, 'stopReason')
        const next = [...prev]
        // W05-A：消费 message.complete.usage（{inputTokens,outputTokens,totalTokens}）
        // 回填 Message.usage（字段已存在 message.ts:99）。stopReason:error → status:error。
        const usage = readUsage(msg.payload)
        next[idx] = {
          ...last,
          status: stopReason === 'error' ? 'error' : 'complete',
          ...(usage ? { usage } : {}),
        }
        messages.value.set(sessionId, next)
        break
      }
      case 'message.status': {
        // W05-A：运行时态推送（steer/aborted/sent/queued 等运行状态）。
        // 区别于请求级 reply（send/steer/follow_up/abort 的 reply 已走 pending 通道，
        // 不经 streamSubscribe）——此处是 pi status 事件经 event-adapter 直推。
        // 当前最小化：仅接收记录，不改 Message.status（streaming/complete/error 是
        // 消息生命周期，message.status 是运行过程态，两者正交）。
        // W06 的 retry/queue 提示才需要驱动 UI 指示位。
        break
      }
      case 'message.stream_error': {
        // FR-5: streaming 错误（pi message_update{error}）。若无前置 assistant 流（prompt
        // 级失败/流启动前即报错），合成 error 消息，避免错误内容丢失（违反规则 #3）。
        const streamErrContent = readString(msg.payload, 'content') ?? ''
        const sIdx = findLastAssistantIndex(prev)
        if (sIdx < 0) {
          messages.value.set(sessionId, [
            ...prev,
            { id: `a-${crypto.randomUUID()}`, role: 'assistant', content: streamErrContent, status: 'error', timestamp: Date.now() },
          ])
          break
        }
        const sNext = [...prev]
        sNext[sIdx] = {
          ...sNext[sIdx],
          content: streamErrContent ? `${sNext[sIdx].content}${streamErrContent}` : sNext[sIdx].content,
          status: 'error',
        }
        messages.value.set(sessionId, sNext)
        break
      }
      case 'message.error': {
        // 规则 #3：错误必须重置 streaming 状态，避免单条气泡卡「生成中」。
        // 两类场景：
        // - 流中途错误（event-adapter error / 进程崩溃）：最后一条 assistant 仍
        //   status:'streaming' → 转为 error 并并入 errorText（保留已生成的部分内容），
        //   不新建气泡。这是 CLAUDE.md 规则 #3 防护的「UI 卡思考中」失败模式。
        // - prompt 级失败 / 闲置 session 崩溃 / hook 拦截：无 streaming assistant
        //   （或最后一条已 complete/error），新建独立 error 消息；不改写历史消息。
        const errorText = readString(msg.payload, 'message') ?? 'Unknown error'
        const idx = findLastAssistantIndex(prev)
        if (idx >= 0 && prev[idx].status === 'streaming') {
          const last = prev[idx]
          const next = [...prev]
          next[idx] = {
            ...last,
            content: last.content ? `${last.content}\n\n${errorText}` : errorText,
            status: 'error',
          }
          messages.value.set(sessionId, next)
          break
        }
        messages.value.set(sessionId, [
          ...prev,
          { id: `a-${crypto.randomUUID()}`, role: 'assistant', content: errorText, status: 'error', timestamp: Date.now() },
        ])
        break
      }
      default:
        return
    }
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
   *
   * 骨架阶段（F2-3）：类型契约就绪，数据流逻辑 DEFERRED 到 flow-2 完整实施。
   */
  function applyFileChanges(
    sessionId: string,
    messageId: string,
    changes: FileChange[],
    changeSetStatus: ChangeSetStatus,
    isFullSet: boolean,
  ): void {
    void sessionId
    void messageId
    void changes
    void changeSetStatus
    void isFullSet
    throw new Error('applyFileChanges: not implemented (flow-2 FileChanges channel, ADR-0024)')
  }

  return {
    messages,
    isStreaming,
    getMessages,
    isHydrated,
    hydrate,
    appendUser,
    appendAssistantChunk,
    setStreaming,
    truncateFrom,
    applyFileChanges,
  }
})

/** 从后往前找最后一条 assistant message 的下标 */
function findLastAssistantIndex(list: Message[]): number {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].role === 'assistant') return i
  }
  return -1
}

/** 安全读取 payload 字符串字段（payload 是 Record<string, unknown>） */
function readString(payload: Record<string, unknown>, key: string): string | undefined {
  const v = payload[key]
  return typeof v === 'string' ? v : undefined
}

/** 读 payload 上的对象字段（tool_call_start.input 等），非对象时回退空对象。 */
function readRecord(payload: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = payload[key]
  return v && typeof v === 'object' && !Array.isArray(v)
    ? v as Record<string, unknown>
    : {}
}

/**
 * 读 tool_call_update.detail。event-adapter 生产端 detail 可能是 string 或 object
 * （见 handleToolExecutionUpdate：partialResult 对象/字符串分支）。窄化到 ToolCall.detail 类型。
 */
function readDetail(payload: Record<string, unknown>, key: string): string | Record<string, unknown> | undefined {
  const v = payload[key]
  if (v === null || v === undefined) return undefined
  if (typeof v === 'string') return v
  if (typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  return undefined
}

/**
 * 读 message.complete.usage（event-adapter 生产端形状）。
 * payload.usage = { inputTokens, outputTokens, totalTokens }（见 event-adapter handleAgentEnd）。
 * shared.Usage 只需 { inputTokens, outputTokens }；totalTokens 舍弃（无字段承载）。
 */
function readUsage(payload: Record<string, unknown>): { inputTokens: number; outputTokens: number } | undefined {
  const u = readRecord(payload, 'usage')
  if (Object.keys(u).length === 0) return undefined
  const inputTokens = readNumber(u, 'inputTokens')
  const outputTokens = readNumber(u, 'outputTokens')
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  return { inputTokens, outputTokens }
}

/** 读 payload 上的数字字段 */
function readNumber(payload: Record<string, unknown>, key: string): number | undefined {
  const v = payload[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
