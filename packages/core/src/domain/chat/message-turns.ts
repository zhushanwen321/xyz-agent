/**
 * MessageStream 回合分组纯逻辑（chat 域 SSOT，w6 从 renderer/composables/logic/messageTurns.ts 迁入）。
 *
 * 数据模型：chat store 的 messages 是扁平 Message[]（user/assistant/system 交替）。
 * 渲染模型（draft-message-stream §4）：一个「turn」= user 气泡 + 其后所有 assistant 块。
 * assistant 的 thinking/toolCalls 折进 trace，content 作收尾 summary。
 * system 消息（compactionSummary/branchSummary，W07-C）作独立系统提示行，
 * 按到达顺序穿插在 turns 之间，不归入任何 turn（不冒充 user/assistant）。
 *
 * 分组规则：
 * - 遇到 user 消息 → 开启新 turn，该 user 归入新 turn
 * - 遇到 assistant 消息 → 归入当前 turn（无当前 turn 则自启一个，兼容首条 assistant 边缘情况）
 * - 遇到 system 消息 → 产出独立 SystemNotice 项（不并入 turn）
 * - streaming 中的 turn（最后一条 assistant status==='streaming'）→ working 态，默认展开 trace
 *
 * 归属：chat 域纯函数（零 Vue/renderer 依赖），对齐 w1-w5 chat 域绞杀模式（core SSOT）。
 * ui 包经 @xyz-agent/core/domain/chat 子路径 import（仅类型/纯函数，非 store/composable 运行时）。
 */
import { normalizeContent, SUBAGENT_TOOL_NAMES, WORKFLOW_TOOL_NAMES } from '@xyz-agent/shared'
import type { Message, ThinkingBlock, ToolCall } from '@xyz-agent/shared'

/** 一个渲染回合：起点 user + 其后的 assistant 消息序列 */
export interface MessageTurn {
  index: number
  /** 起始 user 消息（边缘情况：首条是 assistant 时为 null） */
  user: Message | null
  /** 回合内的 assistant 消息（一条或多条） */
  assistants: Message[]
  /** 文本是否正在流式生成（turn 级信号，最后一条 assistant 处于 streaming 或 subagent 强制态）。
   *  语义仅「文本正在流式生成」——驱动 Loader 转圈、streaming 光标、计时器、滚动跟随。
   *  ask-user 等待期间 message 已 complete → false，但对话仍在进行中（该信号由 session 级
   *  isSessionActive 表达）。CW wave session-active-ssot T4。 */
  isStreaming: boolean
  /** 是否含可折叠块（thinking/toolCall → 有折叠条；纯文字无） */
  hasFoldable: boolean
}

/**
 * 渲染项：kind 全集（renderer-model 归一 M1，conversation-renderer-model-unification §3.3.1）。
 * kind 是 toRenderItems 每渲染从同一堆可选字段现算的派生值，不落 store——单一判定函数。
 *
 * - turn：user+assistant 回合
 * - systemNotice：compaction/branchSummary/stream_warn 等一行通知（system 无 bashExecution）
 * - bashExecution：BashOutputBlock（system + bashExecution 字段）
 *
 * 判定顺序与旧 MessageStream system 分支一致：bashExecution 优先于 systemNotice 兜底。
 * bgNotify/gui 两类不属全集：bgNotify 由 registry 写 display:false 过滤（M2），
 * gui 的 producer（workflow-result）同属完成通知一并移除，tool RPC 的 __gui__ 走 Block.vue。
 */
export type RenderItem =
  | { kind: 'turn'; turn: MessageTurn }
  | { kind: 'systemNotice'; message: Message }
  | { kind: 'bashExecution'; message: Message }

