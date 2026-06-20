/**
 * MessageStream 回合分组纯逻辑（R2 logic 层，纯函数无副作用）。
 *
 * 数据模型：chat store 的 messages 是扁平 Message[]（user/assistant 交替）。
 * 渲染模型（draft-message-stream §4）：一个「turn」= user 气泡 + 其后所有 assistant 块。
 * assistant 的 thinking/toolCalls 折进 trace，content 作收尾 summary。
 *
 * 分组规则：
 * - 遇到 user 消息 → 开启新 turn，该 user 归入新 turn
 * - 遇到 assistant 消息 → 归入当前 turn（无当前 turn 则自启一个，兼容首条 assistant 边缘情况）
 * - streaming 中的 turn（最后一条 assistant status==='streaming'）→ working 态，默认展开 trace
 */
import type { Message } from '@xyz-agent/shared'

/** 一个渲染回合：起点 user + 其后的 assistant 消息序列 */
export interface MessageTurn {
  /** 回合序号（从 1 开始，用于折叠条显示） */
  index: number
  /** 起始 user 消息（边缘情况：首条是 assistant 时为 null） */
  user: Message | null
  /** 回合内的 assistant 消息（一条或多条） */
  assistants: Message[]
  /** 是否正在工作（最后一条 assistant 处于 streaming） */
  isWorking: boolean
  /** 是否含可折叠块（thinking/toolCall → 有折叠条；纯文字无） */
  hasFoldable: boolean
}

/**
 * 把扁平 messages 按 turn 分组。
 * 纯函数：相同输入产生相同输出，不依赖响应式。
 */
export function groupTurns(messages: Message[]): MessageTurn[] {
  const turns: MessageTurn[] = []
  let current: MessageTurn | null = null

  for (const msg of messages) {
    if (msg.role === 'user') {
      // 开启新 turn
      current = {
        index: turns.length + 1,
        user: msg,
        assistants: [],
        isWorking: false,
        hasFoldable: false,
      }
      turns.push(current)
    } else if (msg.role === 'assistant') {
      // 归入当前 turn；无当前 turn 自启一个（首条 assistant 边缘情况）
      if (!current) {
        current = {
          index: turns.length + 1,
          user: null,
          assistants: [],
          isWorking: false,
          hasFoldable: false,
        }
        turns.push(current)
      }
      current.assistants.push(msg)
    }
  }

  // 回填 isWorking / hasFoldable（最后一条 turn 的 working 态）
  turns.forEach((turn, i) => {
    const last = turn.assistants[turn.assistants.length - 1]
    turn.isWorking = i === turns.length - 1 && last?.status === 'streaming'
    turn.hasFoldable = turn.assistants.some(
      (m) => (m.thinking?.length ?? 0) > 0 || (m.toolCalls?.length ?? 0) > 0,
    )
  })

  return turns
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
