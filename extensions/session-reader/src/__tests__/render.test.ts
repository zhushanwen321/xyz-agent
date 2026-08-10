import { describe, it, expect } from 'vitest'
import { renderOutline, renderExpand, renderDetail } from '../core/render.js'
import type { Entry } from '../core/parser.js'
import type { Turn } from '../core/turns.js'
import type { TreeView } from '../core/tree.js'
import { parseSessionFile } from '../core/parser.js'
import { buildTreeView } from '../core/tree.js'
import { segmentTurns } from '../core/turns.js'

// ---- 构造助手 ----

function uEntry(id: string, text: string): Entry {
  return {
    type: 'message',
    id,
    parentId: null,
    message: { role: 'user', content: [{ type: 'text', text }] },
  }
}

function aEntry(
  id: string,
  text: string,
  toolCalls?: Array<{ name: string }>,
  thinking?: string,
): Entry {
  const content: unknown[] = [{ type: 'text', text }]
  if (thinking !== undefined) content.push({ type: 'thinking', thinking })
  const message: NonNullable<Entry['message']> = { role: 'assistant', content }
  if (toolCalls !== undefined) message.toolCalls = toolCalls
  return { type: 'message', id, parentId: null, message }
}

function tEntry(id: string, content: string): Entry {
  return { type: 'message', id, parentId: null, message: { role: 'toolResult', content } }
}

function turn(
  idx: number,
  entries: Entry[],
  opts: { userEntry?: Entry; isCompaction?: boolean; startTime?: string } = {},
): Turn {
  const t: Turn = {
    index: idx,
    entries,
    userEntry: opts.userEntry,
    isCompaction: opts.isCompaction ?? false,
  }
  if (opts.startTime !== undefined) t.startTime = opts.startTime
  return t
}

function emptyTree(): TreeView {
  return { leafPath: [], branches: new Map(), orphans: [] }
}

const REAL_SESSION =
  '/Users/zhushanwen/.pi/agent/sessions/--Users-zhushanwen-Code-xyz-agent-workspace-feat-plugin-arch-3--/2026-05-28T03-17-12-844Z_019e6c96-0a0c-74b8-a73f-d1854d88e2a7.jsonl'

describe('renderOutline', () => {
  it('1. 预算充足 → 全部字段完整渲染（userBrief 截断 / toolSummary 聚合 / omittedBytes 正确）', () => {
    const t = turn(0, [
      uEntry('U', 'do something'),
      aEntry('A', 'sure', [{ name: 'bash' }, { name: 'bash' }, { name: 'read' }, { name: 'read' }], 'secret'),
      tEntry('T', 'output'),
    ], { userEntry: uEntry('U', 'do something') })

    const result = renderOutline([t], emptyTree(), { budget: 2000 })
    const b = result.turns[0]

    expect(b.userBrief).toBe('do something') // 12 chars，未截断
    expect(b.toolSummary).toBe('bash×2,read×2')
    expect(b.assistantBrief).toBe('sure')
    // thinking 'secret'(6B) + toolResult 'output'(6B)
    expect(b.omittedBytes).toBe(12)
    expect(result.truncated).toBeUndefined()
  })

  it('2a. 降级：单行 toolSummary 过长超 perTurnBudget → 砍 toolSummary，保 userBrief 骨架', () => {
    // L1 行不含 assistantBrief（design §3.5 算法1 step2）；budget=40, 3 turns → perTurnCharBudget≈53
    // 行 = head + userBrief(10) + toolSummary(20 个工具名≈63 chars) → ~80 > 53 → 砍 toolSummary
    const toolCalls = Array.from({ length: 20 }, (_, k) => ({ name: `t${String(k).padStart(2, '0')}` }))
    const turns = [0, 1, 2].map((i) =>
      turn(i, [uEntry(`U${i}`, 'u'.repeat(10)), aEntry(`A${i}`, 'a'.repeat(10), toolCalls)], {
        userEntry: uEntry(`U${i}`, 'u'.repeat(10)),
      }),
    )
    const result = renderOutline(turns, emptyTree(), { budget: 40 })

    expect(result.turns).toHaveLength(3)
    for (const b of result.turns) {
      expect(b.toolSummary).toBe('') // 被砍（降级）
      expect(b.userBrief).toBe('u'.repeat(10)) // 骨架保留
    }
    expect(result.truncated).toBeUndefined()
  })

  it('3. 总超预算 → truncated 计数 > 0（从尾部丢弃）', () => {
    // budget=10, 5 turns → 每行降级到骨架 17 chars；total 85/4=21>10 → 截断保留 2，truncated=3
    const turns = [0, 1, 2, 3, 4].map((i) =>
      turn(i, [uEntry(`U${i}`, 'u'.repeat(10)), aEntry(`A${i}`, 'a'.repeat(10))], {
        userEntry: uEntry(`U${i}`, 'u'.repeat(10)),
      }),
    )
    const result = renderOutline(turns, emptyTree(), { budget: 10 })

    expect(result.truncated).toBe(3)
    expect(result.turns).toHaveLength(2)
  })

  it('4. toolSummary 聚合：同名计数 ×N，不同名逗号分隔', () => {
    const t = turn(
      0,
      [uEntry('U', 'q'), aEntry('A', 'r', [{ name: 'bash' }, { name: 'bash' }, { name: 'read' }, { name: 'read' }, { name: 'edit' }])],
      { userEntry: uEntry('U', 'q') },
    )
    const result = renderOutline([t], emptyTree(), { budget: 2000 })
    expect(result.turns[0].toolSummary).toBe('bash×2,read×2,edit')
  })

  it('5. omittedBytes = toolResult content + thinking 字节和', () => {
    const t = turn(
      0,
      [uEntry('U', 'q'), aEntry('A', 'r', undefined, 'th'), tEntry('T', 'out')],
      { userEntry: uEntry('U', 'q') },
    )
    const result = renderOutline([t], emptyTree(), { budget: 2000 })
    // thinking 'th'(2B) + toolResult 'out'(3B) = 5
    expect(result.turns[0].omittedBytes).toBe(5)
  })

  it('6. granularity:entry → 不聚合，每 entry 一行', () => {
    const turns = [
      turn(0, [uEntry('U0', 'a'), aEntry('A0', 'b')], { userEntry: uEntry('U0', 'a') }),
      turn(1, [uEntry('U1', 'c')], { userEntry: uEntry('U1', 'c') }),
    ]
    const result = renderOutline(turns, emptyTree(), { granularity: 'entry', budget: 2000 })
    // 3 leaf entries → 3 行
    expect(result.turns).toHaveLength(3)
    expect(result.turns.map((b) => b.index)).toEqual([0, 1, 2])
  })

  it('7. allBranches:true → forkPoint 处标注 branch', () => {
    const tree: TreeView = { leafPath: ['U'], branches: new Map([['U', 3]]), orphans: [] }
    const userEntry = uEntry('U', 'hi')
    const turns = [turn(0, [userEntry], { userEntry })]

    const withBranches = renderOutline(turns, tree, { allBranches: true })
    expect(withBranches.turns[0].branch).toBe('U')

    const withoutBranches = renderOutline(turns, tree, { allBranches: false })
    expect(withoutBranches.turns[0].branch).toBeUndefined()
  })

  it('8. 真实 019e6c96：outline tokenEstimate <= 600（design V3 基线）', async () => {
    // 32 turn（见 turns.test.ts 真实用例说明：26 基线为旧 user-only 定义）
    const parsed = await parseSessionFile(REAL_SESSION)
    const tree = buildTreeView(parsed.entries)
    const turns = segmentTurns(parsed.entries, new Set(tree.leafPath))
    const result = renderOutline(turns, tree, { budget: 2000 })

    expect(result.turns.length).toBe(32)
    expect(result.tokenEstimate).toBeLessThanOrEqual(600)
    // stats 完整性
    expect(result.stats.totalTurns).toBe(32)
    // totalEntries 近似（leaf+branch+orphan）不含 session header（segmentTurns 规则1 跳过）；
    // 准确值由 M2 工具层用 ParseResult.totalEntries 覆盖。M1 验量级。
    expect(result.stats.totalEntries).toBeGreaterThan(1000)
  })
})

