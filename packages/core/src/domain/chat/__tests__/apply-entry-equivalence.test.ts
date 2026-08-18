/**
 * W20 等价性迁移防线：新路径（core applyEntry reducer）== 旧路径（迁移前 convertPiHistory）。
 *
 * w20-acceptance.md 通过命令 2：「对既有测试 fixture 的 entry 序列，新路径 messages 与
 * 旧路径 messages deep equal——迁移不改变行为，本 wave 最重要的回归防线」。
 *
 * 新旧双实现来源（均为生产文件导出）：
 * - 新：convertPiHistory = liftHistoryToEntries（wire lift）+ replayEntries（core reducer）
 * - 旧：convertPiHistoryLegacy = 迁移前实现逐字保留（W21 断言升级后删除）
 *
 * 本文件位于 core 但 import runtime 迁移参照（相对路径，包依赖图之外仅测试期存在）；
 * 生产依赖方向不变（runtime wire 层单向引 core reducer）。
 *
 * volatile 字段归一说明：迁移前实现用 crypto.randomUUID 生成 msg.id / thinking id
 * （不可复现），reducer 改为 entry 派生确定性 id（D5 纯函数要求，id 语义 = 唯一性不透明）。
 * deep equal 前把两侧的 msg.id、thinking[].id 及对应 contentBlocks.refId 按位置重写为
 * 占位符——其余字段（含 toolCalls[].id 的 part.id 透传、全部业务字段）逐字比较。
 *
 * 运行：cd packages/core && pnpm exec vitest run src/domain/chat/__tests__/apply-entry-equivalence.test.ts
 */
import { describe, it, expect } from 'vitest'
import type { Message } from '@xyz-agent/shared'
import { replayEntries } from '../apply-entry'
import type { PiEntry } from '../apply-entry'
import {
  convertPiHistory,
  convertPiHistoryLegacy,
  liftHistoryToEntries,
} from '../../../../../runtime/src/infra/pi/message-converter.js'

// ── volatile 字段归一（见文件头说明）────────────────────────────────

function normalizeVolatile(msgs: Message[]): Array<Record<string, unknown>> {
  return msgs.map((m) => {
    const thinkingIdMap = new Map<string, string>()
    const thinking = m.thinking?.map((t, i) => {
      const normalizedId = `#th${i}`
      thinkingIdMap.set(t.id, normalizedId)
      return { ...t, id: normalizedId }
    })
    const contentBlocks = m.contentBlocks?.map((b) =>
      b.type === 'thinking' && thinkingIdMap.has(b.refId)
        ? { ...b, refId: thinkingIdMap.get(b.refId) }
        : { ...b },
    )
    return {
      ...m,
      id: '#msg',
      ...(thinking !== undefined ? { thinking } : {}),
      ...(contentBlocks !== undefined ? { contentBlocks } : {}),
    }
  })
}

function expectEquivalent(raw: unknown[], entryIds?: string[]): void {
  const orphansNew: unknown[] = []
  const orphansLegacy: unknown[] = []
  const next = convertPiHistory(raw, entryIds, orphansNew as never)
  const legacy = convertPiHistoryLegacy(raw, entryIds, orphansLegacy as never)
  expect(normalizeVolatile(next)).toEqual(normalizeVolatile(legacy))
  expect(orphansNew).toEqual(orphansLegacy)
}

// ── fixture（取自既有测试的真实形态：message-converter*.test.ts 家族）──────────

