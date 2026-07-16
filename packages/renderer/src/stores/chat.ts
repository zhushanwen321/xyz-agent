/**
 * Chat store —— messages（按 sessionId 分区）+ 派生 isGenerating。
 *
 * 状态撕裂修复（cw-2026-07-08-fix-state-tearing）：
 * 删除命令式 isStreaming flag，改为从 message 实体派生的 isGenerating(sid) computed scan。
 * pendingSend Set 取代 dispatchingSessionId（跨 session 顺序发送）。
 * finalizeSession 统一收口出口（所有异常路径的单一收口，非翻 flag）。
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
import { computed, onScopeDispose, ref, shallowRef } from 'vue'
import { commitMessages } from './chat-mutations'
import { truncateToolOutputBatch } from '@/utils/truncate-tool-output'
import type {
  ContentBlock,
  Message,
  Segment,
  ServerMessage,
  SteerFollowUpMode,
} from '@xyz-agent/shared'
import { normalizeContent } from '@xyz-agent/shared'
import { dispatchMessageEvent } from './chat-message-effects'
import { findLastAssistantIndex } from './chat-chunk-processor'
import { createChangeSetController } from './chat-changeset'
export type { RetryState, QueueState, FinalizeReason } from './chat-store-types'
import type { RetryState, QueueState, FinalizeReason } from './chat-store-types'

/**
 * streaming 超时默认值：10min。
 *
 * W6 调整：原 24h 形同虚设。降到 10min 作为 runtime pi watchdog（5min ABORT）之后的第二道 UI 兜底——
 * runtime watchdog 先检测 pi 卡死并自动 abort（广播 message.error），前端 streaming 超时只处理
 * runtime 自身也卡死的极端场景（runtime 主进程卡死时 watchdog 跑不了）。
 */
export const DEFAULT_STREAMING_TIMEOUT_MS = 600_000 // 10min

/**
 * 读 streaming 超时阈值（D-003 阈值可配置 + D-016 IPC）。
 * [D-016] 经 IPC 读主进程 env（非 import.meta.env，Vite 不暴露 XYZ_ 前缀）。
 * 留在模块作用域以控制 setup 函数行数（max-lines-per-function）。
 */
function readStreamingTimeoutMs(): number {
  // TODO: 接 IPC — window.electronAPI?.getStreamingTimeout?.()
  const env = undefined
  const parsed = env ? Number(env) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STREAMING_TIMEOUT_MS
}

/**
 * disposeSession 所需清理的 per-session ref 集合。
 * 留在模块作用域以控制 setup 函数行数（max-lines-per-function，对齐 readStreamingTimeoutMs 模式）。
 */
interface DisposableRefs<T> {
  value: T
}

/**
 * 清理指定 session 的全部 per-session 状态（deleteSession 调用，S3）。
 *
 * deleteSession 此前只清 session 列表 + panel 绑定，chat store 的 per-session 状态
 * （messages / hydrated / pendingSend / compactingSessions / retryStates / queueStates /
 * failedHistory / changeSetStatuses）永久残留。频繁建删 session 后内存单调增长。
 * 此函数一次性清理该 session 的所有分区数据 + 取消 timer。
 */
function disposeSessionImpl(
  sessionId: string,
  mapRefs: DisposableRefs<Map<string, unknown>>[],
  setRefs: DisposableRefs<Set<string>>[],
  changeSetStatuses: DisposableRefs<Map<string, unknown>>,
  clearTimers: (() => void)[],
): void {
  // Map ref：不可变写保证响应式（new Map + delete + 赋值新 Map）。
  // W1 后 messages 是 shallowRef，必须整体替换 .value 才触发；retryStates/queueStates
  // 是深 ref，此写法同样正确触发。统一用"构造新 Map → delete → 赋值"范式。
  for (const ref of mapRefs) {
    if (ref.value.has(sessionId)) {
      const next = new Map(ref.value)
      next.delete(sessionId)
      ref.value = next
    }
  }
  // Set ref：不可变写保证响应式
  for (const ref of setRefs) {
    if (ref.value.has(sessionId)) {
      const next = new Set(ref.value)
      next.delete(sessionId)
      ref.value = next
    }
  }
  // changeSetStatuses：key 格式 `${sessionId}:${messageId}`，前缀过滤删除
  if (changeSetStatuses.value.size > 0) {
    const prefix = `${sessionId}:`
    let changed = false
    const next = new Map(changeSetStatuses.value)
    for (const key of next.keys()) {
      if (key.startsWith(prefix)) {
        next.delete(key)
        changed = true
      }
    }
    if (changed) changeSetStatuses.value = next
  }
  // timer 清理（模块级 Map，非响应式）
  for (const clear of clearTimers) clear()
}

