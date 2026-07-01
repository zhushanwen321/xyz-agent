/**
 * MessageStream 回合分组纯逻辑（R2 logic 层，纯函数无副作用）。
 *
 * 数据模型：chat store 的 messages 是扁平 Message[]（user/assistant/system 交替）。
 * 渲染模型（draft-message-stream §4）：一个「turn」= user 气泡 + 其后所有 assistant 块。
 * assistant 的 thinking/toolCalls 折进 trace，content 作收尾 summary。
 * system 消息（bashExecution/compactionSummary/branchSummary，W07-C）作独立系统提示行，
 * 按到达顺序穿插在 turns 之间，不归入任何 turn（不冒充 user/assistant）。
 *
 * 分组规则：
 * - 遇到 user 消息 → 开启新 turn，该 user 归入新 turn
 * - 遇到 assistant 消息 → 归入当前 turn（无当前 turn 则自启一个，兼容首条 assistant 边缘情况）
 * - 遇到 system 消息 → 产出独立 SystemNotice 项（不并入 turn）
 * - streaming 中的 turn（最后一条 assistant status==='streaming'）→ working 态，默认展开 trace
 */
import type { ContentBlock, Message, ThinkingBlock, ToolCall } from '@xyz-agent/shared'

/** 一个渲染回合：起点 user + 其后的 assistant 消息序列 */
export interface MessageTurn {
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
export function groupTurns(messages: Message[]): MessageTurn[] {
  return toRenderItems(messages)
    .filter((item): item is { kind: 'turn'; turn: MessageTurn } => item.kind === 'turn')
    .map((item) => item.turn)
}

/**
 * 把扁平 messages 转 RenderItem 列表（turn 与 system 提示行按到达顺序穿插）。
 * MessageStream 据此渲染：turn→<Turn>，system→<SystemNotice>。
 */
export function toRenderItems(messages: Message[]): RenderItem[] {
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
        isWorking: false,
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
          isWorking: false,
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

  // 回填 isWorking / hasFoldable（最后一条 turn 的 working 态）
  const turnItems = items.filter(
    (item): item is { kind: 'turn'; turn: MessageTurn } => item.kind === 'turn',
  )
  turnItems.forEach(({ turn }, i) => {
    const last = turn.assistants[turn.assistants.length - 1]
    turn.isWorking = i === turnItems.length - 1 && last?.status === 'streaming'
    turn.hasFoldable = hasFoldable(turn)
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
 * turn 是否含可折叠块（thinking/toolCall）。
 * 新数据基于 contentBlocks 判定（含非 text 块 → true）；
 * 旧数据无 contentBlocks 时回退看 thinking/toolCalls 数组（兼容）。
 */
export function hasFoldable(turn: MessageTurn): boolean {
  return turn.assistants.some((m) => {
    const blocks = m.contentBlocks
    if (blocks && blocks.length > 0) {
      return blocks.some((b) => b.type !== 'text')
    }
    return (m.thinking?.length ?? 0) > 0 || (m.toolCalls?.length ?? 0) > 0
  })
}

/* ── W2 渲染层：按 contentBlocks 到达顺序展平 turn 为单一连续流 ── */

/** 展平后的可渲染块（thinking/tool/text 三种） */
export type RenderedBlockKind = 'thinking' | 'tool' | 'text'

export interface RenderedBlock {
  kind: RenderedBlockKind
  /** 渲染顺序 key（assistantId + kind + refId） */
  key: string
  /** 所属 assistant id（fork/MD 复制等按 assistant 取数） */
  assistantId: string
  /** thinking 内容（kind==='thinking'） */
  content?: string
  /** thinking 初始折叠态（kind==='thinking'） */
  collapsed?: boolean
  /** tool 数据（kind==='tool'） */
  tool?: ToolCall
  /** 是否为最后一个 assistant 的最后一个 text 块（挂光标 + hover actions） */
  isLastText: boolean
}

/** 从 assistant.thinking 数组按 id 查找块（找不到返回 null） */
function findThinking(m: Message, refId: string): ThinkingBlock | null {
  return m.thinking?.find((t) => t.id === refId) ?? null
}

/** 从 assistant.toolCalls 数组按 id 查找（找不到返回 null） */
function findToolCall(m: Message, refId: string): ToolCall | null {
  return m.toolCalls?.find((t) => t.id === refId) ?? null
}

/** content 去空白判定（空 text 块跳过） */
function hasText(content: string | undefined): boolean {
  return !!content && content.trim().length > 0
}

/**
 * 把单个 assistant 的内容按到达顺序展平为 RenderedBlock 列表。
 *
 * 新数据（有 contentBlocks）：按 contentBlocks 顺序遍历，text 块恒显，
 * thinking/tool 块仅在 showTrace 为 true 时渲染；refId 未命中 → 跳过（防御）。
 * 旧数据（无 contentBlocks）：回退——thinking → toolCalls 顺序（受折叠），
 * text 取 assistant.content 恒显。
 *
 * @param m assistant 消息
 * @param showTrace 是否展开 trace（working || expanded）；false 时隐藏 thinking/tool
 * @param isLastAssistant 是否最后一个 assistant（影响 isLastText 标记）
 */
export function flattenAssistant(
  m: Message,
  showTrace: boolean,
  isLastAssistant: boolean,
): RenderedBlock[] {
  const out: RenderedBlock[] = []
  const blocks = m.contentBlocks
  if (blocks && blocks.length > 0) {
    // 找出最后一个 text 块的索引（仅最后一个 assistant 才标 isLastText）
    let lastTextIdx = -1
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      if (blocks[i].type === 'text') {
        lastTextIdx = i
        break
      }
    }
    blocks.forEach((b: ContentBlock, i: number) => {
      if (b.type === 'text') {
        if (!hasText(m.content)) return // 空内容 text 跳过（U18c）
        out.push({
          kind: 'text',
          key: `${m.id}-text`,
          assistantId: m.id,
          content: m.content,
          isLastText: isLastAssistant && i === lastTextIdx,
        })
      } else if (b.type === 'thinking') {
        if (!showTrace) return // 折叠时隐藏（U14）
        const th = findThinking(m, b.refId)
        if (!th) return // refId 未命中 → 跳过（U18b）
        out.push({
          kind: 'thinking',
          key: `${m.id}-th-${b.refId}`,
          assistantId: m.id,
          content: th.content,
          collapsed: th.collapsed,
          isLastText: false,
        })
      } else {
        // toolCall
        if (!showTrace) return // 折叠时隐藏（U14）
        const tc = findToolCall(m, b.refId)
        if (!tc) return // refId 未命中 → 跳过（防御）
        out.push({
          kind: 'tool',
          key: `${m.id}-tc-${b.refId}`,
          assistantId: m.id,
          tool: tc,
          isLastText: false,
        })
      }
    })
    return out
  }

  // ── 旧数据回退：thinking → toolCalls（受折叠），text 取 content 恒显 ──
  if (showTrace) {
    for (const th of m.thinking ?? []) {
      out.push({
        kind: 'thinking',
        key: `${m.id}-th-${th.id}`,
        assistantId: m.id,
        content: th.content,
        collapsed: th.collapsed,
        isLastText: false,
      })
    }
    for (const tc of m.toolCalls ?? []) {
      out.push({
        kind: 'tool',
        key: `${m.id}-tc-${tc.id}`,
        assistantId: m.id,
        tool: tc,
        isLastText: false,
      })
    }
  }
  if (hasText(m.content)) {
    out.push({
      kind: 'text',
      key: `${m.id}-text`,
      assistantId: m.id,
      content: m.content,
      isLastText: isLastAssistant,
    })
  }
  return out
}

/**
 * 把整个 turn 展平为按 contentBlocks 到达顺序的单一连续 RenderedBlock 流。
 * text 块恒显（无论 showTrace），thinking/tool 块受 showTrace 控制。
 */
export function renderedBlocks(turn: MessageTurn, showTrace: boolean): RenderedBlock[] {
  const assistants = turn.assistants
  const out: RenderedBlock[] = []
  assistants.forEach((m, idx) => {
    out.push(...flattenAssistant(m, showTrace, idx === assistants.length - 1))
  })
  return out
}
