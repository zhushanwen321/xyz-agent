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

/** 渲染项：turn（user+assistant 回合）或 system 提示行（独立穿插） */
export type RenderItem =
  | { kind: 'turn'; turn: MessageTurn }
  | { kind: 'system'; message: Message }

/** 一个渲染回合的稳定 key（turn 索引从 1 起；system 用 message.id） */
export function renderKey(item: RenderItem): string {
  return item.kind === 'turn' ? `t-${item.turn.index}` : `s-${item.message.id}`
}

/** 不在对话流渲染的 customType（完成通知——agent 收到后会被唤醒在后续 turn 处理，
 *  对用户是噪声，结果由 agent 后续 turn 体现）。消息仍进 chat store 供 fork/compact/replay，
 *  agent 仍能读到；此处仅过滤渲染，不丢消息（AGENTS.md 规则 7.5）。 */
const HIDDEN_NOTIFY_CUSTOM_TYPES = new Set(['subagent-bg-notify', 'workflow-result'])

/** 过滤掉不在对话流展示的消息（ADR-0048：按 pi CustomMessage.display 字段过滤）。 */
export function filterDisplayableMessages(messages: Message[]): Message[] {
  return messages.filter((m) => {
    if (m.display === false) return false
    if (typeof m.customType === 'string' && HIDDEN_NOTIFY_CUSTOM_TYPES.has(m.customType)) {
      return false
    }
    return true
  })
}

export function groupTurns(messages: Message[]): MessageTurn[] {
  return toRenderItems(messages)
    .filter((item): item is { kind: 'turn'; turn: MessageTurn } => item.kind === 'turn')
    .map((item) => item.turn)
}

export function toRenderItems(
  messages: Message[],
  forceWorking = false,
): RenderItem[] {
  const items: RenderItem[] = []
  let turnSeq = 0
  let current: MessageTurn | null = null

  for (const msg of messages) {
    if (msg.role === 'user') {
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
      current = null
      items.push({ kind: 'system', message: msg })
    }
  }

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
