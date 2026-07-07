/**
 * expandAssistantBlocks 纯函数单测 —— 单条 assistant Message 内部块按真实时序展开。
 *
 * 背景（draft-message-stream §4）：trace 区应按 contentBlocks 真实时序渲染 7 类块。
 * expandAssistantBlocks 把 contentBlocks（索引数组）解成 OrderedBlock[]（带 ref），
 * 供 Turn.vue v-for 渲染。修复「text 在最下方、上方 tool call 还在更新」乱序 bug。
 *
 * 覆盖：
 * - B1：有 contentBlocks，严格按其顺序输出（thinking/text/tool/thinking 交替）
 * - B2：text 块 ref = msg.content（完整字符串，非单 chunk）
 * - B3：无 contentBlocks（降级）→ 旧顺序 text→thinking→tool
 * - B4：contentBlocks 引用不存在的 thinking/toolCall id → 跳过（防御异常数据）
 * - B5：空 contentBlocks + 无内容 → 空数组
 *
 * 运行：npx vitest run src/__tests__/composables/message-turns.test.ts
 */
import { describe, it, expect } from 'vitest'
import { expandAssistantBlocks } from '@/composables/logic/messageTurns'
import type { Message } from '@xyz-agent/shared'

function makeMsg(over: Partial<Message> = {}): Message {
  return { id: 'a1', role: 'assistant', content: '', status: 'complete', timestamp: Date.now(), ...over }
}

describe('expandAssistantBlocks —— 单条 assistant 内部块按时序展开', () => {
  it('B1: 有 contentBlocks → 严格按其顺序输出（thinking→text→tool→thinking 交替）', () => {
    const msg = makeMsg({
      content: '中间产出',
      thinking: [
        { id: 'th1', content: '推理1', collapsed: true },
        { id: 'th2', content: '推理2', collapsed: true },
      ],
      toolCalls: [
        { id: 'tc1', toolName: 'grep', input: {}, status: 'completed', startTime: 0 },
      ],
      contentBlocks: [
        { type: 'thinking', refId: 'th1' },
        { type: 'text', refId: 'text' },
        { type: 'toolCall', refId: 'tc1' },
        { type: 'thinking', refId: 'th2' },
      ],
    })
    const result = expandAssistantBlocks(msg)
    expect(result.map((b) => b.kind)).toEqual(['thinking', 'text', 'tool', 'thinking'])
    expect(result.map((b) => b.kind)).not.toEqual(['text', 'thinking', 'tool', 'thinking'])
  })

  it('B2: text 块 ref = msg.content（完整字符串，非单 chunk delta）', () => {
    const msg = makeMsg({
      content: '完整文本',
      contentBlocks: [{ type: 'text', refId: 'text' }],
    })
    const result = expandAssistantBlocks(msg)
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('text')
    expect(result[0].ref).toBe('完整文本')
  })

  it('B3: 无 contentBlocks（降级）→ 旧顺序 text→thinking→tool', () => {
    const msg = makeMsg({
      content: '文本',
      thinking: [{ id: 'th1', content: '推理', collapsed: true }],
      toolCalls: [{ id: 'tc1', toolName: 'grep', input: {}, status: 'completed', startTime: 0 }],
      // 无 contentBlocks
    })
    const result = expandAssistantBlocks(msg)
    expect(result.map((b) => b.kind)).toEqual(['text', 'thinking', 'tool'])
  })

  it('B4: contentBlocks 引用不存在的 thinking/toolCall id → 跳过（防御异常数据）', () => {
    const msg = makeMsg({
      content: '文本',
      thinking: [{ id: 'th1', content: '推理', collapsed: true }],
      // 只有一个 toolCall，但 contentBlocks 引用了 tc2（不存在）
      toolCalls: [{ id: 'tc1', toolName: 'grep', input: {}, status: 'completed', startTime: 0 }],
      contentBlocks: [
        { type: 'text', refId: 'text' },
        { type: 'thinking', refId: 'th_missing' }, // 不存在 → 跳过
        { type: 'toolCall', refId: 'tc_missing' }, // 不存在 → 跳过
        { type: 'thinking', refId: 'th1' },
      ],
    })
    const result = expandAssistantBlocks(msg)
    // 只解出 text + th1（两个 missing 被跳过）
    expect(result.map((b) => b.kind)).toEqual(['text', 'thinking'])
    const thRef = result[1].ref as { id: string }
    expect(thRef.id).toBe('th1')
  })

  it('B5: 空 contentBlocks + 无内容 → 空数组', () => {
    const msg = makeMsg({ content: '', contentBlocks: [] })
    expect(expandAssistantBlocks(msg)).toEqual([])
  })
})
