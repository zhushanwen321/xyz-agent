/**
 * 消息布局分组逻辑（纯函数，无 Vue 依赖）
 *
 * 两层分组：
 * 1. Turn 级：flat messages → turns（user 开始新 turn，assistant/system 追加）
 * 2. Section 级：单条 assistant message → sections（thinking/toolCall 合并为 merge，text/standalone/customTool 独立）
 */

import type { ContentBlock, Message } from '@xyz-agent/shared'
import type { ChatMessage } from '../stores/chat'

// ── Turn grouping ──────────────────────────────────────────

export interface Turn {
  /** v-for key（取 turn 中第一条消息的 id） */
  key: string
  /** turn 内的消息列表 */
  messages: ChatMessage[]
  /** Pre-computed first assistant message ID in this turn */
  _firstAssistantId?: string
  /** Pre-computed last assistant message ID in this turn */
  _lastAssistantId?: string
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

export type SectionType = 'merge' | 'text' | 'standalone' | 'customTool'

export interface AssistantSection {
  type: SectionType
  /** contentBlocks 或构造出的虚拟 blocks */
  blocks: ContentBlock[]
}

/**
 * 将单条 assistant message 的内容按类型分组。
 *
 * 统一处理有/无 contentBlocks 两种情况，无论哪种路径
 * 都返回相同的 section type：'merge' | 'text' | 'standalone' | 'customTool'。
 */
export function groupIntoSections(msg: Message, standaloneTools: Set<string>): AssistantSection[] {
  if (msg.contentBlocks?.length) {
    return groupByContentBlocks(msg, standaloneTools)
  }
  return groupByFallbackFields(msg, standaloneTools)
}

// ── Block-type classification ───────────────────────────────

/** All pi built-in tool names */
export const ALL_PI_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] as const

/** Check if a block should be merged into a MergeBlock */
function isMergeBlock(block: ContentBlock, msg: Message, standaloneTools: Set<string>): boolean {
  if (block.type === 'thinking') return true
  if (block.type === 'toolCall') {
    const tc = msg.toolCalls?.find(t => t.id === block.refId)
    // Orphaned block (refId not found) → merge as fallback to avoid silent discard
    if (!tc) return true
    // Not in standaloneTools AND is a built-in tool → merge; custom tools → always standalone
    return (ALL_PI_TOOLS as readonly string[]).includes(tc.toolName) && !standaloneTools.has(tc.toolName)
  }
  return false
}

/** Grouping: classify by block type and standaloneTools setting */
function groupByContentBlocks(msg: Message, standaloneTools: Set<string>): AssistantSection[] {
  const sections: AssistantSection[] = []
  let mergeBlocks: ContentBlock[] = []

  function flushMerge() {
    if (mergeBlocks.length > 0) {
      sections.push({ type: 'merge', blocks: mergeBlocks })
      mergeBlocks = []
    }
  }

  let hasText = false

  for (const block of msg.contentBlocks!) {
    if (isMergeBlock(block, msg, standaloneTools)) {
      mergeBlocks.push(block)
    } else {
      flushMerge()
      if (block.type === 'text') {
        // Skip empty text or duplicate text blocks (message.content rendered once)
        if (!msg.content || hasText) continue
        hasText = true
        sections.push({ type: 'text', blocks: [block] })
      } else if (block.type === 'toolCall') {
        const tc = msg.toolCalls?.find(t => t.id === block.refId)
        const isCustom = tc ? !(ALL_PI_TOOLS as readonly string[]).includes(tc.toolName) : false
        sections.push({ type: isCustom ? 'customTool' : 'standalone', blocks: [block] })
      }
    }
  }

  flushMerge()
  return sections
}

/**
 * 无 contentBlocks → 从 thinking/toolCalls/content 构造虚拟 blocks，
 * 然后复用 groupByContentBlocks 统一分组。
 */
function groupByFallbackFields(msg: Message, standaloneTools: Set<string>): AssistantSection[] {
  const blocks: ContentBlock[] = []

  if (msg.thinking?.length) {
    for (const b of msg.thinking) {
      blocks.push({ type: 'thinking', refId: b.id })
    }
  }

  if (msg.toolCalls?.length) {
    for (const tc of msg.toolCalls) {
      blocks.push({ type: 'toolCall', refId: tc.id })
    }
  }

  if (msg.content) {
    blocks.push({ type: 'text', refId: 'text' })
  }

  // Construct a virtual message with synthetic contentBlocks
  const virtualMsg = { ...msg, contentBlocks: blocks }
  return groupByContentBlocks(virtualMsg, standaloneTools)
}
