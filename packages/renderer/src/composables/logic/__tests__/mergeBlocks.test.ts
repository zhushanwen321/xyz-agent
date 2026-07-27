/**
 * mergeConsecutiveBlocks 单测——w2 wave IF2/CT-w2-1 契约验证 + agentgraph 断点（IF3）。
 *
 * 覆盖用例：空输入、单块、连续同类合并、text 不合并、失败 tool 断链、
 * 异类断链、混合序列、副作用（纯函数不改输入）、agentgraph 永不合并（3 个用例）。
 */
import { describe, it, expect } from 'vitest'
import type { ToolCall, ThinkingBlock, ToolCallStatus } from '@xyz-agent/shared'
import type { OrderedBlock } from '../messageTurns'
import { mergeConsecutiveBlocks } from '../mergeBlocks'

/** 构造一个 tool OrderedBlock；status 默认 completed（非失败，参与合并）。 */
function makeTool(name: string, status: ToolCallStatus = 'completed'): OrderedBlock {
  return {
    kind: 'tool',
    ref: {
      id: `${name}-id`,
      toolName: name,
      input: {},
      status,
      startTime: 0,
    } as ToolCall,
  }
}

/**
 * 构造一个 agentgraph OrderedBlock（subagent/workflow 的 tool_call）。
 * 数据结构同 tool（ref 是 ToolCall），但 kind 标为 'agentgraph'——
 * mergeBlocks 中是断点，永不合并（既不并入普通 tool 组也不与其他 agentgraph 合并）。
 */
function makeAgentgraph(name: string, status: ToolCallStatus = 'completed'): OrderedBlock {
  return {
    kind: 'agentgraph',
    ref: {
      id: `${name}-id`,
      toolName: name,
      input: {},
      status,
      startTime: 0,
    } as ToolCall,
  }
}

/** 构造一个 thinking OrderedBlock。 */
function makeThink(id = 'think'): OrderedBlock {
  return {
    kind: 'thinking',
    ref: { id, content: '...', collapsed: false } as ThinkingBlock,
  }
}

/** 构造一个 text OrderedBlock（ref 直接是字符串）。 */
function makeText(s = 'text'): OrderedBlock {
  return { kind: 'text', ref: s }
}