describe('W20 等价性迁移防线 —— 新路径 == 旧路径 deep equal', () => {
  it('user + assistant 文本消息（message-converter.test L6 fixture）', () => {
    expectEquivalent([
      { role: 'user', content: [{ type: 'text', text: 'Hello' }], timestamp: 1000 },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi there' }], timestamp: 2000 },
    ])
  })

  it('toolResult 合并进 assistant toolCall + isError 置 error（L32/L59 fixture）', () => {
    expectEquivalent([
      { role: 'assistant', content: [{ type: 'toolCall', id: 'tc1', name: 'readFile', arguments: { path: '/foo' } }], timestamp: 1000 },
      { role: 'toolResult', content: [{ type: 'text', text: 'file contents here' }], timestamp: 2000, toolCallId: 'tc1', toolName: 'readFile' },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'tc2', name: 'bash', arguments: { cmd: 'exit 1' } }], timestamp: 3000 },
      { role: 'toolResult', content: [{ type: 'text', text: 'command failed' }], timestamp: 4000, toolCallId: 'tc2', toolName: 'bash', isError: true },
    ])
  })

  it('skill block 剖离：带 location / 多 skill 只取首个（L93/L130 fixture）', () => {
    expectEquivalent([
      { role: 'user', content: [{ type: 'text', text: '<skill name="code-review" location="/abs/SKILL.md">skill body</skill>do the thing' }], timestamp: 1000 },
      { role: 'user', content: [{ type: 'text', text: '<skill name="first">A</skill><skill name="second">B</skill>tail' }], timestamp: 2000 },
    ])
  })

  it('contentBlocks 到达顺序：thinking/text/toolCall 交错 + 多 text part 合并（order test fixture）', () => {
    expectEquivalent([
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'reasoning' }, { type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: '/x' } }, { type: 'text', text: 'answer' }], timestamp: 123 },
      { role: 'assistant', content: [{ type: 'text', text: 'part1 ' }, { type: 'toolCall', id: 'tc2', name: 'read', arguments: {} }, { type: 'text', text: 'part2' }], timestamp: 456 },
    ])
  })

  it('custom role：notify 单条 / display:false / display 缺失 / 其他 customType（L206-L366 fixture）', () => {
    expectEquivalent([
      { role: 'custom', customType: 'subagent-bg-notify', content: 'Subagent "coder" (job-1) completed.', details: { id: 'job-1', status: 'done', agent: 'coder', startedAt: 1000, endedAt: 13000 }, timestamp: 13000 },
      { role: 'custom', customType: 'goal-context', content: '<goal_context>...</goal_context>', display: false, timestamp: 1000 },
      { role: 'custom', customType: 'legacy', content: 'old', timestamp: 2000 },
      { role: 'custom', customType: 'some-other-extension', content: 'hello', details: { foo: 'bar' }, timestamp: 3000 },
    ])
  })

  it('piEntryId：平行 entryIds 回填 / 无 entryIds 不回填 / __entryId 非字符串不回填（L370-L406 fixture）', () => {
    expectEquivalent(
      [
        { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1000 },
        { role: 'user', content: [{ type: 'text', text: 'hi2' }], timestamp: 2000 },
      ],
      ['entry-a'],
    )
    expectEquivalent([{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1000 }])
    expectEquivalent([{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1000, __entryId: 123 }])
    // __entryId 字符串（文件路径旧注入形态）两侧都应回填
    const withInline = [{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1000, __entryId: 'abc123' }]
    expect(convertPiHistory(withInline)[0].piEntryId).toBe('abc123')
    expect(convertPiHistoryLegacy(withInline)[0].piEntryId).toBe('abc123')
  })

  it('compactionSummary / branchSummary role：完整字段 + 缺失 fallback（L410-L470 fixture）', () => {
    expectEquivalent([
      { role: 'compactionSummary', summary: '压缩摘要', tokensBefore: 10000, timestamp: 123 },
      { role: 'compactionSummary', timestamp: 100 },
      { role: 'branchSummary', summary: '分支摘要', fromId: 'msg-abc', timestamp: 456 },
      { role: 'branchSummary', timestamp: 200 },
    ])
  })

  it('bashExecution：完整字段 / exitCode undefined → null / excludeFromContext / 与 user 混合（bash test T9-T13 fixture）', () => {
    expectEquivalent([
      { role: 'bashExecution', command: 'ls', output: 'a\nb\n', exitCode: 0, cancelled: false, truncated: false, excludeFromContext: false, timestamp: 123 },
      { role: 'bashExecution', command: 'x', output: '', exitCode: undefined, cancelled: true, truncated: false, timestamp: 1 },
      { role: 'bashExecution', command: 'pwd', output: '/x', exitCode: 0, cancelled: false, truncated: false, timestamp: 9 },
      { role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: 101 },
    ])
  })

  it('W5T2：assistant tool_use + tool_result 合并 + bashExecution 在后（bash test W5T2 fixture）', () => {
    expectEquivalent([
      { role: 'assistant', content: [{ type: 'text', text: 'running tests' }, { type: 'toolCall', id: 'tc-1', name: 'bash', arguments: { command: 'npm test' } }], timestamp: 200 },
      { role: 'toolResult', content: [{ type: 'text', text: 'all green' }], timestamp: 201, toolCallId: 'tc-1', toolName: 'bash' },
      { role: 'bashExecution', command: 'git status', output: 'clean', exitCode: 0, cancelled: false, truncated: false, excludeFromContext: true, timestamp: 300 },
    ])
  })

  it('write/edit fileChanges 静态提取 + usage 还原 + tool_use 别名（converter 迁移规则全要素）', () => {
    expectEquivalent([
      { role: 'user', content: [{ type: 'text', text: '改一下' }], timestamp: 100 },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '想想' },
          { type: 'tool_use', id: 'tc-w', name: 'write_file', arguments: { path: '/new.ts' } },
          { type: 'toolCall', id: 'tc-e', name: 'str_replace', arguments: { file_path: '/old.ts' } },
          { type: 'toolCall', id: 'tc-r', name: 'read', arguments: { path: '/x' } },
        ],
        usage: { input: 120, output: 80 },
        timestamp: 200,
      },
      { role: 'toolResult', content: [{ type: 'text', text: 'w' }], timestamp: 300, toolCallId: 'tc-w', toolName: 'write_file' },
    ])
  })

  it('孤儿 toolResult（无 preceding assistant）：messages 空 + orphan 数组两侧一致', () => {
    expectEquivalent([
      { role: 'toolResult', content: [{ type: 'text', text: 'orphan out' }], timestamp: 1000, toolCallId: 'tc-none', toolName: 'read' },
    ])
  })

  it('全类型混合序列 + 平行 entryIds（display:false custom 不丢，规则 7.5）', () => {
    expectEquivalent(
      [
        { role: 'user', content: [{ type: 'text', text: '问题' }], timestamp: 100 },
        { role: 'custom', customType: 'todo-context', content: '<todo_context>x</todo_context>', display: false, timestamp: 200 },
        { role: 'assistant', content: [{ type: 'toolCall', id: 'tc-9', name: 'bash', arguments: { command: 'ls' } }], timestamp: 300 },
        { role: 'toolResult', content: [{ type: 'text', text: 'out' }], timestamp: 400, toolCallId: 'tc-9', toolName: 'bash' },
        { role: 'compactionSummary', summary: '压缩', tokensBefore: 9, timestamp: 500 },
        { role: 'branchSummary', summary: '分支', fromId: 'n-1', timestamp: 600 },
        { role: 'bashExecution', command: 'echo hi', output: 'hi\n', exitCode: 0, cancelled: false, truncated: false, timestamp: 700 },
        { role: 'assistant', content: [{ type: 'text', text: '回答' }], timestamp: 800 },
      ],
      ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8'],
    )
  })
})