describe('renderExpand', () => {
  it('单轮展开：header 含 entry 数 + 每个 entry brief', () => {
    const t = turn(
      0,
      [uEntry('U', 'hello world'), aEntry('A', 'ok'), tEntry('T', 'result text')],
      { userEntry: uEntry('U', 'hello world'), startTime: '2026-05-28T03:17:12.844Z' },
    )
    const out = renderExpand(t)

    expect(out.turn).toContain('3 entries')
    expect(out.turn).toContain('03:17')
    expect(out.entries).toHaveLength(3)
    expect(out.entries[0]).toMatchObject({ index: 0, type: 'message', role: 'user' })
    expect(out.entries[0].brief).toBe('hello world')
    expect(out.entries[1].role).toBe('assistant')
    expect(out.entries[2].role).toBe('toolResult')
    // toolResult 的 omittedBytes = content 字节
    expect(out.entries[2].omittedBytes).toBe(Buffer.byteLength('result text', 'utf8'))
  })
})

describe('renderDetail', () => {
  it('默认过滤 toolResult 与 thinking；includeToolResult/includeThinking 取回', () => {
    const t = turn(0, [
      uEntry('U', 'q'),
      aEntry('A', 'visible', undefined, 'hidden-thinking'),
      tEntry('T', 'tool-output'),
    ], { userEntry: uEntry('U', 'q') })

    // 默认：toolResult entry 被丢，thinking 块被剥离
    const defaultOut = renderDetail([t])
    expect(defaultOut).toHaveLength(2) // user + assistant（toolResult 丢）
    const assistantDefault = defaultOut.find((e) => e.message?.role === 'assistant')!
    expect(extractTextForTest(assistantDefault.message!.content)).toBe('visible')

    // includeToolResult：toolResult entry 回来
    const withTool = renderDetail([t], { includeToolResult: true })
    expect(withTool).toHaveLength(3)
    expect(withTool.some((e) => e.message?.role === 'toolResult')).toBe(true)

    // includeThinking：thinking 块回来
    const withThinking = renderDetail([t], { includeThinking: true })
    const assistantThinking = withThinking.find((e) => e.message?.role === 'assistant')!
    expect(extractTextForTest(assistantThinking.message!.content)).toBe('visible')
    expect(extractThinkingForTest(assistantThinking.message!.content)).toBe('hidden-thinking')
  })
})

// 测试内联的类型守卫镜像（验证 renderDetail 剥离效果，不依赖 render 内部导出）
function extractTextForTest(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b) => (b as { type?: string }).type !== 'thinking')
      .map((b) => ((b as { text?: string }).text) ?? '')
      .join('')
  }
  return ''
}
function extractThinkingForTest(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .filter((b) => (b as { type?: string }).type === 'thinking')
      .map((b) => ((b as { thinking?: string }).thinking) ?? '')
      .join('')
  }
  return ''
}