/**
 * turn 的稳定标识：首条消息 id（user 优先，assistant 自启 turn 用首条 assistant id）。
 * 消息 id 由 runtime 在消息创建时生成（uuid，message-converter / event-adapter），
 * 同一消息两次生成同 id、其他消息插入/删除不影响——key 不随渲染重建/列表增删漂移。
 *
 * [M5 stable-key] 旧实现用 MessageTurn.index（toRenderItems 每次从 0 重算的序号），
 * 消息插入/删除（load-more、streaming 追加）会让全部后续 turn 的 key 平移，
 * virtua 按 key 复用 DOM 时错位（组件状态串台）。改首条消息 id 后 key 恒稳定。
 * 空串兜底理论不可达（toRenderItems 保证 turn 必有 user 或 assistants[0]），仅类型收窄用。
 */
export function turnStableId(turn: MessageTurn): string {
  return turn.user?.id ?? turn.assistants[0]?.id ?? ''
}

/** 一个渲染回合的稳定 key（turn 用首条消息 id；system 类用 message.id）。
 *  两个 key 空间前缀不同（t-/s-），消息 id 全局唯一，无碰撞。 */
export function renderKey(item: RenderItem): string {
  return item.kind === 'turn' ? `t-${turnStableId(item.turn)}` : `s-${item.message.id}`
}

/** 不在对话流渲染的 customType 判定已删除 [M2 display 前置]：完成通知由生产端（registry
 *  customStart / runtime mapper）统一写 display:false，filter 只认 display 字段，不再维护
 *  customType 黑名单（conversation-renderer-model-unification §3.3.2，supersede ADR-0048）。
 *  消息仍进 chat store 供 fork/compact/replay，agent 仍能读到；此处仅过滤渲染，不丢消息
 *  （AGENTS.md 规则 7.5）。 */

/** 过滤掉不在对话流展示的消息（display===false：完成通知由生产端写死，
 *  goal/todo context 由 pi 扩展声明——纯字段过滤，无 customType 黑名单）。 */
export function filterDisplayableMessages(messages: Message[]): Message[] {
  return messages.filter((m) => m.display !== false)
}

export function groupTurns(messages: Message[]): MessageTurn[] {
  return toRenderItems(messages)
    .filter((item): item is { kind: 'turn'; turn: MessageTurn } => item.kind === 'turn')
    .map((item) => item.turn)
}

// ── D-4 turn 派生增量（08-render-layer §3.3.1，perf W21）──────────────────────────

/**
 * turn 派生增量缓存（D-4）。复用键 = turn 成员消息的对象引用序列——直接消费 D-1 的
 * 不可变消息身份（成员引用未变 = 成员内容未变，含 status/thinking/toolCalls/error），
 * 无第二份状态、无脆弱文本 hash（被否方案见 08 §3.2 D-4 对比表）。
 *
 * 缓存归属：纯派生数据、可随时丢弃重建（无 drift 风险）。调用方（MessageStream）经
 * useSessionScopedState 工厂按 session 分区持有（ADR-0049——组件实例不随 session 销毁，
 * 实例级缓存会跨 session 残留上一会话的 Message 引用），session 销毁经工厂 cleanup 释放。
 */
export interface TurnRenderCache {
  /** 快路径键 = 源数组引用（NOT filter 产物——filter 每调用产出新数组，键其上恒 miss）。
   *  D-1 容器范式下源数组（per-sid 分区数组）commit 才替换引用：引用未变 = 本 sid 无新 commit。 */
  lastSourceRef: Message[] | null
  /** 每个 turn 的成员引用签名（[user, ...assistants]；首条 assistant 自启 turn 无 user 位），
   *  与 turnObjects 一一对应 */
  turnSignatures: Message[][]
  /** 与 turnSignatures 一一对应：上次产出的 MessageTurn（复用载体） */
  turnObjects: MessageTurn[]
  /** 上次整体产出（快路径直接复用；含非 turn 项——systemNotice/bashExecution 一并缓存） */
  cachedItems: RenderItem[]
}