describe('W20 等价性迁移防线 —— lift 保真（shim 路径 == 直接 entry 喂入）', () => {
  it('同一序列：lift+reducer 与手写等价 entry 直接喂 reducer 产出一致', () => {
    const pseudo = [
      { role: 'user', content: [{ type: 'text', text: 'q' }], timestamp: 1000 },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 't' }, { type: 'toolCall', id: 'tc-1', name: 'write', arguments: { path: '/a' } }], timestamp: 2000 },
      { role: 'toolResult', content: [{ type: 'text', text: 'ok' }], timestamp: 3000, toolCallId: 'tc-1', toolName: 'write' },
      { role: 'bashExecution', command: 'ls', output: '', exitCode: 0, cancelled: false, truncated: false, timestamp: 4000 },
    ]
    const ids = ['m-1', 'm-2', 'm-3', 'm-4']
    // 手写等价 entry（真实 pi 形态：ISO timestamp / parentId 链）——独立于 lift 实现
    const handEntries: PiEntry[] = [
      { type: 'message', id: 'm-1', parentId: null, timestamp: new Date(1000).toISOString(), message: pseudo[0] },
      { type: 'message', id: 'm-2', parentId: 'm-1', timestamp: new Date(2000).toISOString(), message: pseudo[1] },
      { type: 'message', id: 'm-3', parentId: 'm-2', timestamp: new Date(3000).toISOString(), message: pseudo[2] },
      { type: 'message', id: 'm-4', parentId: 'm-3', timestamp: new Date(4000).toISOString(), message: pseudo[3] },
    ]
    const viaShim = replayEntries(liftHistoryToEntries(pseudo, ids))
    const viaDirect = replayEntries(handEntries)
    expect(viaShim).toEqual(viaDirect)
  })
})
