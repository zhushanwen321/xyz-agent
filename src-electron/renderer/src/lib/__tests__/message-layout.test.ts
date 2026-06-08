/**
 * message-layout 分组逻辑单元测试 — Phase 4 Core Test Cases
 *
 * 覆盖测试用例 (test_cases_template.json):
 *   TC-12: AC-5 场景A — 合并+text+合并
 *   TC-13: AC-5 场景B — edit 独立展示
 *   TC-14: AC-5 场景C — 混合含 standalone + customTool
 *   TC-15: AC-5 场景D — standaloneTools 变更影响
 *   TC-18: AC-7 — 旧消息兼容（无 contentBlocks）
 *   TC-19: AC-7 — compactStreaming=false 不受影响
 */

import { describe, it, expect } from 'vitest'
import { groupIntoSections, ALL_PI_TOOLS, type AssistantSection } from '../message-layout'
import type { ContentBlock, Message, ThinkingBlock, ToolCall } from '@xyz-agent/shared'

// ── Helpers ────────────────────────────────────────────────

let idCounter = 0
function nextId(prefix: string): string {
  idCounter++
  return `${prefix}-${idCounter}`
}

function makeThinking(content = 'thinking'): ThinkingBlock {
  return {
    id: nextId('thk'),
    content,
    collapsed: false,
    startTime: Date.now(),
    endTime: Date.now() + 100,
  }
}

function makeToolCall(toolName: string, status: ToolCall['status'] = 'completed'): ToolCall {
  return {
    id: nextId('tc'),
    toolName,
    input: { file_path: `src/${toolName}.ts` },
    status,
    startTime: Date.now(),
    endTime: Date.now() + 200,
  }
}

function makeMessage(blocks: ContentBlock[], toolCalls: ToolCall[], opts: {
  content?: string
  thinking?: ThinkingBlock[]
} = {}): Message {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: opts.content ?? '',
    status: 'complete',
    toolCalls,
    thinking: opts.thinking ?? [],
    contentBlocks: blocks,
    timestamp: Date.now(),
  }
}

function blockIds(section: AssistantSection): string[] {
  return section.blocks.map(b => b.refId)
}

function sectionTypes(sections: AssistantSection[]): string[] {
  return sections.map(s => s.type)
}

// ── TC-12: 合并+text+合并 (AC-5 场景A) ──────────────────────

describe('TC-12: AC-5 场景A — 合并+text+合并', () => {
  it('groups [thk, tc-read, tc-bash, text, thk, tc-read, thk, tc-grep] correctly', () => {
    const thk1 = makeThinking('a')
    const tcRead1 = makeToolCall('read')
    const tcBash = makeToolCall('bash')
    const thk2 = makeThinking('b')
    const tcRead2 = makeToolCall('read')
    const thk3 = makeThinking('c')
    const tcGrep = makeToolCall('grep')

    const blocks: ContentBlock[] = [
      { type: 'thinking', refId: thk1.id },
      { type: 'toolCall', refId: tcRead1.id },
      { type: 'toolCall', refId: tcBash.id },
      { type: 'text', refId: 'text' },
      { type: 'thinking', refId: thk2.id },
      { type: 'toolCall', refId: tcRead2.id },
      { type: 'thinking', refId: thk3.id },
      { type: 'toolCall', refId: tcGrep.id },
    ]
    const msg = makeMessage(blocks, [tcRead1, tcBash, tcRead2, tcGrep], {
      content: 'final answer',
      thinking: [thk1, thk2, thk3],
    })
    const standalone = new Set(['write', 'edit'])

    const sections = groupIntoSections(msg, standalone)

    expect(sectionTypes(sections)).toEqual(['merge', 'text', 'merge'])
    expect(blockIds(sections[0])).toEqual([thk1.id, tcRead1.id, tcBash.id])
    expect(sections[1].type).toBe('text')
    expect(blockIds(sections[2])).toEqual([thk2.id, tcRead2.id, thk3.id, tcGrep.id])
  })
})

// ── TC-13: edit 独立展示 (AC-5 场景B) ─────────────────────

