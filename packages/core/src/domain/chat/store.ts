/**
 * chat store factory（IF1）—— chat 域状态管理 SSOT（state + actions）。
 * 设计决策叙事（归位历史 / factory 模式 / 状态撕裂修复 / 响应式策略 / 流式块类型 /
 * FileChanges 通道 / 收口出口设计 / 子域控制器委托）见 ./README.md。
 * 本文件仅保留与代码行为直接绑定的短契约注释。
 */
import { computed, onScopeDispose, ref, shallowRef, type ComputedRef, type ShallowRef } from 'vue'
import { commitMessages, truncateMessagesFrom, prependHistory as prependHistoryMut } from './mutations'
import { truncateToolOutputBatch } from './truncate-tool-output'
import { dispatchMessageEvent } from './effects/registry'
import {
  applyEntry,
  createInitialChatViewState,
  type ChatViewState,
} from './apply-entry'
import {
  initTimers,
  clearSessionTimer,
} from './timers'
import { createStreamingStateMachine } from './streaming-state-machine'
import {
  touchLru as lruTouch,
  evictIfNeeded as lruEvictIfNeeded,
  evictSessionWithVirtual as lruEvictSession,
  makeLruEvictDeps,
  disposeLruEntry,
} from './lru'
import { findLastAssistantIndex } from './chunk-processor'
import { findLastStreamingBashIndex, markBashError, clearExecutingBash } from './bash-effects'
import { createChangeSetController } from './changeset'
import { createHandoffController } from './handoff'
import type {
  Message,
  PiEntry,
  PiMessageEntry,
  PiToolCallEntryForm,
  Segment,
  ServerMessage,
  SteerFollowUpMode,
  SubagentDirectiveData,
  ToolCall,
} from '@xyz-agent/shared'
import { normalizeContent, segmentsToText, SUBAGENT_DIRECTIVE_CUSTOM_TYPE } from '@xyz-agent/shared'
import type { RetryState, QueueState, FinalizeReason } from './store-types'
import { isDevMode } from '../../platform/dev-mode'

/**
 * pendingBuffer 单项（m1 数据层，steer/follow-up 暂存）。
 *
 * text 仅供 abortPending 文本匹配（RPC 失败回滚有准确原文——renderer 自己的提交，
 * 未经 pi skill 展开）。[W14] 投递定位不再按 text 匹配：pi 入队存展开后文本 ≠ 提交
 * 原文（D6），文本匹配在此场景必挂，改计数 FIFO（drainN 按条数取）。
 * segments 是原始 Segment[]，drain 时取出交 appendUser 进对话流（m2 接线，m1 不接）。
 * sendMode 区分 steer / follow-up，驱动气泡配色。
 */
interface PendingItem {
  text: string
  segments: Segment[]
  sendMode: SteerFollowUpMode
}

/**
 * streaming 超时默认值：10min。
 *
 * W6 调整：原 24h 形同虚设。降到 10min 作为 runtime pi watchdog（5min ABORT）之后的第二道 UI 兜底——
 * runtime watchdog 先检测 pi 卡死并自动 abort（广播 message.error），前端 streaming 超时只处理
 * runtime 自身也卡死的极端场景（runtime 主进程卡死时 watchdog 跑不了）。
 */
export const DEFAULT_STREAMING_TIMEOUT_MS = 600_000 // 10min

/**
 * [E-4] toolCall overlay 形态挂载到分区最后一条 assistant（subagent entry 帧消费，§6.1）。
 *
 * 模块级纯函数（输入输出均不可变构造）：与主对话流 message.tool_call_start effect 同语义，
 * 但目标分区无 message_start/delta overlay 链——挂载目标是 reducer 基线投影后的末位 assistant
 * （pi 事件序保证 tool_execution_* 晚于所属 assistant 的 message_end 定稿，基线已含该消息的
 * toolCalls 提取版 status:'completed'——overlay 改 running 是对「重放视角终态假设」的 live 修正）。
 * 幂等：同 toolCallId 已存在且已有终态（toolResult 已回填 output / error）→ no-op，防同帧
 * [toolCall form, toolResult] 交错下把回填终态倒退回 running。
 */
function attachRunningToolCall(prev: Message[], form: PiToolCallEntryForm): Message[] {
  const idx = findLastAssistantIndex(prev)
  if (idx < 0) return prev
  const host = prev[idx]!
  const callId = typeof form.toolCallId === 'string' ? form.toolCallId : `tc-${crypto.randomUUID()}`
  const existing = host.toolCalls?.find((t) => t.id === callId)
  if (existing && (existing.output !== undefined || existing.status === 'error')) return prev
  const toolCalls = existing
    ? host.toolCalls!.map((t) => (t === existing ? { ...t, status: 'running' as const } : t))
    : [
        ...(host.toolCalls ?? []),
        {
          id: callId,
          toolName: typeof form.toolName === 'string' ? form.toolName : 'tool',
          input: form.arguments ?? {},
          status: 'running',
          startTime: Date.now(),
        } satisfies ToolCall,
      ]
  const next = [...prev]
  next[idx] = { ...host, toolCalls }
  return next
}

/**
 * [steer-bubble u3 / docs/design/steer-followup-user-bubble-display.md D3]
 * 基线（服务端 getHistory 快照）与 live 分区的两步合并——reconcileHistory 与 hydrate
 * 共用同一函数（设计 U3：live ≡ reload，两条历史刷新入口语义同源）。
 *
 * 背景（F2）：切入 session 的 getHistory 存在一次本地 RPC 往返窗口——快照取得时消息
 * 未投递、返回前 pi 恰好投递（drain 帧 → appendUser 入流），旧快照整量替换会抹掉已
 * 显示的用户气泡（G4 违背）。
 *
 * 步骤① 尾部保护段收集：从分区尾向前收集「streaming assistant（pi 无对应 entry 的
 * 进行中实体，直接替换会让后续 text_delta 被守卫丢弃、流永久停滞）或 user
 * （piEntryId 缺失或不在基线 id 集——live overlay 的结构性特征：appendUser 剥除
 * piEntryId 且 id 为客户端 u-<uuid>，与基线 entry 派生 uuidv7 永不相等）」的连续段，
 * 遇其他已确认消息即停——已确认部分由基线接管（基线是准确相）。
 *
 * 步骤② user 正序-尾窗对齐去重：a = min(保护段 user 数 n, 基线尾部连续 user 数 k)，
 * 保护段**正数**第 1..a 条 ↔ 基线尾部正数第 k−a+1..k 条逐位对齐，对齐上的保护段
 * user 剔除（基线版本已含该消息），其余 n−a 条保留。方向依据：投递序 = 落盘序
 * （pi session 文件 appendFileSync 按投递序追加），基线滞后时缺的是尾部新消息
 * （后缀），对齐必然从保护段头部（先投递）对起。**不能倒序**：k < n 时倒序会把
 * 保护段最新条（基线没有）错配到基线最新条（较旧）——剔掉基线没有的、留下基线
 * 已有的，恰好双计反转（设计 D3 被否项）。
 *
 * 已知边界（设计 D3，可接受）：跨 turn 重发相同文本时数量对齐可能误剔新 overlay——
 * 表现为该消息暂以基线旧版本显示（位置在历史区），不丢消息不重复，新 entry 落盘后
 * 下一轮 reconcile 自然收敛。
 */