/** 创建空缓存。toRenderItemsIncremental 原地 mutate 更新（不替换缓存对象），调用方 init 时创建一次。 */
export function createTurnRenderCache(): TurnRenderCache {
  return { lastSourceRef: null, turnSignatures: [], turnObjects: [], cachedItems: [] }
}

/** 分组中间结构：一个「turn」的成员组（user 起点或 assistant 自启） */
interface TurnGroup {
  user: Message | null
  assistants: Message[]
}

/** 渲染槽位：turn 槽位引用 groups 下标；system 类直接产出静态项（不参与 turn 复用） */
type GroupSlot = { slot: 'turn'; group: number } | { slot: 'static'; item: RenderItem }

/**
 * 扁平消息 → 渲染槽位序列 + turn 成员组。分组规则见文件头「分组规则」节。
 * toRenderItems（全量版）与 toRenderItemsIncremental（增量版）共享的分组 SSOT——
 * 两处分组逻辑漂移会导致增量输出与全量输出不等价。
 */
function groupRenderInput(messages: Message[]): { slots: GroupSlot[]; groups: TurnGroup[] } {
  const slots: GroupSlot[] = []
  const groups: TurnGroup[] = []
  let current: TurnGroup | null = null
  for (const msg of messages) {
    if (msg.role === 'user') {
      current = { user: msg, assistants: [] }
      groups.push(current)
      slots.push({ slot: 'turn', group: groups.length - 1 })
    } else if (msg.role === 'assistant') {
      if (!current) {
        current = { user: null, assistants: [] }
        groups.push(current)
        slots.push({ slot: 'turn', group: groups.length - 1 })
      }
      current.assistants.push(msg)
    } else {
      // else 即「非 user/assistant」兜底分支：现状唯一合法值是 role === 'system'（systemNotice
      // 或 bashExecution）。刻意不做显式 system 判定后丢弃——类型外 role（未来扩展）兜底渲染为
      // systemNotice 可见可发现，静默丢弃会违背「渲染过滤不丢消息」语义（AGENTS.md 规则 7.5）。
      current = null
      slots.push({
        slot: 'static',
        item: msg.bashExecution
          ? { kind: 'bashExecution', message: msg }
          : { kind: 'systemNotice', message: msg },
      })
    }
  }
  return { slots, groups }
}

/** turn 派生字段：isStreaming（turn 级「文本正在流式生成」，仅末位 turn 可为 true） */
function computeIsStreaming(
  assistants: Message[],
  isLastTurn: boolean,
  forceWorking: boolean,
): boolean {
  if (!isLastTurn) return false
  const last = assistants[assistants.length - 1]
  return forceWorking || last?.status === 'streaming'
}

/** turn 派生字段：是否含可折叠块（thinking/toolCalls） */
function computeHasFoldable(assistants: Message[]): boolean {
  return assistants.some(
    (m) => (m.thinking?.length ?? 0) > 0 || (m.toolCalls?.length ?? 0) > 0,
  )
}

/** 签名相等 = 长度相同且逐成员引用相等（自启 turn 无 user 位，序列天然对齐） */
function signatureEquals(a: Message[], b: Message[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * 快路径（源数组引用未变 = 本 sid 无新 commit）：按当前 forceWorking 重驱动末位 turn 的
 * isStreaming——消费方的 forceWorking 翻转（虚拟 session 的 subagent streaming 判定）在
 * 源数组不变时触发本函数。
 * 期望值未变 → cachedItems 引用恒等返回（零重算）；变化 → 不可变替换末位 turn 对象
 * （不原地改，历史 turn 与其余项全部复用）并同步缓存自洽。
 */
function redriveLastTurnStreaming(cache: TurnRenderCache, forceWorking: boolean): RenderItem[] {
  const items = cache.cachedItems
  let lastTurnItemIdx = -1
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === 'turn') {
      lastTurnItemIdx = i
      break
    }
  }
  const lastTurnItem = lastTurnItemIdx >= 0 ? items[lastTurnItemIdx] : null
  // 无 turn（cachedItems 空或全 static 项）：static 项不依赖 forceWorking，恒等复用
  if (!lastTurnItem || lastTurnItem.kind !== 'turn') return items
  const expected = computeIsStreaming(lastTurnItem.turn.assistants, true, forceWorking)
  if (lastTurnItem.turn.isStreaming === expected) return items
  const replacement: MessageTurn = { ...lastTurnItem.turn, isStreaming: expected }
  const nextItems = items.slice()
  nextItems[lastTurnItemIdx] = { kind: 'turn', turn: replacement }
  cache.cachedItems = nextItems
  // items 中最后一个 turn 槽位恒对应 turnObjects 末位（分组顺序一致）；签名未变只换对象
  if (cache.turnObjects.length > 0) {
    const nextObjects = cache.turnObjects.slice()
    nextObjects[nextObjects.length - 1] = replacement
    cache.turnObjects = nextObjects
  }
  return nextItems
}