describe('TC-13: AC-5 场景B — edit 独立展示', () => {
  it('groups [thk, text, edit, text] with edit in standaloneTools', () => {
    const thk1 = makeThinking('a')
    const editTc = makeToolCall('edit')

    const blocks: ContentBlock[] = [
      { type: 'thinking', refId: thk1.id },
      { type: 'text', refId: 'text-1' },
      { type: 'toolCall', refId: editTc.id },
      { type: 'text', refId: 'text-2' },
    ]
    const msg = makeMessage(blocks, [editTc], {
      content: 'final answer',
      thinking: [thk1],
    })
    const standalone = new Set(['write', 'edit'])

    const sections = groupIntoSections(msg, standalone)

    expect(sectionTypes(sections)).toEqual(['merge', 'text', 'standalone'])
    expect(blockIds(sections[0])).toEqual([thk1.id])
    expect(sections[1].type).toBe('text')
    expect(sections[2].type).toBe('standalone')
    expect(blockIds(sections[2])).toEqual([editTc.id])
  })
})

// ── TC-14: 混合含 standalone + customTool (AC-5 场景C) ──────

describe('TC-14: AC-5 场景C — 混合含 standalone + customTool', () => {
  it('groups [thk, tc-read, write, thk, tc-bash, text, subagent, text]', () => {
    const thk1 = makeThinking('a')
    const tcRead = makeToolCall('read')
    const writeTc = makeToolCall('write')
    const thk2 = makeThinking('b')
    const tcBash = makeToolCall('bash')
    const subagent = makeToolCall('subagent')  // custom tool (not in ALL_PI_TOOLS)

    const blocks: ContentBlock[] = [
      { type: 'thinking', refId: thk1.id },
      { type: 'toolCall', refId: tcRead.id },
      { type: 'toolCall', refId: writeTc.id },
      { type: 'thinking', refId: thk2.id },
      { type: 'toolCall', refId: tcBash.id },
      { type: 'text', refId: 'text' },
      { type: 'toolCall', refId: subagent.id },
      { type: 'text', refId: 'text' },
    ]
    const msg = makeMessage(blocks, [tcRead, writeTc, tcBash, subagent], {
      content: 'final',
      thinking: [thk1, thk2],
    })
    const standalone = new Set(['write', 'edit'])

    const sections = groupIntoSections(msg, standalone)

    expect(sectionTypes(sections)).toEqual(['merge', 'standalone', 'merge', 'text', 'customTool'])
    expect(blockIds(sections[0])).toEqual([thk1.id, tcRead.id])
    expect(blockIds(sections[1])).toEqual([writeTc.id])
    expect(blockIds(sections[2])).toEqual([thk2.id, tcBash.id])
    expect(sections[3].type).toBe('text')
    expect(blockIds(sections[4])).toEqual([subagent.id])
  })
})

// ── TC-15: standaloneTools 变更影响 (AC-5 场景D) ───────────

describe('TC-15: AC-5 场景D — standaloneTools 变更影响', () => {
  it('bash in standaloneTools becomes standalone block', () => {
    const thk1 = makeThinking('a')
    const tcBash = makeToolCall('bash')

    const blocks: ContentBlock[] = [
      { type: 'thinking', refId: thk1.id },
      { type: 'toolCall', refId: tcBash.id },
    ]
    const msg = makeMessage(blocks, [tcBash], {
      thinking: [thk1],
    })
    // bash now in standaloneTools
    const standalone = new Set(['write', 'edit', 'bash'])

    const sections = groupIntoSections(msg, standalone)

    expect(sectionTypes(sections)).toEqual(['merge', 'standalone'])
    expect(blockIds(sections[0])).toEqual([thk1.id])
    expect(blockIds(sections[1])).toEqual([tcBash.id])
  })

  it('bash NOT in standaloneTools merges into MergeBlock', () => {
    const thk1 = makeThinking('a')
    const tcBash = makeToolCall('bash')

    const blocks: ContentBlock[] = [
      { type: 'thinking', refId: thk1.id },
      { type: 'toolCall', refId: tcBash.id },
    ]
    const msg = makeMessage(blocks, [tcBash], {
      thinking: [thk1],
    })
    // default: bash not in standaloneTools
    const standalone = new Set(['write', 'edit'])

    const sections = groupIntoSections(msg, standalone)

    expect(sectionTypes(sections)).toEqual(['merge'])
    expect(blockIds(sections[0])).toEqual([thk1.id, tcBash.id])
  })
})