function mergeBaselineWithLive(baseline: Message[], partition: Message[]): Message[] {
  // 基线身份集：piEntryId 与 id 双收（user/assistant 消息带 piEntryId；system 族无
  // piEntryId 字段但 id 即 entry 派生 uuidv7——与 hydrate 锚取值 `piEntryId ?? id` 对称）。
  // 分区 user 的已确认判据 = 身份任一命中：piEntryId 命中覆盖真实基线投影（前轮
  // reconcile/hydrate 注入的消息），id 命中兜底同 id 形态；live overlay 的 u-<uuid> id
  // 与基线 uuidv7 是两个永不相等的 id 空间（mutations.ts prependHistory 同款论证），
  // 不会被误判已确认。
  const baselineIds = new Set<string>()
  for (const m of baseline) {
    if (m.piEntryId !== undefined) baselineIds.add(m.piEntryId)
    baselineIds.add(m.id)
  }
  const isConfirmed = (m: Message): boolean =>
    (m.piEntryId !== undefined && baselineIds.has(m.piEntryId)) || baselineIds.has(m.id)

  // 步骤①：尾部保护段（从尾向前，遇已确认消息即止）
  let cut = partition.length
  while (cut > 0) {
    const m = partition[cut - 1]!
    const isLiveStreaming = m.role === 'assistant' && m.status === 'streaming'
    const isUnconfirmedUser = m.role === 'user' && !isConfirmed(m)
    if (!isLiveStreaming && !isUnconfirmedUser) break
    cut--
  }
  const protectedSeg = partition.slice(cut)

  // 步骤②：user 正序-尾窗对齐去重（剔除保护段头部 a 条 user——它们已被基线尾部覆盖）
  let k = 0
  while (k < baseline.length && baseline[baseline.length - 1 - k]!.role === 'user') k++
  const protectedUserIdx: number[] = []
  for (let i = 0; i < protectedSeg.length; i++) {
    if (protectedSeg[i]!.role === 'user') protectedUserIdx.push(i)
  }
  const a = Math.min(protectedUserIdx.length, k)
  const alignedIdx = new Set(protectedUserIdx.slice(0, a))
  const keptTail = protectedSeg.filter((_, i) => !alignedIdx.has(i))
  return [...baseline.map((m) => ({ ...m })), ...keptTail]
}

/**
 * 读 streaming 超时阈值（D-003 阈值可配置 + D-016 IPC）。
 * [D-016] 经 IPC 读主进程 env（非 import.meta.env，Vite 不暴露 XYZ_ 前缀）。
 * 留在模块作用域以控制 setup 函数行数（max-lines-per-function）。
 *
 * [w4 归位] IPC 接线经 PlatformPort 注入属另一个 wave（标 TODO @platform-port-wave）。
 * 当前 const env = undefined（实际未读 window.electronAPI），返回 DEFAULT_STREAMING_TIMEOUT_MS。
 */
function readStreamingTimeoutMs(): number {
  // TODO @platform-port-wave: 接 IPC — window.electronAPI?.getStreamingTimeout?.()
  const env = undefined
  const parsed = env ? Number(env) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STREAMING_TIMEOUT_MS
}

/**
 * 构造 chat 域全部 state + actions（无参）。factory 模式与归位历史见 ./README.md。
 * 内部用 onScopeDispose（清 timer），调用方需在 effectScope 上下文内执行本 factory。
 */