/**
 * 追加 system 提示行纯逻辑（模块级，控制 setup 行数）。
 * runtime 主动推送的元信息反馈（如 compactionSummary），作 SystemNotice 渲染。
 */
function appendSystemNoticeImpl(
  messages: DisposableRefs<Map<string, Message[]>>,
  sessionId: string,
  text: string,
): void {
  const prev = messages.value.get(sessionId) ?? []
  commitMessages(messages, sessionId, [
    ...prev,
    {
      id: `sys-${crypto.randomUUID()}`,
      role: 'system',
      content: text,
      status: 'complete',
      timestamp: Date.now(),
    },
  ])
}

/**
 * subagent streaming delta 纯逻辑（W4，模块作用域）。
 *
 * 全量替换虚拟 session 最后一条 streaming assistant 的 content + 幂等补 text contentBlock；
 * 无 streaming assistant 时 push 新的。吸收自原 subagent store applyStreamDelta（去
 * getMessages/setMessages 回调参数，直接操作传入的 messages ref），让 chat store 成为所有
 * assistant content mutation 的唯一入口。
 *
 * 扩展层传的 lines 是 buffer 的 split('\n')，每次都是完整文本 → 用替换而非追加。
 * contentBlock 幂等：已有 text 块则不重复 push（与主流式 text_delta handler 对齐）。
 * 留在模块作用域以控制 setup 函数行数（max-lines-per-function），store action 仅做 ref 委托。
 */
function applySubagentStreamDeltaImpl(
  messages: { value: Map<string, Message[]> },
  virtualId: string,
  lines: string[],
): void {
  const fullText = lines.join('\n')
  const prev = messages.value.get(virtualId) ?? []
  const lastAssistantIdx = findLastAssistantIndex(prev)
  const next = [...prev]
  if (lastAssistantIdx >= 0 && next[lastAssistantIdx].status === 'streaming') {
    const prevMsg = next[lastAssistantIdx]
    // 不可变写法（W1）：shallowRef 下不依赖字段级 mutate，整体构造新对象
    const contentBlocks: ContentBlock[] = prevMsg.contentBlocks?.some((b) => b.type === 'text')
      ? prevMsg.contentBlocks
      : [...(prevMsg.contentBlocks ?? []), { type: 'text', refId: 'text' }]
    next[lastAssistantIdx] = { ...prevMsg, content: fullText, contentBlocks }
  } else {
    next.push({
      id: `sa-${crypto.randomUUID()}`,
      role: 'assistant',
      content: fullText,
      status: 'streaming',
      contentBlocks: [{ type: 'text', refId: 'text' }],
      timestamp: Date.now(),
    })
  }
  commitMessages(messages, virtualId, next)
}

/**
 * subagent streaming 收口纯逻辑（W4，模块作用域）：把虚拟 session 最后一条 streaming
 * assistant 翻成 complete。
 *
 * sealed 守卫对齐（D-010 parity）：实体一旦 complete 不再被后续 delta 污染。无 streaming
 * 实体时幂等 no-op。不走 finalizeSession：subagent 虚拟 session 无 pendingSend / streaming
 * timer 生命周期（由 subagent store 的 panelStreamUnsub 管理），只翻 status。
 */
function finalizeSubagentStreamImpl(
  messages: { value: Map<string, Message[]> },
  virtualId: string,
): void {
  const prev = messages.value.get(virtualId)
  if (!prev || prev.length === 0) return
  const lastAssistantIdx = findLastAssistantIndex(prev)
  if (lastAssistantIdx < 0 || prev[lastAssistantIdx].status !== 'streaming') return
  const next = [...prev]
  next[lastAssistantIdx] = { ...next[lastAssistantIdx], status: 'complete' }
  commitMessages(messages, virtualId, next)
}

