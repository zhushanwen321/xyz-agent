/**
 * turn 进展观测面（session-dead-structural-fixes §3.3 D6 C1 方案一 / 设计 §3.1 成功路径 C）。
 *
 * 职责：从 chat store 既有事件流投影（occupancy 分区 + messages 分区）纯本地派生
 * 「本 turn 已进行时长 / 当前工具调用已进行时长 / 已生成字符数」。零协议改动——
 * 信号源 = 结构事件边界的既有落点：
 * - turn 边界：`session.occupancy` 帧 turn 维度（generating 由 message_start(assistant)
 *   驱动、idle 由 agent_settled 驱动——设计 D1 已裁定的 turn-start 物理来源），
 *   dispatching/settling 计入活跃（用户视角 turn 从发送起、到 settled 收口止）。
 * - 工具边界：messages 分区末位 assistant 的 running toolCall（message.tool_call_start
 *   effect 写入 startTime，tool_call_end 收口）。
 * - 字符累计：watch 事件帧驱动增量累计（末位 assistant 内容长度差），delta 只累计
 *   字数不重置任何计时基线；展示刷新用 setInterval 秒级 tick，不每 delta 重算。
 *
 * ask_user 豁免（D6 豁免态）：extension-ui pending 期间展示「在等待你的输入」分型
 * （awaitingUser），停滞警示不参与——超阈值也不出警示色（漏判 = 措辞不准零伤害，
 * 与旧 watchdog 拿豁免做杀/不杀判据的本质区别）。豁免信号由消费方注入（core 不依赖
 * renderer extensionUIStore，结构反转：`getAwaitingUser` 回调）。
 *
 * 生命周期：turn 结束（occupancy → idle）展示快照归 null（Composer 展示自动消失）；
 * 纯本地派生无持久化——reload 后天然无残留（设计 §3.3 D6 方案一定性）。
 *
 * per-session 隔离：ADR-0049 Map 分区范式（useSessionScopedState），分区存跨帧记忆
 * （turnStartedAt / 字符累计基线 / snooze 标记），切 session 保留、切回延续计时。
 */
import { onScopeDispose, ref, watch, reactive } from 'vue'
import type { Ref } from 'vue'
import { normalizeContent } from '@xyz-agent/shared'
import type { Message } from '@xyz-agent/shared'
import { useSessionScopedState } from '../../foundation/use-session-scoped-state'

/** 展示刷新间隔默认值：1s（任务原文「timer 用 setInterval 秒级刷新展示」）。 */
const DEFAULT_TICK_MS = 1000

/**
 * 停滞警示阈值：10 分钟初值。
 *
 * [P-3 实测后定值]（设计 §3.3 D7 / §3.5 P-3）：与 fix-subagent-no-notification 分支的
 * P3 门（三类会话事件间隔分布实测）共用一次实测定值，数据落地前严禁收窄。方案一阶段
 * 阈值仅用于警示色切换（展示恒在，无阈值判定逻辑），不受 P-3 实测阻塞（§3.5 P-3）。
 */
export const TURN_PROGRESS_WARN_THRESHOLD_MS = 600_000

/** 单个 turn 的进展快照（Composer 展示条消费；null = 无活跃 turn，展示消失）。 */
export interface TurnProgressSnapshot {
  /** turn 活跃（occupancy turn 非 idle）。恒 true——null 快照即不活跃，字段保留防语义漂移。 */
  active: boolean
  /** ask_user 豁免态（D6）：等待用户输入期间为 true，展示分型文案、警示不参与。 */
  awaitingUser: boolean
  /** 本 turn 已进行时长（ms，墙钟差值，delta 不参与计时）。 */
  turnElapsedMs: number
  /** 当前 running 工具名（无 running 工具 = null）。 */
  toolName: string | null
  /** 当前工具调用已进行时长（ms；基线 = tool_call_start 写入的 startTime）。 */
  toolElapsedMs: number | null
  /** 本 turn 已生成字符数（流式 delta 增量累计，跨 turn 内多条 assistant 消息）。 */
  generatedChars: number
  /** 超阈值警示色（ask_user 豁免 / 用户点「继续等待」后为 false；阈值见 TURN_PROGRESS_WARN_THRESHOLD_MS）。 */
  warn: boolean
}

/**
 * 计时派生消费的 chat store 最小结构接口（derive-status.ts 的 DeriveStatusChat 同款
 * 结构性类型先例）：renderer pinia store（useChatStore）与 core factory 产物
 * （createChatStore）均天然满足。只读两个分区投影，不触碰任何写路径。
 */
export interface TurnProgressChatSource {
  getMessages(sessionId: string): Message[]
  getOccupancy(sessionId: string): { turn: 'idle' | 'dispatching' | 'generating' | 'settling' }
}