/**
 * 增量派生版 toRenderItems（D-4）：以「成员消息对象引用序列」为复用键。
 * - 快路径：源数组引用未变 → 零重算（仅按 forceWorking 重驱动末位 isStreaming）
 * - 重扫：源数组引用变化 → filter 后重分组，同位置签名对齐的 turn 复用上次对象，
 *   只重建成员变化的 turn。首版只做同位置匹配（位置平移的 turn 重算，成本 O(turn 数)，
 *   可接受——08 §3.3.1 失效条件 2）。非 turn 项在重扫路径重建（构造便宜、数量少），
 *   经 cachedItems 随快路径整体复用。
 * - 上次末位 turn 的 streaming 态在末位地位变化时过期（如追加新 turn），复用分支
 *   按「期望 isStreaming」校正——不一致时不可变替换。
 *
 * @param sourceMessages 源消息数组（per-sid 分区数组，非 filter 产物）
 * @param filter 现状 filterDisplayableMessages（仅重扫路径调用；快路径跳过）
 * @param forceWorking subagent 虚拟 session 强制 streaming
 * @param cache 增量缓存；undefined 时退化为全量版（等价现状 toRenderItems）
 */
export function toRenderItemsIncremental(
  sourceMessages: Message[],
  filter: (msgs: Message[]) => Message[],
  forceWorking: boolean,
  cache: TurnRenderCache | undefined,
): RenderItem[] {
  if (!cache) {
    return toRenderItems(filter(sourceMessages), forceWorking)
  }
  if (cache.lastSourceRef === sourceMessages) {
    return redriveLastTurnStreaming(cache, forceWorking)
  }

  const filtered = filter(sourceMessages)
  const { slots, groups } = groupRenderInput(filtered)
  const lastGroupIdx = groups.length - 1
  const turnObjects: MessageTurn[] = new Array<MessageTurn>(groups.length)
  const signatures: Message[][] = new Array<Message[]>(groups.length)

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]
    const sig: Message[] = g.user ? [g.user, ...g.assistants] : g.assistants.slice()
    signatures[i] = sig
    const prevSig = cache.turnSignatures[i]
    const prevTurn = cache.turnObjects[i]
    const isLastTurn = i === lastGroupIdx
    // 同位置签名逐引用对齐 → 复用上次 turn 对象。成员未变 → hasFoldable/user/assistants
    // 必然不变，只需校正 isStreaming（末位地位变化 / forceWorking 翻转会让上次值过期）。
    if (prevTurn && prevSig && signatureEquals(sig, prevSig)) {
      const expected = computeIsStreaming(g.assistants, isLastTurn, forceWorking)
      turnObjects[i] =
        prevTurn.isStreaming === expected ? prevTurn : { ...prevTurn, isStreaming: expected }
    } else {
      turnObjects[i] = {
        index: i + 1,
        user: g.user,
        assistants: g.assistants,
        isStreaming: computeIsStreaming(g.assistants, isLastTurn, forceWorking),
        hasFoldable: computeHasFoldable(g.assistants),
      }
    }
  }

  const items: RenderItem[] = slots.map((s) =>
    s.slot === 'turn' ? { kind: 'turn', turn: turnObjects[s.group] } : s.item,
  )

  cache.lastSourceRef = sourceMessages
  cache.turnSignatures = signatures
  cache.turnObjects = turnObjects
  cache.cachedItems = items
  return items
}

