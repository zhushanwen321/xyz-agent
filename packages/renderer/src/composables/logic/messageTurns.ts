/**
 * MessageStream 回合分组纯逻辑（R2 logic 层，纯函数无副作用）。
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
 */
import { normalizeContent } from '@xyz-agent/shared'
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
   *  isSessionActive 表达，见 MessageStream 传给 Turn 的同名 prop）。CW wave session-active-ssot T4。 */
  isStreaming: boolean
  /** 是否含可折叠块（thinking/toolCall → 有折叠条；纯文字无） */
  hasFoldable: boolean
}

/** 渲染项：turn（user+assistant 回合）或 system 提示行（独立穿插） */
export type RenderItem =
  | { kind: 'turn'; turn: MessageTurn }
  | { kind: 'system'; message: Message }

/** 一个渲染回合的稳定 key（turn 索引从 1 起；system 用 message.id） */
export function renderKey(item: RenderItem): string {
  return item.kind === 'turn' ? `t-${item.turn.index}` : `s-${item.message.id}`
}

/**
 * 把扁平 messages 按 turn 分组，system 消息作独立项穿插。
 * 纯函数：相同输入产生相同输出，不依赖响应式。
 */
/** 过滤掉不在对话流展示的消息（ADR-0035：按 pi CustomMessage.display 字段过滤）。
 *  extension 经 pi sendMessage 注入 custom message 时声明 display（pi 协议必填 boolean）：
 *  - display:false = 隐藏（goal/todo extension 的 <goal_context>/<todo_context> 上下文提示，
 *    对 AI 有用但对用户是噪声，状态已由 Tasks tab 展示）
 *  - display:true = 用区别样式渲染（workflow-result / subagent-bg-notify）
 *  过滤在渲染层做（本函数），不影响 chat store 的完整 messages——fork/compact/replay
 *  需完整历史（AGENTS.md 规则 7.5）。判断用 `!== false`：仅 false 隐藏，undefined/true 显示
 *  （undefined 来自无 customType 的普通消息或旧数据，安全保留）。 */
export function filterDisplayableMessages(messages: Message[]): Message[] {
  return messages.filter((m) => m.display !== false)
}

export function groupTurns(messages: Message[]): MessageTurn[] {
  return toRenderItems(messages)
    .filter((item): item is { kind: 'turn'; turn: MessageTurn } => item.kind === 'turn')
    .map((item) => item.turn)
}

/**
 * 把扁平 messages 转 RenderItem 列表（turn 与 system 提示行按到达顺序穿插）。
 * MessageStream 据此渲染：turn→<Turn>，system→<SystemNotice>。
 *
 * @param messages 扁平消息列表
 * @param forceWorking 强制最后一个 turn 进入 working 态（subagent running 时使用：
 *   subagent 消息读自 JSONL，status 恒为 complete，但 subagent 实际可能仍在执行中。
 *   传 true 让最后一个 turn 的 isStreaming=true，trace 展开，与主 agent streaming 态一致）
 */
export function toRenderItems(
  messages: Message[],
  forceWorking = false,
): RenderItem[] {
  const items: RenderItem[] = []
  let turnSeq = 0
  let current: MessageTurn | null = null

  for (const msg of messages) {
    if (msg.role === 'user') {
      // 开启新 turn
      turnSeq += 1
      current = {
        index: turnSeq,
        user: msg,
        assistants: [],
        isStreaming: false,
        hasFoldable: false,
      }
      items.push({ kind: 'turn', turn: current })
    } else if (msg.role === 'assistant') {
      // 归入当前 turn；无当前 turn 自启一个（首条 assistant 边缘情况）
      if (!current) {
        turnSeq += 1
        current = {
          index: turnSeq,
          user: null,
          assistants: [],
          isStreaming: false,
          hasFoldable: false,
        }
        items.push({ kind: 'turn', turn: current })
      }
      current.assistants.push(msg)
    } else if (msg.role === 'system') {
      // system 提示行独立穿插（W07-C），不并入任何 turn
      current = null
      items.push({ kind: 'system', message: msg })
    }
  }

  // 回填 isStreaming / hasFoldable（最后一条 turn 的 streaming 态）
  const turnItems = items.filter(
    (item): item is { kind: 'turn'; turn: MessageTurn } => item.kind === 'turn',
  )
  turnItems.forEach(({ turn }, i) => {
    const last = turn.assistants[turn.assistants.length - 1]
    const isLast = i === turnItems.length - 1
    turn.isStreaming = isLast && (forceWorking || last?.status === 'streaming')
    turn.hasFoldable = turn.assistants.some(
      (m) => (m.thinking?.length ?? 0) > 0 || (m.toolCalls?.length ?? 0) > 0,
    )
  })

  return items
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
 * - text: ref 是 content 字符串（整条 assistant 的纯文本，因 pi agent-loop 每 turn
 *   只 emit 一次 assistant message_start，text_delta 全部 append 到同一 content 字段）
 * - thinking/tool: ref 指向对应数组的元素对象
 */
export interface OrderedBlock {
  kind: 'thinking' | 'tool' | 'text'
  ref: ThinkingBlock | ToolCall | string
}

/**
 * 把单条 assistant Message 的内部块按 contentBlocks 真实时序解成有序列表（draft §4：
 * 「展开态下 message-stream 由 7 类块按真实时序排列」）。
 *
 * - 有 contentBlocks：严格按其顺序解出，引用不到（异常 id）的块跳过
 * - 无 contentBlocks（降级）：旧顺序 text→thinking→tool，兼容边界
 *   （实时流和历史消息路径都会填 contentBlocks，降级仅防御异常/手工构造数据）
 *
 * 纯函数：相同输入相同输出，无副作用。
 */
export function expandAssistantBlocks(msg: Message): OrderedBlock[] {
  const blocks = msg.contentBlocks
  // 有 contentBlocks：按真实时序解
  if (blocks && blocks.length > 0) {
    const result: OrderedBlock[] = []
    for (const b of blocks) {
      if (b.type === 'text') {
        // text 块的 refId 恒为 'text'（chat-message-effects / message-converter 约定），
        // 实际内容取 msg.content（text_delta 累积的完整字符串）
        if (msg.content) result.push({ kind: 'text', ref: normalizeContent(msg.content) })
      } else if (b.type === 'thinking') {
        const th = msg.thinking?.find((t) => t.id === b.refId)
        if (th) result.push({ kind: 'thinking', ref: th })
      } else if (b.type === 'toolCall') {
        const tc = msg.toolCalls?.find((t) => t.id === b.refId)
        if (tc) result.push({ kind: 'tool', ref: tc })
      }
    }
    return result
  }
  // 降级：无 contentBlocks，旧顺序 text→thinking→tool
  const fallback: OrderedBlock[] = []
  const text = normalizeContent(msg.content)
  if (text.trim()) fallback.push({ kind: 'text', ref: text })
  for (const th of msg.thinking ?? []) fallback.push({ kind: 'thinking', ref: th })
  for (const tc of msg.toolCalls ?? []) fallback.push({ kind: 'tool', ref: tc })
  return fallback
}
