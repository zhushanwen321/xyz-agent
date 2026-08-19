/**
 * applyEntry reducer 确定性防线（W20 建立「新旧双实现等价」，W21 断言升级——legacy
 * 家族随 message-converter.ts 删除，等价性防线移交两层）：
 *
 * 1. 本文件：同 fixture 序列两次喂入 reducer → state 全等（D5 纯函数确定性）+
 *    lift 保真（伪消息 lift == 手写等价 entry 直接喂入）。fixture 全集取自迁移前
 *    message-converter*.test.ts 家族的真实形态（用例集不缩水）。
 * 2. runtime src/__tests__/equivalence/live-reload.test.ts：live≡reload store 级同构
 *    （真实 pi 子进程，实时 message_end 流与 get_entries 重放喂同一 reducer）。
 *
 * 行为级具体断言（role 细分 / contentBlocks 顺序 / fileChanges / usage / skill 剖离）
 * 由 apply-entry.test.ts（W20 reducer 单测）承担。
 *
 * 运行：cd packages/core && pnpm exec vitest run src/domain/chat/__tests__/apply-entry-equivalence.test.ts
 */
import { describe, it, expect } from 'vitest'
import { replayEntries } from '../apply-entry'
import type { PiEntry } from '../apply-entry'
import {
  convertPiHistory,
  liftHistoryToEntries,
} from '../../../../../runtime/src/infra/pi/message-converter.js'

// ── fixture（取自既有测试的真实形态：message-converter*.test.ts 家族）──────────

/** 确定性断言：同序列两次（lift + reducer fold）→ 全量 state deep equal。 */
function expectDeterministic(raw: unknown[], entryIds?: string[]): void {
  const first = replayEntries(liftHistoryToEntries(raw, entryIds))
  const second = replayEntries(liftHistoryToEntries(raw, entryIds))
  // 全量 state（messages + clientUuidMap + orphanToolResults + 配对锚点）非消息级抽样
  expect(first).toEqual(second)
  // Map 在 toEqual 中按内容比较 ✓；确定性含「无 Date.now/randomUUID 渗入」——
  // 同序列两次产出引用不同但内容全等，是 replay 重建（W21 对账）的构造性依据。
  return first
}