export interface UseTurnProgressOptions {
  /**
   * ask_user 豁免信号（D6 豁免态）注入点：每 tick 轮询读取（非响应式——展示刷新由
   * 秒级 tick 驱动，信号出现后 ≤1 tick 生效）。renderer 接线 =
   * `extensionUIStore.hasPendingAskUser`（既有非响应式 getter，与 deriveStatus 同模式）。
   */
  getAwaitingUser?: (sessionId: string) => boolean
  /** 时钟注入（测试 fake timers 用；默认 Date.now）。 */
  now?: () => number
  /** 展示刷新间隔 ms（默认 1000；测试可缩短）。 */
  tickMs?: number
}

/** per-session 跨帧记忆（reactive 容器，useSessionScopedState 响应式契约要求）。 */
interface TurnPartitionState {
  /** turn-start 边沿时刻（ms）。cold-start（挂载时已活跃）用末位 assistant timestamp 兜底。 */
  turnStartedAt: number | null
  /** 字符增量累计基线：最近观测的 assistant 消息 id（id 变化 = 新消息整条计入）。 */
  lastAssistantId: string | null
  /** 字符增量累计基线：该消息上次观测长度（同 id 只累计正向差值，权威覆盖回退不计负）。 */
  lastAssistantLen: number
  /** 本 turn 已生成字符累计。 */
  generatedChars: number
  /** 用户点「继续等待」后本 turn 内抑制警示（turn 结束自动复位）。 */
  snoozed: boolean
}

function createEmptyPartition(): TurnPartitionState {
  return reactive({ turnStartedAt: null, lastAssistantId: null, lastAssistantLen: 0, generatedChars: 0, snoozed: false })
}

/** 从尾向前找最后一条 assistant 消息（delta 只发生在末位 assistant 上，实际近 O(1)）。 */
function findLastAssistantMessage(messages: Message[] | undefined): Message | undefined {
  if (!messages) return undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'assistant') return messages[i]
  }
  return undefined
}

/** 消息内容字符长度（content 是 string | Segment[] 联合，normalizeContent 归一）。 */
function messageTextLength(m: Message): number {
  return normalizeContent(m.content).length
}

/**
 * turn 进展观测 composable（C1 方案一）。
 *
 * 响应式接线：watch（occupancy turn 维度 + messages 分区引用）驱动结构边沿检测与
 * 字符增量累计（每事件 O(1)）；快照计算只在 setInterval 秒级 tick 里做（delta 不触发
 * 快照重算）。事件回调统一用 source 快照内捕获的 sid 写分区（updateFor），结构性消除
 * 切 session 竞态（ADR-0049 checklist）。
 *
 * @param sessionId 当前展示目标 session（Composer 的 props.sessionId 响应式引用）
 * @param chat chat store 最小结构接口（TurnProgressChatSource）
 * @param options 豁免信号 / 时钟 / tick 间隔注入
 * @returns snapshot：当前 session 快照（null = 无活跃 turn，展示消失）；snoozeWarn：
 *   用户点「继续等待」——本 turn 内抑制警示，turn 结束自动复位
 */
