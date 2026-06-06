/**
 * 消息布局分组逻辑（纯函数，无 Vue 依赖）
 *
 * 两层分组：
 * 1. Turn 级：flat messages → turns（user 开始新 turn，assistant/system 追加）
 * 2. Section 级：单条 assistant message → sections（thinking/toolCall/text 按类型合并）
 */

import type { ContentBlock, Message } from '@xyz-agent/shared'
import type { ChatMessage } from '../stores/chat'

// ── Turn grouping ──────────────────────────────────────────

export interface Turn {
  /** v-for key（取 turn 中第一条消息的 id） */
  key: string
  /** turn 内的消息列表 */
  messages: ChatMessage[]
}

/**
 * 将扁平消息列表按 Turn 分组。
 *
 * 分组规则：
 *   - 每个 user 消息开始一个新 Turn
 *   - 后续连续的 assistant / system 消息归入同一个 Turn
 *   - 首条消息如果不是 user，单独成组（开头的 system 通知等）
 */
export function groupIntoTurns(msgs: ChatMessage[]): Turn[] {
  if (msgs.length === 0) return []

  const groups: Turn[] = []
  let current: ChatMessage[] = []

  for (const msg of msgs) {
    if (msg.role === 'user') {
      if (current.length > 0) {
        groups.push({ key: current[0].id, messages: current })
      }
      current = [msg]
    } else {
      current.push(msg)
    }
  }

  if (current.length > 0) {
    groups.push({ key: current[0].id, messages: current })
  }

  return groups
}

// ── Section grouping ───────────────────────────────────────

export type SectionType = 'thinking' | 'toolCall' | 'text'

export interface AssistantSection {
  type: SectionType
  /** contentBlocks 或构造出的虚拟 blocks */
  blocks: ContentBlock[]
}

/**
 * 将单条 assistant message 的内容按类型分组。
 *
 * 统一处理有/无 contentBlocks 两种情况：
 * - 有 contentBlocks：按相邻同类型合并
 * - 无 contentBlocks（历史消息）：从 thinking → toolCalls → content 构造 sections
 */
export function groupIntoSections(msg: Message): AssistantSection[] {
  if (msg.contentBlocks?.length) {
    return groupByContentBlocks(msg)
  }
  return groupByLegacyFields(msg)
}

/** 有序 contentBlocks → sections（相邻同类型合并） */
function groupByContentBlocks(msg: Message): AssistantSection[] {
  const sections: AssistantSection[] = []
  let current: AssistantSection | null = null

  for (const block of msg.contentBlocks!) {
    // text block 但无实际内容 → 跳过
    if (block.type === 'text' && !msg.content) continue

    if (current && current.type === block.type) {
      current.blocks.push(block)
    } else {
      if (current) sections.push(current)
      current = { type: block.type as SectionType, blocks: [block] }
    }
  }

  if (current) sections.push(current)
  return sections
}

/** 无 contentBlocks → 从 thinking/toolCalls/content 构造 */
function groupByLegacyFields(msg: Message): AssistantSection[] {
  const sections: AssistantSection[] = []

  if (msg.thinking?.length) {
    sections.push({
      type: 'thinking',
      blocks: msg.thinking.map(b => ({ type: 'thinking' as const, refId: b.id })),
    })
  }

  if (msg.toolCalls?.length) {
    sections.push({
      type: 'toolCall',
      blocks: msg.toolCalls.map(tc => ({ type: 'toolCall' as const, refId: tc.id })),
    })
  }

  if (msg.content) {
    sections.push({
      type: 'text',
      blocks: [{ type: 'text' as const, refId: 'text' }],
    })
  }

  return sections
}