// ── TC-18: 旧消息兼容 - 无 contentBlocks ────────────────────

describe('TC-18: AC-7 — 旧消息兼容 (无 contentBlocks)', () => {
  it('legacy message with thinking/toolCalls/content goes through groupByLegacyFields', () => {
    const thk = makeThinking('legacy thinking')
    const tc = makeToolCall('read')
    const msg: Message = {
      id: 'legacy-1',
      role: 'assistant',
      content: 'legacy content',
      status: 'complete',
      thinking: [thk],
      toolCalls: [tc],
      // no contentBlocks
      timestamp: Date.now(),
    }
    // Pass undefined for standaloneTools to force legacy path
    const sections = groupIntoSections(msg, undefined)

    expect(sectionTypes(sections)).toEqual(['thinking', 'toolCall', 'text'])
    expect(sections[0].blocks).toHaveLength(1)
    expect(sections[1].blocks).toHaveLength(1)
    expect(sections[2].type).toBe('text')
  })

  it('legacy message with only content', () => {
    const msg: Message = {
      id: 'legacy-2',
      role: 'assistant',
      content: 'just text',
      status: 'complete',
      timestamp: Date.now(),
    }
    const sections = groupIntoSections(msg, undefined)
    expect(sectionTypes(sections)).toEqual(['text'])
  })
})

// ── TC-19: compactStreaming=false 不受影响 ─────────────────

describe('TC-19: AC-7 — compactStreaming=false (无 standaloneTools)', () => {
  it('adjacent same-type merge when standaloneTools is undefined', () => {
    const thk1 = makeThinking('a')
    const thk2 = makeThinking('b')
    const tcRead = makeToolCall('read')

    const blocks: ContentBlock[] = [
      { type: 'thinking', refId: thk1.id },
      { type: 'thinking', refId: thk2.id },
      { type: 'toolCall', refId: tcRead.id },
    ]
    const msg = makeMessage(blocks, [tcRead], { thinking: [thk1, thk2] })

    // No standaloneTools → legacy path (groupByContentBlocksLegacy)
    const sections = groupIntoSections(msg, undefined)

    // Legacy: adjacent same-type merge
    expect(sectionTypes(sections)).toEqual(['thinking', 'toolCall'])
    expect(sections[0].blocks).toHaveLength(2)
    expect(sections[1].blocks).toHaveLength(1)
  })

  it('adjacent same-type merge when standaloneTools is empty Set', () => {
    // When compactStreaming=false, caller passes undefined (NOT an empty Set)
    // This test confirms that an empty Set is treated as legacy-grouping path? No —
    // groupByContentBlocks treats empty Set as "no tools are standalone", so
    // all pi-built-in tool calls merge. But non-pi tools still go standalone.
    const thk1 = makeThinking('a')
    const tcRead = makeToolCall('read')

    const blocks: ContentBlock[] = [
      { type: 'thinking', refId: thk1.id },
      { type: 'toolCall', refId: tcRead.id },
    ]
    const msg = makeMessage(blocks, [tcRead], { thinking: [thk1] })

    const sections = groupIntoSections(msg, new Set())
    // tc-read is built-in + not in empty Set → merge block
    expect(sectionTypes(sections)).toEqual(['merge'])
  })
})

// ── ALL_PI_TOOLS sanity ─────────────────────────────────────

describe('ALL_PI_TOOLS constant', () => {
  it('contains exactly 7 pi built-in tools', () => {
    expect(ALL_PI_TOOLS).toHaveLength(7)
    expect([...ALL_PI_TOOLS].sort()).toEqual(['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write'])
  })
})