describe('applyEntry reducer 确定性 —— 同序列两次喂入 state 全等', () => {
  it('user + assistant 文本消息（message-converter.test L6 fixture）', () => {
    expectDeterministic([
      { role: 'user', content: [{ type: 'text', text: 'Hello' }], timestamp: 1000 },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi there' }], timestamp: 2000 },
    ])
  })

  it('toolResult 合并进 assistant toolCall + isError 置 error（L32/L59 fixture）', () => {
    expectDeterministic([
      { role: 'assistant', content: [{ type: 'toolCall', id: 'tc1', name: 'readFile', arguments: { path: '/foo' } }], timestamp: 1000 },
      { role: 'toolResult', content: [{ type: 'text', text: 'file contents here' }], timestamp: 2000, toolCallId: 'tc1', toolName: 'readFile' },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'tc2', name: 'bash', arguments: { cmd: 'exit 1' } }], timestamp: 3000 },
      { role: 'toolResult', content: [{ type: 'text', text: 'command failed' }], timestamp: 4000, toolCallId: 'tc2', toolName: 'bash', isError: true },
    ])
  })

  it('skill block 剖离：带 location / 多 skill 只取首个（L93/L130 fixture）', () => {
    expectDeterministic([
      { role: 'user', content: [{ type: 'text', text: '<skill name="code-review" location="/abs/SKILL.md">skill body</skill>do the thing' }], timestamp: 1000 },
      { role: 'user', content: [{ type: 'text', text: '<skill name="first">A</skill><skill name="second">B</skill>tail' }], timestamp: 2000 },
    ])
  })

  it('contentBlocks 到达顺序：thinking/text/toolCall 交错 + 多 text part 合并（order test fixture）', () => {
    expectDeterministic([
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'reasoning' }, { type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: '/x' } }, { type: 'text', text: 'answer' }], timestamp: 123 },
      { role: 'assistant', content: [{ type: 'text', text: 'part1 ' }, { type: 'toolCall', id: 'tc2', name: 'read', arguments: {} }, { type: 'text', text: 'part2' }], timestamp: 456 },
    ])
  })

  it('custom role：notify 单条 / display:false / display 缺失 / 其他 customType（L206-L366 fixture）', () => {
    expectDeterministic([
      { role: 'custom', customType: 'subagent-bg-notify', content: 'Subagent "coder" (job-1) completed.', details: { id: 'job-1', status: 'done', agent: 'coder', startedAt: 1000, endedAt: 13000 }, timestamp: 13000 },
      { role: 'custom', customType: 'goal-context', content: '<goal_context>...</goal_context>', display: false, timestamp: 1000 },
      { role: 'custom', customType: 'legacy', content: 'old', timestamp: 2000 },
      { role: 'custom', customType: 'some-other-extension', content: 'hello', details: { foo: 'bar' }, timestamp: 3000 },
    ])
  })

  it('piEntryId：平行 entryIds 回填 / 无 entryIds 不回填 / __entryId 字符串回填（L370-L406 fixture）', () => {
    expectDeterministic(
      [
        { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1000 },
        { role: 'user', content: [{ type: 'text', text: 'hi2' }], timestamp: 2000 },
      ],
      ['entry-a'],
    )
    expectDeterministic([{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1000 }])
    expectDeterministic([{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1000, __entryId: 123 }])
    // __entryId 字符串（文件路径旧注入形态）回填——具体行为断言（非仅确定性）
    const withInline = [{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1000, __entryId: 'abc123' }]
    expect(convertPiHistory(withInline)[0].piEntryId).toBe('abc123')
    expect(convertPiHistory([{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1000 }])[0].piEntryId).toBeUndefined()
  })

  it('compactionSummary / branchSummary role：完整字段 + 缺失 fallback（L410-L470 fixture）', () => {
    expectDeterministic([
      { role: 'compactionSummary', summary: '压缩摘要', tokensBefore: 10000, timestamp: 123 },
      { role: 'compactionSummary', timestamp: 100 },
      { role: 'branchSummary', summary: '分支摘要', fromId: 'msg-abc', timestamp: 456 },
      { role: 'branchSummary', timestamp: 200 },
    ])
  })

  it('bashExecution：完整字段 / exitCode undefined → null / excludeFromContext / 与 user 混合（bash test T9-T13 fixture）', () => {
    expectDeterministic([
      { role: 'bashExecution', command: 'ls', output: 'a\nb\n', exitCode: 0, cancelled: false, truncated: false, excludeFromContext: false, timestamp: 123 },
      { role: 'bashExecution', command: 'x', output: '', exitCode: undefined, cancelled: true, truncated: false, timestamp: 1 },
      { role: 'bashExecution', command: 'pwd', output: '/x', exitCode: 0, cancelled: false, truncated: false, timestamp: 9 },
      { role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: 101 },
    ])
  })

  it('W5T2：assistant tool_use + tool_result 合并 + bashExecution 在后（bash test W5T2 fixture）', () => {
    expectDeterministic([
      { role: 'assistant', content: [{ type: 'text', text: 'running tests' }, { type: 'toolCall', id: 'tc-1', name: 'bash', arguments: { command: 'npm test' } }], timestamp: 200 },
      { role: 'toolResult', content: [{ type: 'text', text: 'all green' }], timestamp: 201, toolCallId: 'tc-1', toolName: 'bash' },
      { role: 'bashExecution', command: 'git status', output: 'clean', exitCode: 0, cancelled: false, truncated: false, excludeFromContext: true, timestamp: 300 },
    ])
  })

  it('write/edit fileChanges 静态提取 + usage 还原 + tool_use 别名（converter 迁移规则全要素）', () => {
    expectDeterministic([
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

  it('孤儿 toolResult（无 preceding assistant）：messages 空 + orphan 收集', () => {
    const state = expectDeterministic([
      { role: 'toolResult', content: [{ type: 'text', text: 'orphan out' }], timestamp: 1000, toolCallId: 'tc-none', toolName: 'read' },
    ])
    expect(state.messages).toHaveLength(0)
    expect(state.orphanToolResults).toHaveLength(1)
  })

  it('全类型混合序列 + 平行 entryIds（display:false custom 不丢，规则 7.5）', () => {
    expectDeterministic(
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

describe('lift 保真（shim 路径 == 直接 entry 喂入）', () => {
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