export function useTurnProgress(
  sessionId: Ref<string | null>,
  chat: TurnProgressChatSource,
  options?: UseTurnProgressOptions,
): {
  snapshot: Ref<TurnProgressSnapshot | null>
  snoozeWarn: () => void
} {
  const now = options?.now ?? Date.now
  const tickMs = options?.tickMs ?? DEFAULT_TICK_MS
  const snapshot = ref<TurnProgressSnapshot | null>(null)

  // ADR-0049 Map 分区宿主：跨帧记忆 per-session 隔离，切走保留、切回延续；
  // cleanup 由 sessionCleanupRegistry 统一编排（useSidebar.deleteSession）。
  const scoped = useSessionScopedState<TurnPartitionState>(sessionId, createEmptyPartition)
  const currentPartition = (): TurnPartitionState => scoped.current.value

  // ── interval：秒级展示刷新（活跃才跑；turn 收口/无 sid 即停）──
  let timer: ReturnType<typeof setInterval> | null = null
  function ensureTicking(): void {
    if (timer === null) timer = setInterval(tick, tickMs)
  }
  function stopTicking(): void {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
  onScopeDispose(stopTicking)

  function finishTurn(sid: string): void {
    // 分区字段整体复位（保留 Map 条目——下一 turn 边沿复用，避免增删扰动 version）。
    const part = currentPartition()
    part.turnStartedAt = null
    part.lastAssistantId = null
    part.lastAssistantLen = 0
    part.generatedChars = 0
    part.snoozed = false
    if (sessionId.value === sid) {
      snapshot.value = null
      stopTicking()
    }
  }

  /** turn-start 边沿 / cold-start（挂载时已活跃）：落计时基线 + 字符基线。 */
  function startTurn(messages: Message[] | undefined): void {
    // 计时基线优先取末位 assistant timestamp（message_start effect 写入的墙钟——
    // 比 watch 触发时刻更贴近 message_start(assistant) 事件点）；无消息（dispatching
    // 空窗）退化为当前时刻（误差 ≤ 一个事件批，展示粒度分钟级可接受）。
    const last = findLastAssistantMessage(messages)
    const part = currentPartition()
    part.turnStartedAt = last?.timestamp ?? now()
    part.lastAssistantId = last?.id ?? null
    part.lastAssistantLen = last ? messageTextLength(last) : 0
    // cold-start 时正在流式的消息已产出部分计入（事实陈述）；正常边沿 message_start
    // 时 content 为空，此值恒 0。
    part.generatedChars = part.lastAssistantLen
    part.snoozed = false
  }

  /** 事件帧驱动的字符增量累计（末位 assistant 长度差；O(1)，不重置任何计时基线）。 */
  function accumulateChars(messages: Message[] | undefined): void {
    const last = findLastAssistantMessage(messages)
    if (!last) return
    const part = currentPartition()
    if (part.turnStartedAt === null) return
    const len = messageTextLength(last)
    if (last.id === part.lastAssistantId) {
      // 同一条消息：只累计正向增量（delta 增长）；message.complete 权威 content 覆盖
      // 若短于客户端累积（罕见回退）不计负——展示指标只少不多，不撒谎。
      if (len > part.lastAssistantLen) part.generatedChars += len - part.lastAssistantLen
    } else {
      // turn 内新 assistant 消息（text → toolCall → text 的后续段）：整条计入。
      part.generatedChars += len
    }
    part.lastAssistantId = last.id
    part.lastAssistantLen = len
  }

  // ── 秒级 tick：快照计算（唯一做 O(turn) 工作的地方）──
  function tick(): void {
    const sid = sessionId.value
    if (!sid) {
      stopTicking()
      snapshot.value = null
      return
    }
    const part = currentPartition()
    if (part.turnStartedAt === null) {
      stopTicking()
      snapshot.value = null
      return
    }
    if (chat.getOccupancy(sid).turn === 'idle') {
      // 边沿漏检兜底（watch 与 interval 之间无帧的形态理论不存在，防御性收口）。
      finishTurn(sid)
      return
    }
    const last = findLastAssistantMessage(chat.getMessages(sid))
    const runningTools = last?.toolCalls?.filter((t) => t.status === 'running') ?? []
    const tool = runningTools.length > 0 ? runningTools[runningTools.length - 1] : undefined
    const nowMs = now()
    const turnElapsedMs = Math.max(0, nowMs - part.turnStartedAt)
    const awaitingUser = options?.getAwaitingUser?.(sid) === true
    snapshot.value = {
      active: true,
      awaitingUser,
      turnElapsedMs,
      toolName: tool?.toolName ?? null,
      toolElapsedMs: tool ? Math.max(0, nowMs - tool.startTime) : null,
      generatedChars: part.generatedChars,
      // D6 豁免：ask_user pending 期间警示不参与（超阈值也不警示，只走分型文案）。
      warn: !awaitingUser && !part.snoozed && turnElapsedMs >= TURN_PROGRESS_WARN_THRESHOLD_MS,
    }
  }

  // ── 结构边沿检测（watch 回调每事件 O(1)；快照不在本回调算）──
  interface TurnProgressSource {
    sid: string | null
    turn: 'idle' | 'dispatching' | 'generating' | 'settling' | undefined
    messages: Message[] | undefined
  }
  // source 快照派生自 sid.value 的实时分区（occupancy turn 维度 + messages 数组引用），
  // 任一 commit 都触发边沿回调——next.sid 与回调执行时的 sid.value 恒一致（同 flush
  // 同步求值），分区读写走 currentPartition() 无跨 session 竞态窗口。
  function turnProgressSource(): TurnProgressSource {
    const sid = sessionId.value
    return {
      sid,
      turn: sid ? chat.getOccupancy(sid).turn : undefined,
      messages: sid ? chat.getMessages(sid) : undefined,
    }
  }
  function onTurnProgressEdge(next: TurnProgressSource, prev: TurnProgressSource | undefined): void {
    if (!next.sid) {
      stopTicking()
      snapshot.value = null
      return
    }
    const wasActive = prev !== undefined && prev.turn !== undefined && prev.turn !== 'idle'
    const isActive = next.turn !== undefined && next.turn !== 'idle'
    if (!isActive) {
      // turn-end 边沿（agent_settled → idle）：展示消失 + 记忆复位。挂载于 idle
      // session（prev 为 undefined）时无残留在先，复位幂等。
      if (wasActive || currentPartition().turnStartedAt !== null) finishTurn(next.sid)
      return
    }
    const part = currentPartition()
    if (!wasActive || part.turnStartedAt === null) startTurn(next.messages)
    accumulateChars(next.messages)
    ensureTicking()
    tick()
  }
  watch(turnProgressSource, onTurnProgressEdge, { immediate: true })

  /** 用户点「继续等待」（中性操作项）：本 turn 内抑制警示，事实条照常展示。 */
  function snoozeWarn(): void {
    const sid = sessionId.value
    if (!sid) return
    currentPartition().snoozed = true
    if (snapshot.value) snapshot.value = { ...snapshot.value, warn: false }
  }

  return {
    snapshot,
    snoozeWarn,
  }
}