describe('mergeConsecutiveBlocks (w2 wave IF2)', () => {
  it('TC-w2-1: 空输入返回空数组', () => {
    expect(mergeConsecutiveBlocks([])).toEqual([])
  })

  it('TC-w2-2: 单个 tool block → 1 个 single', () => {
    const block = makeTool('read')
    const result = mergeConsecutiveBlocks([block])
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ kind: 'single', type: 'tool', block })
  })

  it('TC-w2-3: 3 个连续 tool → 1 个 merged，items 顺序 A→B→C', () => {
    const a = makeTool('read')
    const b = makeTool('edit')
    const c = makeTool('read')
    const result = mergeConsecutiveBlocks([a, b, c])
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      kind: 'merged',
      type: 'tool',
      items: [a, b, c],
    })
  })

  it('TC-w2-4: 2 个连续 thinking → 1 个 merged type=thinking', () => {
    const a = makeThink('t1')
    const b = makeThink('t2')
    const result = mergeConsecutiveBlocks([a, b])
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      kind: 'merged',
      type: 'thinking',
      items: [a, b],
    })
  })

  it('TC-w2-5: 2 个连续 text → 2 个独立 single（text 不合并）', () => {
    const a = makeText('hello')
    const b = makeText('world')
    const result = mergeConsecutiveBlocks([a, b])
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ kind: 'single', type: 'text', block: a })
    expect(result[1]).toEqual({ kind: 'single', type: 'text', block: b })
  })

  it('TC-w2-6: 不同 toolName 同 kind=tool → 1 个 merged（按 kind 合并）', () => {
    const read = makeTool('read')
    const edit = makeTool('edit')
    const result = mergeConsecutiveBlocks([read, edit])
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      kind: 'merged',
      type: 'tool',
      items: [read, edit],
    })
  })

  it('TC-w2-7: [okTool, failTool, okTool] → 3 个独立 single（失败断链）', () => {
    const ok1 = makeTool('read')
    const fail = makeTool('edit', 'error')
    const ok2 = makeTool('read')
    const result = mergeConsecutiveBlocks([ok1, fail, ok2])
    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({ kind: 'single', type: 'tool', block: ok1 })
    expect(result[1]).toEqual({ kind: 'single', type: 'tool', block: fail })
    expect(result[2]).toEqual({ kind: 'single', type: 'tool', block: ok2 })
  })

  it('TC-w2-8: [okA, okB, failTool, okC] → merged[okA,okB] + single fail + single okC', () => {
    const a = makeTool('read')
    const b = makeTool('edit')
    const fail = makeTool('write', 'error')
    const c = makeTool('read')
    const result = mergeConsecutiveBlocks([a, b, fail, c])
    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({
      kind: 'merged',
      type: 'tool',
      items: [a, b],
    })
    expect(result[1]).toEqual({ kind: 'single', type: 'tool', block: fail })
    expect(result[2]).toEqual({ kind: 'single', type: 'tool', block: c })
  })

  it('TC-w2-9: [thinkA, toolA, toolB, textA, thinkB] → single thinkA + merged[toolA,toolB] + single textA + single thinkB', () => {
    const thinkA = makeThink('ta')
    const toolA = makeTool('read')
    const toolB = makeTool('edit')
    const textA = makeText('hi')
    const thinkB = makeThink('tb')
    const result = mergeConsecutiveBlocks([thinkA, toolA, toolB, textA, thinkB])
    expect(result).toHaveLength(4)
    expect(result[0]).toEqual({ kind: 'single', type: 'thinking', block: thinkA })
    expect(result[1]).toEqual({
      kind: 'merged',
      type: 'tool',
      items: [toolA, toolB],
    })
    expect(result[2]).toEqual({ kind: 'single', type: 'text', block: textA })
    expect(result[3]).toEqual({ kind: 'single', type: 'thinking', block: thinkB })
  })

  it('TC-w2-11: 连续两个失败 tool 各自独立 single，不合并', () => {
    // reviewer B S2 边界：失败 tool 是合并断点，连续两个失败也不应相互合并
    const failA = makeTool('read', 'error')
    const failB = makeTool('edit', 'error')
    const result = mergeConsecutiveBlocks([failA, failB])
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ kind: 'single', type: 'tool', block: failA })
    expect(result[1]).toEqual({ kind: 'single', type: 'tool', block: failB })
  })

  /* ── agentgraph（subagent/workflow）断点：永不合并，是 merge 链断点（IF3）── */

  it('TC-ag-1: [普通 tool, agentgraph(subagent), 普通 tool] → 3 个 single（agentgraph 断开合并链）', () => {
    // agentgraph 是断点：两侧普通 tool 各自 single，不能跨越 agentgraph 合并
    const ok1 = makeTool('read')
    const sa = makeAgentgraph('subagent')
    const ok2 = makeTool('edit')
    const result = mergeConsecutiveBlocks([ok1, sa, ok2])
    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({ kind: 'single', type: 'tool', block: ok1 })
    expect(result[1]).toEqual({ kind: 'single', type: 'agentgraph', block: sa })
    expect(result[2]).toEqual({ kind: 'single', type: 'tool', block: ok2 })
  })

  it('TC-ag-2: [agentgraph, agentgraph] → 2 个 single（agentgraph 之间也不合并）', () => {
    // 即使连续两个 agentgraph 也不相互合并——图结构重型操作各自独立醒目展示
    const sa1 = makeAgentgraph('subagent')
    const wf = makeAgentgraph('workflow')
    const result = mergeConsecutiveBlocks([sa1, wf])
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ kind: 'single', type: 'agentgraph', block: sa1 })
    expect(result[1]).toEqual({ kind: 'single', type: 'agentgraph', block: wf })
  })

  it('TC-ag-3: [普通 tool, 普通 tool] → 1 个 merged（agentgraph 不影响普通 tool 合并）', () => {
    // 回归守卫：新增 agentgraph 断点逻辑不应破坏普通 tool 的合并行为
    const a = makeTool('read')
    const b = makeTool('edit')
    const result = mergeConsecutiveBlocks([a, b])
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      kind: 'merged',
      type: 'tool',
      items: [a, b],
    })
  })

  it('TC-w2-10: 副作用——输入数组 length 与元素引用不变', () => {
    const a = makeTool('read')
    const b = makeTool('edit')
    const c = makeThink('t')
    const input: OrderedBlock[] = [a, b, c]
    const snapshotLen = input.length
    const snapshotRefs = input.slice()

    mergeConsecutiveBlocks(input)

    expect(input.length).toBe(snapshotLen)
    input.forEach((item, i) => {
      expect(item).toBe(snapshotRefs[i])
    })
  })
})