export function createChatStore() {
  /** 按 sessionId 分区的消息表（UC-2 隔离） */
  // W10 D-1 容器范式：`ShallowRef<Map<string, ShallowRef<Message[]>>>`——外层 Map 恒等稳定
  // （只在增删 sid key 时替换），每 sid 持有独立内层 ShallowRef。同 sid commit 只替换该分区
  // 的内层 ref（commitMessages existing.value = next），A session 更新不触发依赖 B session
  // 分区的 watcher/computed 重算。写入全部走 commitMessages（见 mutations.ts）。
  // 浅代理边界对齐 ADR-0039：浅到「外层 Map + 每 sid 数组」两层，Message 对象不代理。
  const messages = shallowRef(new Map<string, ShallowRef<Message[]>>())
  /** 已 hydrate 的 session（避免切换时重复注入历史） */
  const hydrated = ref<Set<string>>(new Set())
  /**
   * 预期态：ack→message_start 空窗期的「用户已发起未确认」session 集合。
   * 取代 dispatchingSessionId（单值）。跨 session 顺序发送需要 Set（跨 panel 切换）。
   * 与 isGenerating 正交：add 在 send 前，delete 在 message_start（正常）/ finalizeSession（异常）。
   */
  const pendingSend = ref<Set<string>>(new Set())
  /** 正在压缩的 session 集合（#6：session.compacting/compacted 驱动，按 session 隔离）。
   *  membership 查询（isCompacting）用此 Set；streaming-state-machine 遍历 finalize 候选也用此 Set。 */
  const compactingSessions = ref<Set<string>>(new Set())
  /** compacting reason 平行表（M4：session.compacting{reason} 驱动，与 compactingSessions 同步维护）。
   *  区分手动（'manual'）/自动（'threshold'|'overflow'），驱动 MessageStream compacting 浮层文案。
   *  与 compactingSessions 同生共死：setCompacting 单点写入保证一致性。 */
  const compactingReasons = ref<Map<string, string>>(new Map())
  /** handingOff 瞬时态子域控制器（对称 compactingSessions），委托 chat-handoff.ts。设计见 ./README.md + chat-handoff.ts。 */
  const handoff = createHandoffController()
  const { handingOffSessions, isHandingOff, setHandingOff, clearHandingOffTimer } = handoff
  /** 按 sessionId 分区的自动重试态（W06-B，auto_retry_start/end） */
  const retryStates = ref<Map<string, RetryState>>(new Map())
  /** 按 sessionId 分区的消息队列态（W06-B，queue_update） */
  const queueStates = ref<Map<string, QueueState>>(new Map())
  /**
   * steer/follow-up 暂存缓冲（m1 数据层）。
   *
   * 与 messages 解耦——pushPending 只写本 buffer，不写 messages（pending 不进对话流）。
   * 投递信号 queue_update 到达时，drainN 按计数 FIFO 取出 segments 交 appendUser 进
   * 对话流（m2 接线，W14 计数 FIFO）。
   * 与 queueStates 同层 ref<Map<string, T>>，disposeSession 一并清理（T2）。
   *
   * [M4 queue 子域归位契约] queue 纯状态（queueStates pi 快照 + pendingBuffer 前端暂存）
   * 全部归位 core 本 store，renderer 无副本（stores/chat.ts 仅 defineStore 薄包装）。
   * flush/取消的编排（调 chatApi.send/steer）留在 renderer shell（useCompactQueue.ts），
   * core 只经 deps.getCompactQueue() 注入调用——core 域文件不 import renderer api。
   * 组件消费点唯一：QueueBubble 经 Composer → chatStore.getQueueState 读 queueStates；
   * CompactQueueBadge 经 useCompactQueue() 单例读 compact 暂存。pendingBuffer 属 drain
   * 恢复机制留在 store（SSOT 检查点 2 裁决：不强行并入统一视图）。
   */
  const pendingBuffer = ref<Map<string, PendingItem[]>>(new Map())
  /**
   * [steer-bubble u0 / docs/design/steer-followup-user-bubble-display.md D2]
   * per-session inflight 投递确认计数（Map 分区，对齐 queueStates/pendingBuffer 惯例，
   * 不可变写保证响应式）。
   *
   * 语义 = **已显示待确认的投递数**：steer/followUp 气泡已进对话流（腿 1 drain 消费）
   * 或 send 乐观插入，但其确认帧 message_end(user) 未到。不变式 inflight ≥ 0
   * （decrementInflight 钳制，配额漂移不产生负值）；正常路径逐投递归零——pi 投递
   * 时序保证 drain 帧先于 message_end，无欠账可累积。
   *
   * 三个维护点（本单元只建 state 与 action 面，不接线调用方——后续单元接）：
   * 1. 腿 1 消费：queue_update drain 帧 drainN 实取 m 条 → +m（drain 帧即投递证据，
   *    未显示的不确认，u2 接）
   * 2. send 乐观：appendUser 乐观插入 +1 / RPC 失败 catch 回滚 −1（挂 useChat send
   *    调用点，不在 appendUser 内防双计，u2 接）
   * 3. message_end(user) 确认：−1（inflight > 0 抵消跳过腿 2 兜底，u1 接）
   *
   * 清零挂点（D4 生命周期闭合）：abort（message.complete{stopReason:'aborted'}）与
   * disposeSession——pi 队列确定性作废后确认基线一并作废，防残留吞掉后续投递的确认
   * 配额。LRU 驱逐与断连收口**刻意不清**（D4 豁免，见 lruEvictDeps 处声明注释）。
   */
  const inflightCounts = ref<Map<string, number>>(new Map())
  /**
   * [W21] per-session reducer state（实时 feed 喂入 applyEntry 的累积态）。
   *
   * 实时路径（message_end / tool_call_end 重构 entry）与文件重放（get_entries →
   * replayEntries，hydrate 链）喂同一个 reducer——本 Map 是实时侧的累积 state，
   * 「live ≡ reload」从构造上成立（同 reducer 同输入序列必得同 state，等价性断言见
   * runtime src/__tests__/equivalence/live-reload.test.ts）。
   *
   * 非 Vue ref（[ADR-0049 例外]：factory 单例 Map，存的是纯投影数据非响应式业务状态，
   * 与 pendingSendTimers 同判据）：渲染不走它——实时渲染走 messages ref 的 overlay 路径
   * （message_start/delta/complete，streaming 语义）；本 state 是权威累积，供 W22
   * broadcast≡get_state 对账与后续 ref 收敛消费。disposeSession / LRU 驱逐同点清理。
   */
  const entryStates = new Map<string, ChatViewState>()
  /**
   * [W5 D5] per-session hydrate 尾窗锚（Map 分区，与 messages 同区生命周期）。
   *
   * 取值规则（写死）：hydrate 注入的尾窗首条消息的 `piEntryId ?? id`——user/assistant
   * 消息带 piEntryId（entry 派生 uuidv7）；system 族消息（bashExecution/compactionSummary/
   * custom/branchSummary）无 piEntryId 字段但 id 即 entry 派生 uuidv7（reducer
   * deriveBaseId：entry.id 优先），两侧取值对称。load-more（useChat.loadMoreHistory）
   * 据此在全量历史中定位切分点，只前插锚之前的段（见 mutations.splitHistoryBeforeAnchor）。
   *
   * // @data-owner #7 —— 权威源 = session 文件 entries（pi append-only，compaction 不改
   * entry id）；锚非缓存（无失效/无回写：唯一写方 = hydrate 一次性写入、重 hydrate 覆盖，
   * 唯一读方 = loadMoreHistory）。disposeSession / LRU 驱逐同点清理（随 hydrated 标记
   * 同生共死——驱逐重进后由重 hydrate 重建）。
   */
  const hydrateAnchors = new Map<string, string>()
  /** FileChanges 子域控制器（W10，ADR-0024 D5），委托 chat-changeset.ts。messages 由本 store 注入，设计见 ./README.md + chat-changeset.ts。 */
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
  /**
   * pendingSend 空窗期 timer（按 sessionId 隔离）。
   *
   * [ADR-0049 例外] 本 Map 不套 useSessionScopedState。判据：createChatStore() factory 由
   * renderer defineStore('chat', () => createChatStore()) 包装（renderer stores/chat.ts），
   * Pinia 按 store id 缓存——factory body 全应用只执行一次，本 Map 实质单例。factory 体内非
   * Vue setup 上下文（虽在 effectScope 内用 onScopeDispose，但无 sidRef: Ref<string|null>）；
   * Map 存的是 timer handle（ReturnType<typeof setTimeout>，非 reactive 业务状态）。
   * useSessionScopedState 是 setup-scoped 工厂（要求 sidRef + reactive 容器契约），factory
   * 体内不适用——强套需把 factory 改造成 setup composable（破坏 Pinia store 单例语义：
   * 每次 useStore() 重新执行会重建 Map 丢失单例）+ reactive 容器语义错位（timer handle 不是
   * 响应式状态）。与 lru/coordination/panel-orchestration 同属 ADR-0049 例外（单例性来源不同：
   * 那几处是模块级 ES module 单例，本处是 Pinia defineStore factory 单例）。session 销毁清理：
   * 本文件 onScopeDispose（见末尾）for + clearTimeout + clear；测试隔离：createChatStore()
   * per-instance（core 单测直接调 factory 构造新 store）。
   */
  const pendingSendTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // handingOff 超时兜底 timer + HANDING_OFF_TIMEOUT_MS 阈值内聚在 createHandoffController（chat-handoff.ts）

  // ── streaming 状态机深模块（B6：3 个原模块级状态机编排函数 + 2 个新提取的瞬态清理 helper 内聚为 factory，本 store 仅委托）──
  const streamingStateMachine = createStreamingStateMachine({
    messages,
    compactingSessions,
    handingOffSessions,
    retryStates,
    queueStates,
    pendingSend,
    setCompacting,
    setHandingOff,
  })

  // ── 派生态（D-3 per-session 惰性派生，D-005 语义保留）──

  /**
   * per-session streaming flag 惰性派生缓存（D-3，07 文档 §3.3.1(4)）。
   *
   * 取代旧 `streamingSessionIds` 全 Map 重扫 computed（R2：状态未变也 O(Σ消息) 重算的
   * 长对话卡顿放大器）。SSOT 仍是消息数组——每个 flag 是定义在其 sid 分区 ref 上的
   * computed（零 drift），惰性创建（没人问过的 session 不建不算），A session 的 token
   * 提交只失效 A 的 flag，B 的 flag 不重算。
   *
   * [生命周期] 本 Map 与 messages Map 同生共死：`disposeSession` 与 LRU 驱逐
   * （lru.deleteMessageKey）都删对应条目——这是 D-3 引入的唯一新增生命周期状态，
   * 漏删即慢泄漏（07 文档 §3.3.2 cleanup 契约）。
   */
  const sessionStreamingFlags = new Map<string, ComputedRef<boolean>>()

  /**
   * 指定 session 是否有 streaming assistant 实体（惰性派生，无 setter）。
   * 不变式：`isGenerating(sid) ≡ ∃ m ∈ messages[sid], m.role === 'assistant' && m.status === 'streaming'`。
   * 仅反映 assistant streaming——bash 消息（role:'system'）不计入（B1，见 ./README.md）。
   * 判定与旧 streamingSessionIds 逐字等价（仅扫 assistant + status==='streaming'）。
   */
  function isGenerating(sessionId: string): boolean {
    let flag = sessionStreamingFlags.get(sessionId)
    if (!flag) {
      flag = computed(() => {
        const arr = messages.value.get(sessionId)?.value ?? []
        return arr.some((m) => m.role === 'assistant' && m.status === 'streaming')
      })
      sessionStreamingFlags.set(sessionId, flag)
    }
    return flag.value
  }

  /** 活跃（派生）：`isActive(sid) ≡ isGenerating(sid) ∨ pendingSend.has(sid)`。驱动停止按钮 / steer guard / B 策略路由。 */
  function isActive(sessionId: string): boolean {
    return isGenerating(sessionId) || pendingSend.value.has(sessionId)
  }

  /** 取指定 session 的消息数组（空时返回空数组，不写入 Map）。D-1 后读内层 ref 的 .value（接口形状不变，消费方零改动） */
  function getMessages(sessionId: string): Message[] {
    return messages.value.get(sessionId)?.value ?? []
  }

  /** W3 H3：session 是否在 LRU 豁免集（streaming/pending/compacting/handoff 不驱逐，AC-9）。
   *  handingOff 并入（对称 compacting）：交接中 session 被 LRU 驱逐会清 messages，导致 UI
   *  显示「正在交接…」但对话内容消失（reviewer M3 对称性缺口）。 */
  const isLruExempt = (sid: string) => isGenerating(sid) || pendingSend.value.has(sid) || isCompacting(sid) || isHandingOff(sid)
  /** W3 H3：LRU recency 更新（AC-1 真 LRU），直接透传 lruTouch */
  const touchLru = lruTouch
  /**
   * 删除该 sid 的 changeSetStatuses 前缀条目（W19 review Fix-2 从 disposeSession 提取）。
   * key 格式 `${sessionId}:${messageId}`，按前缀过滤删除；两个消费点共用一份逻辑防 drift：
   * disposeSession（deleteSession 编排）+ LRU 驱逐（makeLruEvictDeps 注入，驱逐重进后
   * 历史 messageId 与残留 status key 异源，残留条目行为上碰巧 no-op 但 map 泄漏）。
   */
  function deleteChangeSetStatusesFor(sessionId: string): void {
    if (changeSetStatuses.value.size === 0) return
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
  /** LRU 驱逐依赖（setup 时构造一次复用，闭包经 getter 延迟读取无快照陈旧，详见 ./README.md）。
   *  D-3：deleteStreamingFlag 注入——deleteMessageKey 删 key 时同步清 streaming flag 派生缓存。
   *  W19 review Fix-2：deleteChangeSetStatusesFor 注入——删 messages 分区时同步清该 sid 的
   *  changeSetStatuses 前缀条目（此前仅 disposeSession 清理，LRU 驱逐不清 → map 泄漏）。
   *  W21：同回调内联清 entryStates 分区（reducer 累积态随 messages 分区同生共死——驱逐重进后
   *  由 hydrate 全量重放重建，残留旧累积会造成 W22 对账基线陈旧）。
   *  [steer-bubble D4 豁免声明] 本驱逐回调刻意**不**清 pendingBuffer / queueStates /
   *  inflightCounts——与「disposeSession 同点全清」的既有清理惯例不一致是有意为之
   *  （docs/design/steer-followup-user-bubble-display.md D4「刻意保留」）：这三者是不可
   *  重建状态（segments 暂存与 inflight 确认基线仅存在于前端，清了即永久丢失/漂移），
   *  且驱逐重进后腿 1 暂存与腿 2 判定仍依赖它们；entryStates/anchors/hydrated 是重建型
   *  （hydrate 重放可恢复）才随驱逐清理。断连收口（clearIndependentTransient）同理豁免
   *  pendingBuffer 与 inflight，见该处注释。后续维护勿按惯例顺手补清。 */
  const lruEvictDeps = makeLruEvictDeps(
    messages,
    hydrated,
    isLruExempt,
    (sid) => sessionStreamingFlags.delete(sid),
    (sid) => {
      deleteChangeSetStatusesFor(sid)
      entryStates.delete(sid)
      // [W5 D5] 锚随 hydrated 标记同点清理（驱逐重进后重 hydrate 覆盖重建，防陈旧锚）
      hydrateAnchors.delete(sid)
    },
  )
  /** W3 H3：LRU 驱逐（阈值触发）/ 显式驱逐（带虚拟 key）/ [M7] 单虚拟 key 删除 */
  function evictIfNeeded(): void { lruEvictIfNeeded(lruEvictDeps) }
  function evictSessionWithVirtual(sessionId: string): void { lruEvictSession(sessionId, lruEvictDeps) }
  function evictVirtualKey(virtualId: string): void { lruEvictDeps.deleteMessageKey(virtualId) }

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
   * 注入历史（首入 session）。W2 H3 截断回流（AC-10），W3 touchLru。
   *
   * [steer-bubble u3/D3] 未 hydrate 的分区也可能持有 live 实体（send 乐观插入 /
   * steer 投递 overlay 先于 hydrate 到达）——快照不含它们时整量替换会抹掉已显示
   * 气泡（F2 的首入窗口，G4）。与 reconcileHistory 走同一合并函数（设计 U3：
   * live ≡ reload，两条历史刷新入口语义同源）。分区为空时合并结果 = 基线本身，
   * 与旧的整量替换行为逐字等价。
   */
  function hydrate(sessionId: string, history: Message[]): void {
    if (hydrated.value.has(sessionId)) return
    const cur = messages.value.get(sessionId)?.value ?? []
    commitMessages(messages, sessionId, truncateToolOutputBatch(mergeBaselineWithLive(history, cur)))
    // [W5 D5] hydrate 尾窗锚：hydrate 守卫保证每 session 只在此写一次；
    // disposeSession / LRU 驱逐清 hydrated 后重 hydrate 到这里 → set 覆盖旧锚。
    // 空 history（新 session）不记锚——此时无 load-more（truncated=false），锚缺失走兜底。
    // [steer-bubble u3] 锚取**基线**首条（非 merged 首条）：合并追加的尾部保护段是
    // live 实体（客户端 id，非文件侧身份），锚是 load-more 对全量历史的切分依据，
    // 必须锚定在文件侧消息上。
    const anchorMsg = history[0]
    if (anchorMsg) hydrateAnchors.set(sessionId, anchorMsg.piEntryId ?? anchorMsg.id)
    hydrated.value = new Set(hydrated.value).add(sessionId)
    lruTouch(sessionId) // W3: LRU recency
  }

  /** [W5 D5] 读 hydrate 尾窗锚（loadMoreHistory 唯一读方；未 hydrate / 空历史 → undefined）。 */
  function getHydrateAnchor(sessionId: string): string | undefined {
    return hydrateAnchors.get(sessionId)
  }

  /**
   * 切入 reconcile：entry 历史（服务端 getHistory 快照）与 live 分区合并。
   *
   * [背景 session-reconcile 2026-08-22] 后台 session（agent-managed 子 session）在
   * 前端不在场时推进/完成 turn——hydrate 的一次性守卫会让切入后的新 entry 永不出现
   * （最后输出看不到）；且 pi entries 不含进行中消息（entry 完成才 append），直接
   * 替换会抹掉 live streaming 实体 → 后续 text_delta 被 isLastAssistantStreaming
   * 守卫丢弃 → 流永久停滞。合并方向（登记表 #7 切入 reconcile 规则）：
   * **entry 历史为基线，分区尾部 streaming 实体追加其后**（live 真相优先于 entry 快照）。
   *
   * - 未 hydrate → 等价 hydrate（原语义：合并注入 + 锚 + 标记）
   * - 已 hydrate → 基线替换 + 保留尾部保护段（streaming assistant + 未确认 user，
   *   [steer-bubble u3/D3] 两步合并：尾部保护段收集 + user 正序-尾窗对齐去重，见
   *   mergeBaselineWithLive——快照滞后窗口不丢已投递气泡、不双计；turn 已结束（无
   *   保护段）则纯刷新到最新 entries
   */
  function reconcileHistory(sessionId: string, history: Message[]): void {
    if (!hydrated.value.has(sessionId)) {
      hydrate(sessionId, history)
      return
    }
    const cur = messages.value.get(sessionId)?.value ?? []
    const merged = mergeBaselineWithLive(history, cur)
    commitMessages(messages, sessionId, truncateToolOutputBatch(merged))
    lruTouch(sessionId) // W3: LRU recency（切入刷新视同活跃访问）
  }

  /** 直接覆盖某 session 的消息（subagent 虚拟 session 用，不受 hydrated 守卫；回流路径截断 AC-10/D9）。 */
  function setMessages(sessionId: string, history: Message[]): void {
    const cloned = truncateToolOutputBatch(history.map((m) => ({ ...m })))
    commitMessages(messages, sessionId, cloned)
  }

  /** W4 H4：全量历史去重合并到头部（加载更多）。截断 + 委托 chat-mutations。 */
  function prependHistory(sessionId: string, fullHistory: Message[]): void {
    prependHistoryMut(messages, sessionId, truncateToolOutputBatch(fullHistory.map((m) => ({ ...m }))))
  }

  /**
   * 追加 user 消息（Segment[]，ADR-0043）。返回 id：useChat 用作 clientUuid 建立重开回填映射
   * （prompt 标记 `<!--xyz:msg:u-<uuid>-->` + segments sidecar 主键——extension TAG 正则锚定
   * `u-[0-9a-fA-F-]{36}` 形态，@zhushanwen/pi-msg-id-mapper）。
   *
   * [W2 fix-chat-flow-order D6 → 后修 overlay-only] 消息形态从 user message entry 派生（形态
   * 对照 apply-entry user 分支——segments 原样放 message.content，applyEntry 空态派生），但
   * **不喂 reducer**：reducer 的 user entry 唯一来源 = 真实 message_end(user) 帧（见实现内
   * 注释——乐观 entry 也喂会双计，W22 等价性测试捕获）。乐观 send 与 drainN 投递两个调用方
   * 零改动，返回值保持 `u-<uuid>` 形态（clientUuid 映射链不断）。
   *
   * overlay content 覆写回原 segments：entry 反解 content 是纯文本窄化
   * （skill/file/mention/image badge 不可从 entry 重放推导——重开侧由 segments sidecar +
   * clientUuidMap 回填，textToSegments 已知限制），live 渲染层必须保留原始 segments；
   * 引用原样透传（drainN FIFO 取出的 segments 原引用直接进消息流）。
   * piEntryId 同点剥除（见实现内注释：客户端 entry id 非真实 pi entry id，防 fork 误定位）。
   */
  function appendUser(sessionId: string, segments: Segment[]): string {
    const entry: PiMessageEntry = {
      type: 'message',
      id: `u-${crypto.randomUUID()}`,
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: segments, timestamp: Date.now() },
    }
    // [W2 后修] overlay-only：不喂 reducer（applyEntryFrame）。reducer 的 user entry 唯一来源 =
    // 真实 message_end(user) 帧（权威、无客户端 id → 位置派生，与重放天然同构——live≡reload
    // 对 user 类型经权威帧成立）。乐观 entry 若也喂 reducer，同一条 user 消息双计（W22 等
    // 价性测试捕获；steer 场景 pi 展开文本与乐观 segments 内容失配，内容/替换式去重均不可靠）。
    // ref 消息形态仍从 entry 派生（与 replay 产物同构的构造保证），id = entry.id 派生的
    // u-<uuid>（clientUuid 契约不变）。
    // piEntryId 剥除：reducer 会把 entry.id 回填为 piEntryId，但乐观 entry 的 id 是客户端
    // 生成（u-<uuid>）非真实 pi entry id——带着假值会改变 fork 截断行为（useForkActions
    // 按 piEntryId 精确定位，原直插路径无此字段走 timestamp+role JSONL 匹配兜底）。
    const derived = applyEntry(createInitialChatViewState(), entry)
    const { piEntryId: _clientEntryId, ...derivedMsg } = derived.messages[derived.messages.length - 1]!
    const prev = messages.value.get(sessionId)?.value ?? []
    commitMessages(messages, sessionId, [...prev, { ...derivedMsg, content: segments }])
    return derivedMsg.id
  }

  /**
   * 暂存 steer/follow-up segments 到 pendingBuffer（m1 数据层）。
   *
   * 不碰 messages——pending 不进对话流（核心目标）。投递时 drainN 按计数 FIFO 取出
   * segments 交 appendUser（m2 接线）。text = segmentsToText(segments).trim()，仅供
   * abortPending 文本匹配（W14：投递不再依赖 text）。
   */
  function pushPending(sessionId: string, segments: Segment[], sendMode: SteerFollowUpMode): void {
    const text = segmentsToText(segments).trim()
    const prev = pendingBuffer.value.get(sessionId) ?? []
    pendingBuffer.value = new Map(pendingBuffer.value).set(sessionId, [...prev, { text, segments, sendMode }])
  }

  /**
   * [W14] 计数 FIFO：按入队顺序取出 sendMode 匹配的前 n 条 pending（D1 表末行 + D6）。
   *
   * 投递定位不再按文本匹配——pi 入队存 skill 展开后文本 ≠ 提交原文，文本相等匹配在该
   * 场景必挂（消息永久丢失）；queue_update 差集（registry countDrained）算出被投递条数
   * N，本方法直接取前 n 条，不看文本。FIFO 与 pi splice 移除顺序一致。
   *
   * n 超过匹配存量时取尽即止（n 截断到存量）——扩展注入例外下队列深度可大于前端暂存
   * （见 reconcilePending），取尽即止保证队列清空时暂存同步清零、偏差收敛。
   * 非 sendMode 匹配的项保留原相对顺序（steer 与 follow-up 各自差集各自计数，防跨类型误取）。
   */
  function drainN(sessionId: string, sendMode: SteerFollowUpMode, n: number): Segment[][] {
    const prev = pendingBuffer.value.get(sessionId)
    if (!prev || prev.length === 0 || n <= 0) return []
    const drained: Segment[][] = []
    const remaining: PendingItem[] = []
    for (const item of prev) {
      if (drained.length < n && item.sendMode === sendMode) drained.push(item.segments)
      else remaining.push(item)
    }
    pendingBuffer.value = new Map(pendingBuffer.value).set(sessionId, remaining)
    return drained
  }

  /**
   * [W14] 深度结构性对账（D6：深度权威 = pi pendingMessageCount）。
   *
   * 不变式：renderer 提交数 − pi 队列深度 = 已投递数，pendingBuffer 存量 = 提交数 −
   * 已投递数 = 深度。每帧 queue_update（drain 处理后）对账 pendingBuffer 长度 vs 深度：
   * - buffer > 深度：队列中已不存在的暂存（僵尸项——永不被投递且污染后续 FIFO 计数），
   *   裁剪到深度（保留最早的，与 FIFO 取出顺序一致）。
   * - buffer < 深度：pi 队列存在 renderer 未提交的条目（扩展 deliverAs 注入，D6 已知
   *   例外——xyz 自研扩展禁用，第三方扩展残余风险）——无法凭空补 segments，接受有界
   *   偏差；队列清空时 drainN 取尽即止，结构偏差随之收敛，内容偏差由 queue_update
   *   全量数组（queueStates 整体替换）收敛。
   */
  function reconcilePending(sessionId: string, depth: number): void {
    const prev = pendingBuffer.value.get(sessionId)
    if (!prev || prev.length <= depth) return
    pendingBuffer.value = new Map(pendingBuffer.value).set(sessionId, prev.slice(0, depth))
  }

  /**
   * 移除匹配的 pending item（m1 数据层，steer/followUp RPC 失败回滚）。
   *
   * [W14 D6 差异标注] 保留文本匹配（normalizeContent + trim 归一化）：回滚场景有准确
   * 原文——renderer 自己的提交原文（未经 pi skill 展开），且不走 pi 队列投递路径，文本
   * 相等在此可靠；投递定位已改计数 FIFO（drainN，登记表 D6 条目标注此差异）。
   * FIFO 移除第一条匹配项；无匹配 no-op（幂等）。sendMode 必填——abort 明确指定回滚的目标模式。
   */
  function abortPending(sessionId: string, text: string, sendMode: SteerFollowUpMode): void {
    const prev = pendingBuffer.value.get(sessionId)
    if (!prev || prev.length === 0) return
    const target = normalizeContent(text).trim()
    const idx = prev.findIndex(
      (item) => normalizeContent(item.text).trim() === target
        && item.sendMode === sendMode,
    )
    if (idx === -1) return
    pendingBuffer.value = new Map(pendingBuffer.value).set(sessionId, prev.filter((_, i) => i !== idx))
  }

  // ── inflight 投递确认计数（[steer-bubble u0/D2] 契约层：state 见上，调用方接线归 u1/u2）──

  /** 读 per-session inflight 计数。无记录 = 0（归零即删条目，正常路径 Map 多数时间无该 sid）。 */
  function getInflight(sessionId: string): number {
    return inflightCounts.value.get(sessionId) ?? 0
  }

  /**
   * inflight += n（默认 1）。腿 1 消费按 drainN 实取数传 m（u2），send 乐观 +1（u2）。
   * n ≤ 0 no-op——实取数为 0（drain 差集 > 0 但暂存无匹配货）时不产生零值条目。
   */
  function incrementInflight(sessionId: string, n = 1): void {
    if (n <= 0) return
    inflightCounts.value = new Map(inflightCounts.value).set(sessionId, getInflight(sessionId) + n)
  }

  /**
   * inflight -= n（默认 1）。message_end(user) 确认 −1（u1）/ send 失败回滚 −1（u2）。
   * 钳制到 0（不变式 ≥ 0）：负值在「inflight > 0」判定上行为与 0 等同，钳制保证值域
   * 始终符合语义声明。归零即删条目（Map 不积累零值）。
   */
  function decrementInflight(sessionId: string, n = 1): void {
    if (n <= 0) return
    const next = Math.max(0, getInflight(sessionId) - n)
    if (next === 0) clearInflight(sessionId)
    else inflightCounts.value = new Map(inflightCounts.value).set(sessionId, next)
  }

  /**
   * inflight 清零（abort / disposeSession 挂点，D4：pi 队列确定性作废 → 确认基线整体
   * 作废）。幂等。
   */
  function clearInflight(sessionId: string): void {
    if (!inflightCounts.value.has(sessionId)) return
    const next = new Map(inflightCounts.value)
    next.delete(sessionId)
    inflightCounts.value = next
  }

  /**
   * [W21] 重构 entry 喂 per-session reducer state（applyEntry）——实时 feed 与文件重放
   * （hydrate 链的 replayEntries）喂同一个 reducer。
   *
   * 本语义：纯累积（权威镜像），不直接投影 messages ref——实时渲染走 overlay 路径
   * （message_start/delta/complete + tool_call_start/end 的 effect，streaming 态语义
   * reducer 无法表达：running toolCall / delta 累积；例外——user 消息 [W2] 已 entry 化，
   * appendUser 构造 user entry 经本方法喂入 + overlay 投影，乐观 user 插入自此落入
   * reducer 可表达域）。ref 与 reducer state 的收敛（对账投影）归 W22 broadcast≡get_state
   * 全量化。纯度：applyEntry 纯函数（copy-on-write），同 entry 序列必得同 state——
   * 「live ≡ reload」在构造上成立。
   */
  function applyEntryFrame(sessionId: string, entry: PiEntry): void {
    const cur = entryStates.get(sessionId) ?? createInitialChatViewState()
    entryStates.set(sessionId, applyEntry(cur, entry))
  }

  /**
   * [E-4] subagent entry 帧消费（subagent-realtime-channel §6.1/§6.2）：虚拟分区喂
   * applyEntry + 基线投影 + toolCall overlay。
   *
   * 输入 = session.subagentEntriesAppended 帧的 entries（PiEntry 与 PiToolCallEntryForm
   * 混合，形态与主对话流 message.message_end / tool_call_* 帧的 entry 同构）。三步：
   * 1. PiEntry 逐条喂 reducer（applyEntryFrame，toolResult 的 deliveredToolResultIds
   *    幂等去重继承；与 reload 腿（getSubagentHistory）喂同一 reducer——live ≡ reload
   *    构造性成立的 relay 侧锚点，等价性断言见 runtime __tests__/equivalence/relay-live-reload）。
   * 2. 基线投影：reducer state.messages 整体替换分区 ref（copy + truncate，对齐 setMessages
   *    形态）。定稿是权威：stream_delta 打字机中间态（applySubagentStreamDelta 建的 sa-*
   *    streaming 实体）被定稿取代（§6.2 覆盖语义）。已知限制：基线只含本连接存续期间的
   *    live entry——丢帧后经 fetchAndInject 快照补齐的头部会被下一次投影替换掉，靠重开
   *    drawer 重新快照自愈（与 W22 对账收敛前的主对话流 ref/reducer 分离同等程度的临时态）。
   * 3. toolCall overlay：running toolCall 挂末位 assistant（attachRunningToolCall，帧内
   *    toolResult 先处理时幂等跳过）。
   *
   * store 不互 import 铁律：本方法经 routeInbound InboundEffects 回调链消费
   * （renderer useMessageEffects 注入），subagent 虚拟分区 id 由调用方经 shared 工厂构造。
   */
  function applySubagentEntries(virtualId: string, entries: Array<PiEntry | PiToolCallEntryForm>): void {
    // PiEntry 先喂 reducer（fold 顺序敏感：assistant 定稿 → toolResult 的窗口配对回填依赖顺序）
    for (const entry of entries) {
      if (entry.type !== 'toolCall') applyEntryFrame(virtualId, entry)
    }
    // 基线投影（无 PiEntry 的纯 toolCall 帧不触发投影——分区保持，overlay 直接操作 ref）
    const state = entryStates.get(virtualId)
    if (state) {
      commitMessages(messages, virtualId, truncateToolOutputBatch(state.messages.map((m) => ({ ...m }))))
    }
    // toolCall overlay 后置：基于投影后分区操作，保证挂载目标是基线末位 assistant
    for (const form of entries) {
      if (form.type !== 'toolCall') continue
      const prev = messages.value.get(virtualId)?.value ?? []
      commitMessages(messages, virtualId, attachRunningToolCall(prev, form))
    }
  }

  /** message.* 事件单一入口（F2 消除 double-dispatch）：经 dispatchMessageEvent 查 effects/registry.ts 执行全部副作用。非 message.* / 未注册 type no-op。重构等价性见 ./README.md。 */
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
        armBashTimer,
        clearBashTimer,
        appendUser,
        drainN,
        reconcilePending,
        applyEntryFrame,
        getInflight,
        incrementInflight,
        decrementInflight,
        clearInflight,
      },
      sessionId,
      msg,
    )
  }

  // ── 收口出口（唯一，D-007 真收口非翻 flag）──

  /**
   * session 级统一收口：streaming 实体推终态 + 清 pendingSend + 清 timer。幂等（D-010 sealed）。
   * @param reason 决定 message.status + toolCall.status 终态映射（见 FinalizeReason）
   */
  function finalizeSession(sessionId: string, reason: FinalizeReason, errorText?: string): void {
    streamingStateMachine.finalizeMessages(sessionId, reason, errorText)
    // 清 pendingSend + streaming timer（bash timer 不清：W1 timer-decouple 解耦，bash timer 由
    // bashResultEffect/markBashError/finalizeBashOnly 独立清，不应被 assistant 收口误清）。
    // [M2 PR#116 review] clearStreamingTimer 此前被误删：正常 message.complete 路径不再清
    // streaming timer，10min 后 timer 仍会触发 finalizeSession('timeout')，造成已 complete 的
    // turn 被二次收口（幂等无功能损害，但浪费一次 finalize 调用 + DEV warn 噪音）。
    clearPendingSend(sessionId)
    clearStreamingTimer(sessionId)
    // 收口日志：仅异常 reason 打 dev warn（保留诊断价值），normal/aborted 正常路径不打（去长对话噪音）
    if (isDevMode() && reason !== 'normal' && reason !== 'aborted') console.warn(`[chat] finalizeSession sid=${sessionId} reason=${reason}`)
  }

  /** bash timer 专用收口（W1 timer-decouple，C2 回归防护）：只把 streaming bash 消息推 error 态，**不**清 streaming timer / pendingSend / 调 finalizeSession。幂等（无 streaming bash 时 no-op）。背景见 ./README.md。 */
  function finalizeBashOnly(sessionId: string): void {
    const prev = messages.value.get(sessionId)?.value ?? []
    // [S7] 复用 findLastStreamingBashIndex，与 bashResultEffect/markBashError 一致。
    const realIdx = findLastStreamingBashIndex(prev, sessionId)
    if (realIdx === -1) return
    const next = prev.map((m, i) => i === realIdx ? {
      ...m,
      status: 'error' as const,
      bashExecution: { ...m.bashExecution!, cancelled: true },
      error: 'timeout',
    } : m)
    commitMessages(messages, sessionId, next)
  }

  /**
   * 多 session 统一收口（断连 / runtime 重启兜底）：遍历瞬态 session，逐个调 resetTransientStates。
   * 遍历范围是 messages.keys() ∪ compactingSessions ∪ retryStates ∪ queueStates 并集
   *（不能只遍历 messages——compacting/retry/queue 可独立于消息存在）。详见 ./README.md。
   */
  function finalizeAllStreaming(reason: FinalizeReason): void {
    const candidateSids = streamingStateMachine.collectFinalizeCandidates()
    for (const sid of candidateSids) {
      if (isGenerating(sid) || isCompacting(sid) || isHandingOff(sid) || retryStates.value.has(sid) || queueStates.value.has(sid) || pendingSend.value.has(sid)) {
        resetTransientStates(sid, reason)
      }
    }
  }

  /**
   * 统一瞬态状态收口 helper（W3）：finalizeSession（消息流收口）+ 额外清 compacting / retry / queue
   * 瞬态（断连后无事件驱动清理）。与 finalizeSession 的边界详见 ./README.md。
   * @param reason 透传给 finalizeSession 决定 message.status 终态映射（见 FinalizeReason）
   */
  function resetTransientStates(sessionId: string, reason: FinalizeReason = 'disconnect'): void {
    // 先走 finalizeSession 收口 streaming 实体 + 清 pendingSend + 清 timer（保留其幂等语义）
    finalizeSession(sessionId, reason)
    // 再清 session 级独立瞬态（断连兜底：这些态在断连后无事件驱动清理）
    streamingStateMachine.clearIndependentTransient(sessionId)
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
    clearSessionTimer(pendingSendTimers, sessionId)
  }

  // ── timer（streaming + bash）：从 chat-timers.ts 提取，闭包注入 finalizeSession ──
  const { armStreamingTimer, clearStreamingTimer, armBashTimer, clearBashTimer, disposeAllTimers } = initTimers(finalizeSession, finalizeBashOnly, STREAMING_TIMEOUT_MS)

  /**
   * session 级错误统一入口：追加 error assistant 消息 + finalizeSession。
   * 用于 session.exited（进程退出）/ error envelope（有 sessionId 时）/ restore 失败等场景。
   */
  function markSessionError(sessionId: string, errorText: string): void {
    const prev = messages.value.get(sessionId)?.value ?? []
    const idx = findLastAssistantIndex(prev)
    if (idx >= 0 && prev[idx].status === 'streaming') {
      finalizeSession(sessionId, 'error', errorText)
      return
    }
    // 无 streaming entity → 直接追加 error 消息
    commitMessages(messages, sessionId, [
      ...prev,
      { id: `a-${crypto.randomUUID()}`, role: 'assistant', content: errorText, status: 'error', timestamp: Date.now() },
    ])
    clearPendingSend(sessionId)
    clearStreamingTimer(sessionId)
  }

  // store 作用域销毁时（HMR 热替换 / $dispose / 测试 teardown）清理 timer，
  // 避免回调操作已废弃的 store 实例 ref + warn 噪音。
  onScopeDispose(() => {
    for (const timer of pendingSendTimers.values()) clearTimeout(timer)
    pendingSendTimers.clear()
    disposeAllTimers()
    handoff.clearAllTimers()
  })

  /**
   * 指定 session 是否正在压缩上下文（#6） */
  function isCompacting(sessionId: string): boolean {
    return compactingSessions.value.has(sessionId)
  }

  /** 设置压缩态（session.compacting{reason}→true / session.compacted→false）。
   *  不可变写保证响应性。reason 在 value=true 时挂入 compactingReasons（驱动文案），
   *  value=false 时随 membership 一起清。Set 与 Map 同生共死，单点写入保证一致性。 */
  function setCompacting(sessionId: string, value: boolean, reason?: string): void {
    const nextSet = new Set(compactingSessions.value)
    const nextMap = new Map(compactingReasons.value)
    if (value) {
      nextSet.add(sessionId)
      nextMap.set(sessionId, reason ?? '')
    } else {
      nextSet.delete(sessionId)
      nextMap.delete(sessionId)
    }
    compactingSessions.value = nextSet
    compactingReasons.value = nextMap
  }

  /** 读取 compacting reason（手动 'manual' / 自动 'threshold'|'overflow'），未在压缩时返回 undefined。
   *  MessageStream 据此切文案：手动→compressing / 自动→autoCompressing。 */
  function getCompactingReason(sessionId: string): string | undefined {
    return compactingReasons.value.get(sessionId)
  }

  // isHandingOff / setHandingOff / clearHandingOffTimer 委托 createHandoffController（chat-handoff.ts）。

  /** 追加 system 提示行（与规则 #3「错误作为消息插入聊天流」一致：不用顶部 banner）。 */
  const appendSystemNotice = (sessionId: string, text: string): void => {
    const prev = messages.value.get(sessionId)?.value ?? []
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
   * 追加 subagent 定向消息气泡（`@` 定向对话 live 链路，composer-symbol-system §3.3.3a）。
   *
   * 消息形态与 reload 链路逐字段对齐（live ≡ reload，关键规则 9）：reload 侧由
   * mapSessionEntries 对 subagent-directive custom_message 覆写 display:true →
   * applyCustomMessageEntry 投影出同字段 Message（role:'system' + customType + content +
   * details + display:true）。live 侧消费 subagent.directive 广播时经本方法构造——
   * id 用 `cm-<uuid>`（对齐 message.customStart effect 的客户端 id 先例；reload 侧为 pi
   * 持久化 entry id，id 值异源属 W21 已裁决的 live/reload 差异类），timestamp 客户端时钟。
   *
   * 为什么不走 applyEntryFrame：同一 custom entry 的 display:false 形态已经
   * message.customStart → applyEntryFrame 喂过 reducer（U2c 契约：generic 通路不可见），
   * 再喂会重复 append；可见气泡是消费侧覆写产物，overlay 插入（与 appendSystemNotice
   * 同款）不污染 reducer 累积态。
   */
  const appendSubagentDirective = (sessionId: string, data: SubagentDirectiveData): void => {
    const prev = messages.value.get(sessionId)?.value ?? []
    commitMessages(messages, sessionId, [
      ...prev,
      {
        id: `cm-${crypto.randomUUID()}`,
        role: 'system',
        customType: SUBAGENT_DIRECTIVE_CUSTOM_TYPE,
        content: data.text,
        details: { subagentId: data.subagentId, slug: data.slug, direction: data.direction },
        display: true,
        status: 'complete',
        timestamp: Date.now(),
      },
    ])
  }

  /** 截断 session 消息到 messageId（编辑重发用）。委托 chat-mutations.truncateMessagesFrom。 */
  const truncateFrom = (sessionId: string, messageId: string, inclusive: boolean): void => truncateMessagesFrom(messages, sessionId, messageId, inclusive)

  /** 清理指定 session 的全部 per-session 状态（deleteSession 调用，S3）：messages/hydrated/pendingSend/compactingSessions/retryStates/queueStates/failedHistory/changeSetStatuses + timer + LRU 记录。背景见 ./README.md。 */
  function disposeSession(sessionId: string): void {
    // Map ref：不可变写保证响应式（new Map + delete + 赋值新 Map）。
    // D-1 后 messages 的 Map entry 是 per-session ShallowRef 分区——本循环删的是 Map entry
    // （该 sid 分区连同其内层 ref 整体移除），减 key 属外层 Map 合法替换情形（07 §3.3.2）。
    // retryStates/queueStates 是深 ref，此写法同样正确触发。统一用"构造新 Map → delete → 赋值"范式。
    // 显式结构类型（对齐原 disposeSession 编排参数）：数组元素统一为 Map<string, unknown>，
    // 避免 TS 将不同 Map 元素推断为具体联合类型导致 new Map(ref.value) 不兼容。
    // inflightCounts（[steer-bubble D4]）：disposeSession 同步清 inflight——确认基线随分区
    // 销毁作废（与 LRU 驱逐的刻意豁免不同，见 lruEvictDeps 处声明注释）。
    const mapRefs: { value: Map<string, unknown> }[] = [messages, retryStates, queueStates, pendingBuffer, inflightCounts, compactingReasons]
    const setRefs: { value: Set<string> }[] = [hydrated, pendingSend, compactingSessions, handingOffSessions, failedHistory]
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
    // （W19 review Fix-2 提取为 deleteChangeSetStatusesFor，与 LRU 驱逐共用一份逻辑）
    deleteChangeSetStatusesFor(sessionId)
    // [W21] reducer 累积态分区同点清理（与 LRU 驱逐的 deleteMessageKey 内联清理同语义）
    entryStates.delete(sessionId)
    // [W5 D5] hydrate 尾窗锚同点清理（唯一写方 hydrate 已随 hydrated 守卫失效，锚无独立存活意义）
    hydrateAnchors.delete(sessionId)
    // [D3 closure] executingBash ephemeral 分区同点清理（bash-effects 模块级 Map 挂接本
    // 编排——session 删除无残留；形态定案理由见 bash-effects.ts 文件头注释）
    clearExecutingBash(sessionId)
    // D-3 生命周期：streaming flag 惰性派生缓存随 messages 分区同点清理（漏删即慢泄漏，
    // 07 文档 §3.3.2 cleanup 契约）。
    sessionStreamingFlags.delete(sessionId)
    // timer 清理（模块级 Map，非响应式）
    for (const clear of [() => clearPendingSendTimer(sessionId), () => clearStreamingTimer(sessionId), () => clearBashTimer(sessionId), () => clearHandingOffTimer(sessionId)]) clear()
    disposeLruEntry(sessionId) // R5: 清理 LRU 时序记录，防止内存泄漏
  }

  return {
    messages,
    pendingSend,
    compactingSessions,
    handingOffSessions,
    retryStates,
    queueStates,
    pendingBuffer,
    inflightCounts,
    changeSetStatuses,
    failedHistory,
    hydrated,
    getMessages,
    getRetryState, getQueueState,
    getChangeSetStatus, setChangeSetStatus,
    markChangeSetsSuperseded,
    isHydrated, markHistoryFailed, clearHistoryError,
    hydrate, setMessages, reconcileHistory,
    getHydrateAnchor,
    prependHistory,
    applySubagentStreamDelta: (virtualId: string, lines: string[]) => streamingStateMachine.applySubagentStreamDelta(virtualId, lines),
    finalizeSubagentStream: (virtualId: string) => streamingStateMachine.finalizeSubagentStream(virtualId),
    applySubagentEntries,
    appendUser,
    pushPending,
    drainN,
    reconcilePending,
    abortPending,
    getInflight,
    incrementInflight,
    decrementInflight,
    clearInflight,
    applyMessageEvent,
    isGenerating,
    isActive,
    finalizeSession,
    finalizeAllStreaming,
    resetTransientStates,
    addPendingSend,
    clearPendingSend,
    armStreamingTimer,
    armBashTimer,
    clearBashTimer,
    markSessionError,
    isCompacting,
    setCompacting,
    getCompactingReason,
    isHandingOff,
    setHandingOff,
    appendSystemNotice,
    appendSubagentDirective,
    truncateFrom,
    applyFileChanges,
    disposeSession,
    // w5 chat-use-chat：abortBash RPC 失败兼底（找最后 streaming bash 消息标 error 态）。
    // store 持有自己的 messages ref，useChat 经此方法调用不碰 ref（解耦 pinia Store/factory
    // 产物的 messages 类型鸿沟：pinia Store.messages 被解包为 Map，factory 产物为 ShallowRef）。
    markStreamingBashError: (sessionId: string, errorText: string) =>
      markBashError(messages, sessionId, errorText, clearBashTimer),
    /** 测试专用：暴露 D-3 streaming flag 惰性派生缓存（断言 disposeSession/LRU 驱逐的清理语义用，生产代码勿读）。 */
    _sessionStreamingFlagsForTest: sessionStreamingFlags,
    /** 测试专用：暴露 [W21] per-session reducer 累积态（断言 applyEntryFrame 喂入/清理语义用，生产代码勿读——W22 对账消费前不设正式读口）。 */
    _entryStatesForTest: entryStates,
    // W3 H3 LRU
    touchLru,
    evictIfNeeded,
    evictSessionWithVirtual,
    evictVirtualKey,
  }
}

/** chat store factory 产物类型（renderer defineStore 包装 + core 单测共用，避免手写大 interface 漂移） */
export type ChatStoreInstance = ReturnType<typeof createChatStore>