/**
 * finalizeAllStreaming 的候选 session 集合构造（W3 / W-S3，模块作用域）。
 *
 * 遍历所有可能持有瞬态态的 session 的 key 并集：messages.keys() ∪ compactingSessions ∪
 * retryStates ∪ queueStates ∪ pendingSend。不能只遍历 messages.keys()——compacting /
 * retry / queue / pendingSend 可能独立于消息存在，仅遍历 messages 会漏掉这些 session。
 *
 * [W3 / W-S3] pendingSend 并入：纯 pendingSend 态（用户已发起、message_start 空窗、无消息实体）
 * 不在 messages.keys() 内，断连时不会立即收口，UI 卡「发送中」。
 *
 * 抽到模块作用域以控制 setup 函数行数（max-lines-per-function），store action 仅做 ref 委托。
 */
function collectFinalizeCandidates(
  messages: { value: Map<string, Message[]> },
  compactingSessions: { value: Set<string> },
  retryStates: { value: Map<string, unknown> },
  queueStates: { value: Map<string, unknown> },
  pendingSend: { value: Set<string> },
): Set<string> {
  const candidateSids = new Set<string>(messages.value.keys())
  for (const sid of compactingSessions.value) candidateSids.add(sid)
  for (const sid of retryStates.value.keys()) candidateSids.add(sid)
  for (const sid of queueStates.value.keys()) candidateSids.add(sid)
  for (const sid of pendingSend.value) candidateSids.add(sid)
  return candidateSids
}

/**
 * resetTransientStates 的 session 级独立瞬态清理（W3，模块作用域）。
 * 清 compacting / retry / queue（断连兜底：这些态在断连后无事件驱动清理）。
 * 抽到模块作用域以控制 setup 函数行数（max-lines-per-function），store action 仅做 ref 委托。
 */
function clearIndependentTransient(
  sessionId: string,
  retryStates: { value: Map<string, unknown> },
  queueStates: { value: Map<string, unknown> },
  setCompacting: (sessionId: string, value: boolean) => void,
): void {
  setCompacting(sessionId, false)
  if (retryStates.value.has(sessionId)) {
    const next = new Map(retryStates.value)
    next.delete(sessionId)
    retryStates.value = next
  }
  if (queueStates.value.has(sessionId)) {
    const next = new Map(queueStates.value)
    next.delete(sessionId)
    queueStates.value = next
  }
}

/**
 * finalizeSession 的 message 终态映射纯逻辑（模块作用域）。
 *
 * 把 streaming/running 实体推到终态（reason 决定 message.status + toolCall.status 映射），
 * 同步收口 running toolCall。幂等（sealed 后实体不变）。
 * 抽到模块作用域以控制 setup 函数行数（max-lines-per-function），store action 仅做 ref 委托。
 */
function finalizeMessagesImpl(
  messages: { value: Map<string, Message[]> },
  sessionId: string,
  reason: FinalizeReason,
  errorText?: string,
): void {
  const prev = messages.value.get(sessionId)
  if (!prev) return
  const next = prev.map((m) => {
    const isStreaming = m.status === 'streaming'
    // toolCall 统一收口（无论 message 是否还 streaming；[W4] 收敛到此处单一路径，
    // 避免 message.complete 局部 finalizeToolCalls 与此两套映射漂移）。
    // - error/stream_error → toolCall 'error'；其它非 normal/aborted → 'end_not_received'（设 endTime）；
    //   normal/aborted 不设 endTime（与原逻辑一致）。
    // 延迟到达的真实 tool_call_end 会用真实 output 覆盖收口值（end_not_received → completed）。
    const toolCalls = m.toolCalls?.map((tc): typeof tc => {
      if (tc.status !== 'running') return tc
      const tcIsError = reason === 'error' || reason === 'stream_error'
      return {
        ...tc,
        status: tcIsError ? 'error' : 'end_not_received',
        ...(reason !== 'normal' && reason !== 'aborted' ? { endTime: Date.now() } : {}),
      }
    })
    if (!isStreaming) {
      // message 已终态（如 message.complete handler 已改 status），只补 toolCall 收口。
      // 无 running toolCall 则原样返回（保持引用稳定，避免无谓 re-render）。
      return m.toolCalls?.some((tc) => tc.status === 'running') ? { ...m, toolCalls } : m
    }
    // message 仍 streaming → 转终态 + 收口 toolCall
    const isErrorReason = reason === 'error' || reason === 'stream_error' || reason === 'timeout' || reason === 'disconnect' || reason === 'restart'
    const finalStatus = isErrorReason ? 'error' : 'complete'
    const finalContent = errorText && m.role === 'assistant'
      ? (m.content ? `${m.content}\n\n${errorText}` : errorText)
      : m.content
    return { ...m, status: finalStatus, content: finalContent, toolCalls } satisfies Message
  })
  commitMessages(messages, sessionId, next)
}