export function toRenderItems(
  messages: Message[],
  forceWorking = false,
): RenderItem[] {
  const { slots, groups } = groupRenderInput(messages)
  const turns: MessageTurn[] = groups.map((g, i) => ({
    index: i + 1,
    user: g.user,
    assistants: g.assistants,
    isStreaming: computeIsStreaming(g.assistants, i === groups.length - 1, forceWorking),
    hasFoldable: computeHasFoldable(g.assistants),
  }))
  return slots.map((s) => (s.slot === 'turn' ? { kind: 'turn', turn: turns[s.group] } : s.item))
}

/** 统计 turn 内 thinking 块数（折叠条 badge） */
export function countThinking(turn: MessageTurn): number {
  return turn.assistants.reduce((sum, m) => sum + (m.thinking?.length ?? 0), 0)
}

/** 统计 turn 内 toolCall 块数（折叠条 badge） */
export function countToolCalls(turn: MessageTurn): number {
  return turn.assistants.reduce((sum, m) => sum + (m.toolCalls?.length ?? 0), 0)
}

/** turn 是否含失败的 tool（影响 trace 渲染：失败 tool 整块红框） */
export function hasFailedTool(turn: MessageTurn): boolean {
  return turn.assistants.some((m) =>
    m.toolCalls?.some((t) => t.status === 'error'),
  )
}

/**
 * 有序渲染块 —— 单条 assistant Message 内部块按真实时序解出后的渲染单元。
 * Turn.vue trace 区按此数组顺序 v-for 渲染 Block.vue。
 */
export interface OrderedBlock {
  kind: 'thinking' | 'tool' | 'text' | 'agentgraph'
  ref: ThinkingBlock | ToolCall | string
}

/** 判断 toolName 是否属于 agentgraph（subagent/workflow）。 */
function isAgentgraphToolName(toolName: string): boolean {
  return SUBAGENT_TOOL_NAMES.has(toolName) || WORKFLOW_TOOL_NAMES.has(toolName)
}

/**
 * 把单条 assistant Message 的内部块按 contentBlocks 真实时序解成有序列表。
 * 纯函数：相同输入相同输出，无副作用。
 */
export function expandAssistantBlocks(msg: Message): OrderedBlock[] {
  const blocks = msg.contentBlocks
  if (blocks && blocks.length > 0) {
    const result: OrderedBlock[] = []
    for (const b of blocks) {
      if (b.type === 'text') {
        if (msg.content) result.push({ kind: 'text', ref: normalizeContent(msg.content) })
      } else if (b.type === 'thinking') {
        const th = msg.thinking?.find((t) => t.id === b.refId)
        if (th) result.push({ kind: 'thinking', ref: th })
      } else if (b.type === 'toolCall') {
        const tc = msg.toolCalls?.find((t) => t.id === b.refId)
        if (tc) {
          const kind = isAgentgraphToolName(tc.toolName) ? 'agentgraph' : 'tool'
          result.push({ kind, ref: tc })
        }
      }
    }
    return result
  }
  const fallback: OrderedBlock[] = []
  const text = normalizeContent(msg.content)
  if (text.trim()) fallback.push({ kind: 'text', ref: text })
  for (const th of msg.thinking ?? []) fallback.push({ kind: 'thinking', ref: th })
  for (const tc of msg.toolCalls ?? []) {
    const kind = isAgentgraphToolName(tc.toolName) ? 'agentgraph' : 'tool'
    fallback.push({ kind, ref: tc })
  }
  return fallback
}