export const useChatStore = defineStore('chat', () => {
  /** 按 sessionId 分区的消息表（UC-2 隔离） */
  // W1: shallowRef——messages 更新全部走 commitMessages（新 Map + set + 赋值 .value），
  // 不再用 messages.value.set（shallowRef 下 Map mutation 不触发响应式）。
  // 消除万级深 proxy（每条 Message 的嵌套对象不再被代理），降低长对话内存与 GC 压力（ADR 0034）。
  const messages = shallowRef<Map<string, Message[]>>(new Map())
  /** 已 hydrate 的 session（避免切换时重复注入历史） */
  const hydrated = ref<Set<string>>(new Set())
  /**
   * 预期态：ack→message_start 空窗期的「用户已发起未确认」session 集合。
   * 取代 dispatchingSessionId（单值）。跨 session 顺序发送需要 Set（跨 panel 切换）。
   * 与 isGenerating 正交：add 在 send 前，delete 在 message_start（正常）/ finalizeSession（异常）。
   */
  const pendingSend = ref<Set<string>>(new Set())
  /** 正在压缩的 session 集合（#6：session.compacting/compacted 驱动，按 session 隔离） */
  const compactingSessions = ref<Set<string>>(new Set())
  /** 按 sessionId 分区的自动重试态（W06-B，auto_retry_start/end） */
  const retryStates = ref<Map<string, RetryState>>(new Map())
  /** 按 sessionId 分区的消息队列态（W06-B，queue_update） */
  const queueStates = ref<Map<string, QueueState>>(new Map())
  /**
   * FileChanges 子域控制器（W10，ADR-0024 D5 baseline diff）。
   * 变更集 5 态状态机 + FileChange 合并逻辑内聚在 chat-changeset.ts；messages ref 由
   * 本 store 拥有并注入（applyFileChanges 据此定位目标 assistant message），changeSetStatuses
   * ref 由控制器内部独占。设计选择与公共 API 见 chat-changeset.ts 顶部注释。
   */
  const changeset = createChangeSetController(messages)
  const { changeSetStatuses, getChangeSetStatus, setChangeSetStatus, applyFileChanges, markChangeSetsSuperseded } = changeset
  /** getHistory 加载失败的 session（#2 AC-2.6：landing 重试出口，不永久卡住） */
  const failedHistory = ref<Set<string>>(new Set())

  // ── 超时兜底 timer（D-003 阈值可配置 + D-007 真收口）──

  /**
   * streaming 超时阈值。默认 10min（600_000ms，DEFAULT_STREAMING_TIMEOUT_MS）。
   * W6 调整：原 24h 形同虚设，降到 10min 作为 runtime pi watchdog（5min ABORT）之后的第二道
   * UI 兜底——runtime watchdog 先 abort 广播 message.error，本 timer 只兜底 runtime 自身卡死。
   * 可经 env XYZ_STREAMING_TIMEOUT_MS 配置（IPC 从主进程读，D-016）。
   */
  const STREAMING_TIMEOUT_MS = readStreamingTimeoutMs()
  /** pendingSend 空窗期 timer 阈值（D-015/F4，接管 dispatchingTimer 30s 语义） */
  const PENDING_SEND_TIMEOUT_MS = 30_000
  /** streaming 超时 timer（per-session 跟踪，按 sessionId 隔离） */
  const streamingTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** pendingSend 空窗期 timer（按 sessionId 隔离） */
  const pendingSendTimers = new Map<string, ReturnType<typeof setTimeout>>()

  // ── 派生态（computed scan，D-005，零手动维护）──

  /**
   * 当前所有含 streaming 消息的 session 集合（W2，ADR 0035）。
   *
   * computed 派生 Set——单一真相源，物理不可撕裂（任何 messages 写入路径自动覆盖，
   * 含 13+ 处写入点 + 3 个边界点 truncateFrom/disposeSession/hydrate）。messages 变化时
   * 全量扫一次并缓存，服务所有 isGenerating 查询，消除"每个消费点重复 O(n) 扫描"。
   *
   * shallowRef 下依赖 messages.value 的整体替换（commitMessages 已保证），computed 正确重算。
   */
  const streamingSessionIds = computed(() => {
    const ids = new Set<string>()
    for (const [sid, msgs] of messages.value) {
      for (const m of msgs) {
        if (m.status === 'streaming') {
          ids.add(sid)
          break
        }
      }
    }
    return ids
  })

  /**
   * 指定 session 是否有 streaming 实体（派生，无 setter）。
   * 不变式：`isGenerating(sid) ≡ ∃ m ∈ messages[sid], m.status === 'streaming'`
   * W2：改用 streamingSessionIds computed 的 O(1) has 查询（ADR 0035），
   * 取代每次调用 O(n) list.some 扫描。不变式逻辑完全相同，仅加缓存层。
   */
  function isGenerating(sessionId: string): boolean {
    return streamingSessionIds.value.has(sessionId)
  }

  /**
   * 指定 session 是否「活跃」（派生）。
   * 不变式：`isActive(sid) ≡ isGenerating(sid) ∨ pendingSend.has(sid)`
   * 驱动 Composer 停止按钮 / steer guard / B 策略路由。
   */
  function isActive(sessionId: string): boolean {
    return isGenerating(sessionId) || pendingSend.value.has(sessionId)
  }

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

  /** 是否已加载历史（用于决定是否调 api.chat.getHistory） */
  function isHydrated(sessionId: string): boolean {
    return hydrated.value.has(sessionId)
  }

  /** 标记某 session 的历史加载失败（landing 显重试出口，AC-2.6） */
  function markHistoryFailed(sessionId: string): void {
    failedHistory.value = new Set(failedHistory.value).add(sessionId)
  }

  /** 清除某 session 的历史加载失败态（重试成功后） */
  function clearHistoryError(sessionId: string): void {
    const next = new Set(failedHistory.value)
    next.delete(sessionId)
    failedHistory.value = next
  }

  /**
   * 注入历史消息（首次进入 session 时由 useChat 调用）。
   * 不可变 set：深拷贝 fixture 避免外部突变污染源数据，标记 hydrated。
   *
   * W2 H3：回流路径截断（AC-10/D9）。历史 tool result 经 truncateToolOutputBatch
   * 截断为 4KB 头部，与实时路径（tool_call_end）策略一致。
   */
  function hydrate(sessionId: string, history: Message[]): void {
    if (hydrated.value.has(sessionId)) return
    const cloned = truncateToolOutputBatch(history.map((m) => ({ ...m })))
    commitMessages(messages, sessionId, cloned)
    hydrated.value = new Set(hydrated.value).add(sessionId)
  }

  /**
   * 直接覆盖某 session 的消息（不受 hydrated 不可变约束）。
   * 用于 subagent 虚拟 session：subagent JSONL 可能延迟写入（pi 延迟 flush），
   * 首次拉取为空后需要重新拉取覆盖。不标记 hydrated（允许后续 hydrate 再覆盖）。
   *
   * W2 H3：回流路径截断（AC-10/D9），与 hydrate 一致。
   */
  function setMessages(sessionId: string, history: Message[]): void {
    const cloned = truncateToolOutputBatch(history.map((m) => ({ ...m })))
    commitMessages(messages, sessionId, cloned)
  }

  /** 追加 user 消息（构造完整 Message，立即 complete）。content 为 Segment[]（ADR-0037） */
  function appendUser(sessionId: string, segments: Segment[]): void {
    const prev = messages.value.get(sessionId) ?? []
    commitMessages(messages, sessionId, [
      ...prev,
      {
        id: `u-${crypto.randomUUID()}`,
        role: 'user',
        content: segments,
        status: 'complete',
        timestamp: Date.now(),
      },
    ])
  }

  /**
   * 追加 pending user 消息（steer/followup 已入队 pi，待投递）。
   * draft-composer-states S7：steer/followup 提交后立即在对话流显示 pending 气泡（虚线+脉冲），
   * 投递时（queue_update 移除该项 → markPendingDelivered）转 complete。
   * sendMode 区分 steer（追加当前回合）/ follow-up（回合后新轮），驱动气泡配色。
   */
  function appendPending(sessionId: string, segments: Segment[], sendMode: SteerFollowUpMode): void {
    const prev = messages.value.get(sessionId) ?? []
    commitMessages(messages, sessionId, [
      ...prev,
      {
        id: `u-${crypto.randomUUID()}`,
        role: 'user',
        content: segments,
        status: 'pending',
        sendMode,
        timestamp: Date.now(),
      },
    ])
  }

  /**
   * 定位 session 里第一条匹配的 pending user 消息（FIFO）。
   * markPendingDelivered / removePending 共用的匹配逻辑，抽此 helper 避免谓词重复漂移。
   * sendMode 可选——未传时退化为仅 content 匹配（兼容宽松场景）。
   *
   * content 改 Segment[] 后，用 normalizeContent 归一化两边比较（FR-7，AC-5.1）。
   * matcher 接收 string | Segment[]：
   * - removePending（useChat 调）传 Segment[]（前端发送时的 segments）
   * - markPendingDelivered（chat-message-effects 调）传 string（pi queue_update 回传的 text）
   * 两种来源经 normalizeContent 归一化后统一比较。
   */
  function findPendingIndex(
    sessionId: string,
    matcher: string | Segment[],
    sendMode?: SteerFollowUpMode,
  ): number {
    const prev = messages.value.get(sessionId)
    if (!prev) return -1
    const target = normalizeContent(matcher)
    return prev.findIndex(
      (m) =>
        m.role === 'user'
        && m.status === 'pending'
        && normalizeContent(m.content) === target
        && (sendMode === undefined || m.sendMode === sendMode),
    )
  }

  /**
   * 将指定 session 里匹配文本 + sendMode 的 pending user 消息标记为已投递（status → complete）。
   * 触发：queue_update 里某条 steer/followUp 文本消失（pi drain 投递了它）。
   * [W5] 按 content + sendMode 精确匹配，避免跨类型同文本误转（steer「补」与 followUp「补」）。
   * 仅转第一条匹配的 pending（FIFO，与 pi splice 顺序一致）；重复文本 drain 时由调用方按计数多次调用。
   * 幂等：对已 complete 的消息 no-op。
   */
  function markPendingDelivered(
    sessionId: string,
    matcher: string | Segment[],
    sendMode?: SteerFollowUpMode,
  ): void {
    const idx = findPendingIndex(sessionId, matcher, sendMode)
    if (idx === -1) return
    const prev = messages.value.get(sessionId)!
    const next = [...prev]
    next[idx] = { ...next[idx], status: 'complete' }
    commitMessages(messages, sessionId, next)
  }

  /**
   * 移除指定 session 里匹配文本 + sendMode 的 pending user 消息（W1：steer/followUp API 失败回滚）。
   * 与 markPendingDelivered 的区别：转 complete 是「投递成功」，removePending 是「发送失败，消息作废」。
   * 仅移除第一条匹配的 pending（FIFO）。失败时调用——pending 气泡从对话流删除，不留孤儿。
   */
  function removePending(
    sessionId: string,
    matcher: string | Segment[],
    sendMode: SteerFollowUpMode,
  ): void {
    const idx = findPendingIndex(sessionId, matcher, sendMode)
    if (idx === -1) return
    const prev = messages.value.get(sessionId)!
    commitMessages(messages, sessionId, prev.filter((_, i) => i !== idx))
  }

  /**
   * message.* 事件的单一入口（F2 重构：消除 double-dispatch）。
   *
   * useChat.ensureStreamSubscription 收到 message.* 后调本方法，不再自己 switch。
   * 内部经 dispatchMessageEvent 查 effect 注册表，执行该 type 的全部副作用：
   * (a) chunk 状态更新（messages/retryStates/queueStates）+ (b) 终态收口
   * （finalizeSession）。注册表见 chat-message-effects.ts。
   *
   * 行为等价：与原 appendAssistantChunk(applyChunk) + finalizeSession 的串联一致——
   * handler 内先更新 chunk 状态后收口实体，对应原「先 appendAssistantChunk 再 finalizeSession」顺序。
   * 非 message.* / 未注册 type no-op（等价原 applyChunk default return）。
   */
  function applyMessageEvent(sessionId: string, msg: ServerMessage): void {
    dispatchMessageEvent(
      {
        messages,
        retryStates,
        queueStates,
        applyFileChanges,
        markChangeSetsSuperseded,
        finalizeSession,
        clearPendingSend,
        armStreamingTimer,
        markPendingDelivered,
      },
      sessionId,
      msg,
    )
  }

  // ── 收口出口（唯一，D-007 真收口非翻 flag）──

  /**
   * session 级统一收口：把 streaming/running 实体推到终态 + 清 pendingSend + 清 timer。
   *
   * 不变式（幂等，D-010 sealed）：重复调用不报错，sealed 后实体不变。
   * 不处理 usage 回填（message.complete handler 单独 enrichment）。
   *
   * @param reason 决定 message.status + toolCall.status 终态映射（见 FinalizeReason）
   */
  function finalizeSession(sessionId: string, reason: FinalizeReason, errorText?: string): void {
    finalizeMessagesImpl(messages, sessionId, reason, errorText)
    // 清 pendingSend + timer
    clearPendingSend(sessionId)
    clearStreamingTimer(sessionId)
    console.warn(`[chat] finalizeSession sid=${sessionId} reason=${reason}`)
  }

  /**
   * 多 session 统一收口（F1 修正 + W3 瞬态全收口）：遍历所有可能持有瞬态态的 session，
   * 对每个有瞬态态的调 resetTransientStates（一次性清 streaming + compacting + retry + queue +
   * pendingSend）。
   *
   * useConnection runtime 重启/失败/断连时调此 helper，确保后台 session 的全部瞬态指示位收口，
   * 避免 UI 在断连后永久卡「生成中 / 压缩中 / 重试中 / 队列中」。
   *
   * 遍历范围：messages.keys() ∪ compactingSessions ∪ retryStates ∪ queueStates 的 key 并集。
   * 不能只遍历 messages.keys()——compacting / retry / queue 可能独立于消息存在（如 setCompacting
   * 直接置位、auto_retry_start 只写 retryStates 不写 messages），仅遍历 messages 会漏掉这些 session。
   */
  function finalizeAllStreaming(reason: FinalizeReason): void {
    const candidateSids = collectFinalizeCandidates(
      messages, compactingSessions, retryStates, queueStates, pendingSend,
    )
    for (const sid of candidateSids) {
      if (
        isGenerating(sid)
        || isCompacting(sid)
        || retryStates.value.has(sid)
        || queueStates.value.has(sid)
        || pendingSend.value.has(sid)
      ) {
        resetTransientStates(sid, reason)
      }
    }
  }

  /**
   * 统一瞬态状态收口 helper（W3）：一次性清理指定 session 的全部瞬态指示位。
   *
   * 背景：断连 / runtime 重启等异常路径下，compactingSessions / retryStates / queueStates
   * 不再有事件驱动清理（断连意味着不会再有 session.compacted / auto_retry_end / queue_update
   * 到达），若不主动清则永久残留（UI 卡「压缩中 / 重试中」）。
   *
   * 与 finalizeSession 的关系：finalizeSession 是消息流正常/异常收口（只清 streaming 实体 +
   * pendingSend + timer，保留 session 级独立状态如 compacting——compaction 由 session.compacted
   * 事件独立清，不能被消息收尾误清）。resetTransientStates 是更广的「断连兜底全清」，在
   * finalizeSession 基础上额外清 compacting / retry / queue。
   *
   * @param reason 透传给 finalizeSession 决定 message.status 终态映射（见 FinalizeReason）
   */
  function resetTransientStates(sessionId: string, reason: FinalizeReason = 'disconnect'): void {
    // 先走 finalizeSession 收口 streaming 实体 + 清 pendingSend + 清 timer（保留其幂等语义）
    finalizeSession(sessionId, reason)
    // 再清 session 级独立瞬态（断连兜底：这些态在断连后无事件驱动清理）
    clearIndependentTransient(sessionId, retryStates, queueStates, setCompacting)
  }

  // ── pendingSend 生命周期（useChat/effects 经 ctx/port 调）──

  /** send 前置位（填空窗）。不可变 Set add（保证响应式）。同时挂 pendingSendTimer（D-015）。 */
  function addPendingSend(sessionId: string): void {
    pendingSend.value = new Set(pendingSend.value).add(sessionId)
    clearPendingSendTimer(sessionId)
    pendingSendTimers.set(sessionId, setTimeout(() => {
      finalizeSession(sessionId, 'timeout')
      pendingSendTimers.delete(sessionId)
    }, PENDING_SEND_TIMEOUT_MS))
  }

  /** message_start（正常）/ finalizeSession（异常）/ abort（乐观）/ send.rejected（回滚）调。幂等。 */
  function clearPendingSend(sessionId: string): void {
    if (pendingSend.value.has(sessionId)) {
      const next = new Set(pendingSend.value)
      next.delete(sessionId)
      pendingSend.value = next
    }
    clearPendingSendTimer(sessionId)
  }

  function clearPendingSendTimer(sessionId: string): void {
    const timer = pendingSendTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      pendingSendTimers.delete(sessionId)
    }
  }

  // ── streaming timer（超时兜底）──

  /** message_start 挂载超时兜底（防 message.complete 永不到）。callback 调 finalizeSession('timeout')。 */
  function armStreamingTimer(sessionId: string): void {
    clearStreamingTimer(sessionId)
    streamingTimers.set(sessionId, setTimeout(() => {
      finalizeSession(sessionId, 'timeout')
      streamingTimers.delete(sessionId)
    }, STREAMING_TIMEOUT_MS))
  }

  /** 取消超时 timer（finalizeSession / store dispose 调） */
  function clearStreamingTimer(sessionId: string): void {
    const timer = streamingTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      streamingTimers.delete(sessionId)
    }
  }

  /**
   * session 级错误统一入口：追加 error assistant 消息 + finalizeSession。
   * 用于 session.exited（进程退出）/ error envelope（有 sessionId 时）/ restore 失败等场景。
   */
  function markSessionError(sessionId: string, errorText: string): void {
    const prev = messages.value.get(sessionId) ?? []
    const idx = findLastAssistantIndex(prev)
    if (idx >= 0 && prev[idx].status === 'streaming') {
      // streaming assistant → finalizeSession('error', errorText) 收口（合一逻辑）
      finalizeSession(sessionId, 'error', errorText)
    } else {
      // 无 streaming entity → 直接追加 error 消息
      commitMessages(messages, sessionId, [
        ...prev,
        { id: `a-${crypto.randomUUID()}`, role: 'assistant', content: errorText, status: 'error', timestamp: Date.now() },
      ])
      clearPendingSend(sessionId)
      clearStreamingTimer(sessionId)
    }
  }

  // store 作用域销毁时（HMR 热替换 / $dispose / 测试 teardown）清理 timer，
  // 避免回调操作已废弃的 store 实例 ref + warn 噪音。
  onScopeDispose(() => {
    for (const timer of pendingSendTimers.values()) clearTimeout(timer)
    pendingSendTimers.clear()
    for (const timer of streamingTimers.values()) clearTimeout(timer)
    streamingTimers.clear()
  })

  /**
   * 指定 session 是否正在压缩上下文（#6） */
  function isCompacting(sessionId: string): boolean {
    return compactingSessions.value.has(sessionId)
  }

  /** 设置压缩态（session.compacting→true / session.compacted→false），不可变 set 保证响应性 */
  function setCompacting(sessionId: string, value: boolean): void {
    const next = new Set(compactingSessions.value)
    if (value) next.add(sessionId)
    else next.delete(sessionId)
    compactingSessions.value = next
  }

  /**
   * 追加 system 提示行。委托 appendSystemNoticeImpl（模块级，控制 setup 行数）。
   * 与规则 #3「错误作为消息插入聊天流」一致：不用顶部 banner。
   */
  function appendSystemNotice(sessionId: string, text: string): void {
    appendSystemNoticeImpl(messages, sessionId, text)
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
    commitMessages(messages, sessionId, prev.slice(0, end))
  }

  /**
   * 清理指定 session 的全部 per-session 状态（deleteSession 调用，S3）。
   * 委托 disposeSessionImpl（模块级，控制 setup 函数行数）。
   */
  function disposeSession(sessionId: string): void {
    disposeSessionImpl(
      sessionId,
      [messages, retryStates, queueStates],
      [hydrated, pendingSend, compactingSessions, failedHistory],
      changeSetStatuses,
      [() => clearPendingSendTimer(sessionId), () => clearStreamingTimer(sessionId)],
    )
  }

  return {
    messages,
    pendingSend,
    compactingSessions,
    retryStates,
    queueStates,
    changeSetStatuses,
    failedHistory,
    hydrated,
    getMessages,
    getRetryState,
    getQueueState,
    getChangeSetStatus,
    setChangeSetStatus,
    markChangeSetsSuperseded,
    isHydrated,
    markHistoryFailed,
    clearHistoryError,
    hydrate,
    setMessages,
    applySubagentStreamDelta: (virtualId: string, lines: string[]) => applySubagentStreamDeltaImpl(messages, virtualId, lines),
    finalizeSubagentStream: (virtualId: string) => finalizeSubagentStreamImpl(messages, virtualId),
    appendUser,
    appendPending,
    markPendingDelivered,
    removePending,
    applyMessageEvent,
    isGenerating,
    isActive,
    finalizeSession,
    finalizeAllStreaming,
    resetTransientStates,
    addPendingSend,
    clearPendingSend,
    armStreamingTimer,
    markSessionError,
    isCompacting,
    setCompacting,
    appendSystemNotice,
    truncateFrom,
    applyFileChanges,
    disposeSession,
  }
})
