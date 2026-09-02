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
import type { ChatViewState, PiEntry } from '../apply-entry'
import { toRenderItems } from '../message-turns'
import type { RenderItem } from '../message-turns'
import type { Message } from '@xyz-agent/shared'
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

  it('全类型混合序列 + 平行 entryIds（display:false custom 不丢，关键规则 9）', () => {
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

// ── live ≡ reload 构造性等价（W6，conversation-turn-attribution G6）──────────────
//
// live 侧各构造点产出的 entry（客户端 id：user `u-` / bash `bash-` / custom `cm-` /
// compaction `cmp-` / assistant message_end 重构无 id）与 replay 侧同内容 pi uuidv7
// entry 序列，经同一 applyEntry reducer 的终态在「按字段归一（剥消息 id 与 piEntryId）」
// 后 deep-equal——「live ≡ reload 全类型构造性成立」的机器化断言。两侧消息体独立手写
// （lift 保真用例同款风格：等价性 = 两侧独立构造同内容，不共享字面量）。
// id 空间异源（客户端前缀 / e<N> 派生 vs pi uuidv7）与 timestamp 异源（客户端时钟 vs
// pi 落盘时刻，差值为投递延迟）均为 W21 已裁决并在各构造点注释登记的差异类——归一只
// 剥 id/piEntryId，timestamp 两侧 fixture 用同值隔离无关变量。
describe('live ≡ reload 构造性等价（W6 全类型）', () => {
  /** ms → ISO（fixture 统一 timestamp 形态） */
  const ts = (ms: number) => new Date(ms).toISOString()

  /** uuidv7 形态假 id（replay 侧专用，模拟 pi 持久化 id 空间） */
  const piId = (n: number) => `0198aabb-ccdd-7e${n.toString().padStart(2, '0')}-8f00-00000000000${n}`

  /**
   * 归一：剥消息 id 与 piEntryId（live 客户端前缀 id / reducer e<N> 派生 vs replay pi
   * uuidv7 entry id——id 空间异源属 W21 已裁决差异类，等价性按内容断言）。
   */
  function normalizeIds(state: ChatViewState): ChatViewState {
    const messages = state.messages.map(({ id: _id, piEntryId: _piEntryId, ...rest }) => rest)
    return { ...state, messages }
  }

  /** live 侧 entry 序列：各构造点真实 id 形态（appendUser u- / bashResultEffect bash- / customStart cm- / compactionSummary cmp- / message_end 无 id） */
  const liveEntries: PiEntry[] = [
    { type: 'message', id: 'u-00000001-0000-4000-8000-000000000001', parentId: null, timestamp: ts(1000), message: { role: 'user', content: [{ type: 'text', text: '跑一下测试' }], timestamp: 1000 } },
    { type: 'message', id: undefined, parentId: null, timestamp: ts(2000), message: { role: 'assistant', content: [{ type: 'text', text: '开始执行' }, { type: 'toolCall', id: 'tc-1', name: 'bash', arguments: { command: 'npm test' } }], timestamp: 2000 } },
    // [R2-S1] toolResult 双入口：生产实际输入是 tool_call_end + message_end 两条帧各喂
    // reducer 一次（pi 对同一条 toolResult 双发 tool_execution_end + message_end{role:'toolResult'}，
    // 两构造点产出同内容同构 entry、均无 id）。原 fixture 只喂单条 message_end 构造——测试
    // 输入与生产输入不一致；幂等去重（deliveredToolResultIds）后双喂 ≡ 单喂，与 replay 侧
    // （pi 文件每 toolResult 只存一份 entry）deep-equal 依旧成立（断言见下方「双入口等价」组）。
    { type: 'message', id: undefined, parentId: null, timestamp: ts(3000), message: { role: 'toolResult', toolCallId: 'tc-1', toolName: 'bash', content: [{ type: 'text', text: 'all green' }], timestamp: 3000 } },
    { type: 'message', id: undefined, parentId: null, timestamp: ts(3000), message: { role: 'toolResult', toolCallId: 'tc-1', toolName: 'bash', content: [{ type: 'text', text: 'all green' }], timestamp: 3000 } },
    // bash：pi 落盘位置 = run 级联末（recordBashResult streaming 缓存 → finally flush），
    // xyz dispatcher 双分支延迟使 live 入流位置构造性对齐（W1）——两侧同位置
    { type: 'message', id: 'bash-00000002-0000-4000-8000-000000000002', parentId: null, timestamp: ts(4000), message: { role: 'bashExecution', command: 'ls -la', output: 'a\nb\n', exitCode: 0, cancelled: false, truncated: false, excludeFromContext: false, timestamp: 4000 } },
    { type: 'message', id: undefined, parentId: null, timestamp: ts(5000), message: { role: 'assistant', content: [{ type: 'text', text: '完成' }], usage: { input: 10, output: 5 }, timestamp: 5000 } },
    { type: 'custom_message', id: 'cm-00000003-0000-4000-8000-000000000003', parentId: null, timestamp: ts(6000), customType: 'subagent-bg-notify', content: 'Subagent "coder" completed.', details: { id: 'job-1', status: 'done' } },
    { type: 'message', id: undefined, parentId: null, timestamp: ts(7000), message: { role: 'assistant', content: [{ type: 'text', text: '收到后台结果，继续处理' }], timestamp: 7000 } },
    { type: 'compaction', id: 'cmp-00000004-0000-4000-8000-000000000004', parentId: null, timestamp: ts(8000), summary: '压缩摘要', tokensBefore: 12345 },
    { type: 'message', id: 'u-00000005-0000-4000-8000-000000000005', parentId: null, timestamp: ts(9000), message: { role: 'user', content: [{ type: 'text', text: '继续' }], timestamp: 9000 } },
  ]

  /** replay 侧 entry 序列：同内容，id 全部 pi uuidv7 空间（含 live 侧无 id 的 assistant） */
  const replaySideEntries: PiEntry[] = [
    { type: 'message', id: piId(1), parentId: null, timestamp: ts(1000), message: { role: 'user', content: [{ type: 'text', text: '跑一下测试' }], timestamp: 1000 } },
    { type: 'message', id: piId(2), parentId: piId(1), timestamp: ts(2000), message: { role: 'assistant', content: [{ type: 'text', text: '开始执行' }, { type: 'toolCall', id: 'tc-1', name: 'bash', arguments: { command: 'npm test' } }], timestamp: 2000 } },
    { type: 'message', id: piId(3), parentId: piId(2), timestamp: ts(3000), message: { role: 'toolResult', toolCallId: 'tc-1', toolName: 'bash', content: [{ type: 'text', text: 'all green' }], timestamp: 3000 } },
    { type: 'message', id: piId(4), parentId: piId(3), timestamp: ts(4000), message: { role: 'bashExecution', command: 'ls -la', output: 'a\nb\n', exitCode: 0, cancelled: false, truncated: false, excludeFromContext: false, timestamp: 4000 } },
    { type: 'message', id: piId(5), parentId: piId(4), timestamp: ts(5000), message: { role: 'assistant', content: [{ type: 'text', text: '完成' }], usage: { input: 10, output: 5 }, timestamp: 5000 } },
    { type: 'custom_message', id: piId(6), parentId: piId(5), timestamp: ts(6000), customType: 'subagent-bg-notify', content: 'Subagent "coder" completed.', details: { id: 'job-1', status: 'done' } },
    { type: 'message', id: piId(7), parentId: piId(6), timestamp: ts(7000), message: { role: 'assistant', content: [{ type: 'text', text: '收到后台结果，继续处理' }], timestamp: 7000 } },
    { type: 'compaction', id: piId(8), parentId: piId(7), timestamp: ts(8000), summary: '压缩摘要', tokensBefore: 12345 },
    { type: 'message', id: piId(9), parentId: piId(8), timestamp: ts(9000), message: { role: 'user', content: [{ type: 'text', text: '继续' }], timestamp: 9000 } },
  ]

  it('E1: live 全类型构造（客户端 id 前缀）与 replay（pi uuidv7）终态按 id/piEntryId 归一后 deep-equal', () => {
    const liveState = normalizeIds(replayEntries(liveEntries))
    const replayState = normalizeIds(replayEntries(replaySideEntries))
    // 全量 state（messages + orphanToolResults + 配对锚点）非消息级抽样
    expect(liveState).toEqual(replayState)
    // 用户可见内容非空守卫（防两侧同归于空 / 静默 no-op 造成假等价）：
    // user×2 / assistant×3 / bash notice / 隐藏完成通知 / 压缩行，全类型各就各位
    expect(liveState.messages.filter((m) => m.role === 'user')).toHaveLength(2)
    expect(liveState.messages.filter((m) => m.role === 'assistant')).toHaveLength(3)
    expect(liveState.messages.filter((m) => m.bashExecution !== undefined)).toHaveLength(1)
    expect(liveState.messages.filter((m) => m.customType === 'subagent-bg-notify' && m.display === false)).toHaveLength(1)
    expect(liveState.messages.filter((m) => m.compactionSummary !== undefined)).toHaveLength(1)
  })

  it('E2: 分组等价——同一序列 live 构造与文件重放的 toRenderItems 输出 deep-equal（turn 数 / trigger / notices / 边界行一致）', () => {
    const liveItems = toRenderItems(normalizeIds(replayEntries(liveEntries)).messages)
    const replayItems = toRenderItems(normalizeIds(replayEntries(replaySideEntries)).messages)
    expect(liveItems).toEqual(replayItems)

    // 用户可见行为等价的显式断言（非仅内部结构）：turn 数、trigger 续跑起点、
    // bash 归 turn 内 notice（不切断 turn）、compaction 独立边界行
    const turns = (items: RenderItem[]) =>
      items.flatMap((i) => (i.kind === 'turn' ? [i.turn] : []))
    const liveTurns = turns(liveItems)
    expect(liveTurns).toHaveLength(3) // user 锚 / bg-notify 续跑 / user 锚
    // 首 turn：bash 执行记录归 turn 内 notice（W3 规则 4 inline），不出独立渲染项
    expect(liveTurns[0]!.notices?.map((n) => n.bashExecution?.command)).toEqual(['ls -la'])
    expect(liveTurns[0]!.assistants.map((a) => a.content)).toEqual(['开始执行', '完成'])
    // 次 turn：隐藏完成通知触发 trigger:'bg-notify' 续跑 turn（无 user 气泡）
    expect(liveTurns[1]!.trigger).toBe('bg-notify')
    expect(liveTurns[1]!.user).toBeNull()
    expect(liveTurns[1]!.assistants.map((a) => a.content)).toEqual(['收到后台结果，继续处理'])
    // compaction：独立 systemNotice 边界行（关闭 turn，W3 规则 5 boundary）
    expect(liveItems.some((i) => i.kind === 'systemNotice' && i.message.compactionSummary !== undefined)).toBe(true)
    // 末 turn：压缩后新 user 开新组
    expect(liveTurns[2]!.user?.content).toEqual([{ type: 'text', text: '继续' }])
  })

  it('E3: abort 等价（D1 closure——sendBash 解除丢弃后真实 cancelled 结果照常发布 entry 化，两侧同位同值）', () => {
    // 语义链（dispatcher D1 closure 修订 + bash-effects 哨兵帧分支）：
    // 用户 abort bash → abortBash 广播哨兵帧 bashResult{command:'', cancelled:true}
    // → bashResultEffect 只清 executingBash 不产 entry；sendBash await 返回后 token 虽被
    // 旋转但**不再跳过**——真实 cancelled 结果（bash-executor abort 返回 cancelled 结果
    // 而非 throw）经双分支发布 → bashResultEffect entry 化。pi 侧 recordBashResult 同数据
    // 落盘 → live/replay 同位（run 级联末）同值，原登记例外①（live 无 / 文件有）消灭。
    const cancelledBashBody = { role: 'bashExecution' as const, command: 'sleep 300', output: '部分输出\n', exitCode: null, cancelled: true, truncated: false, timestamp: 3000 }
    // live 侧：真实 cancelled 帧 entry 化（bash- 前缀客户端 id，bashResultEffect 构造形态）
    const liveState = replayEntries([
      { type: 'message', id: 'u-1', parentId: null, timestamp: ts(1000), message: { role: 'user', content: [{ type: 'text', text: '跑个长命令' }], timestamp: 1000 } },
      { type: 'message', id: undefined, parentId: null, timestamp: ts(2000), message: { role: 'assistant', content: [{ type: 'text', text: '执行中' }], timestamp: 2000 } },
      { type: 'message', id: 'bash-00000003-0000-4000-8000-000000000003', parentId: null, timestamp: ts(3000), message: cancelledBashBody },
      { type: 'message', id: 'u-2', parentId: null, timestamp: ts(5000), message: { role: 'user', content: [{ type: 'text', text: '换个任务' }], timestamp: 5000 } },
      { type: 'message', id: undefined, parentId: null, timestamp: ts(6000), message: { role: 'assistant', content: [{ type: 'text', text: '好的' }], timestamp: 6000 } },
    ])
    // replay 侧：pi 文件 cancelled bash entry（uuidv7 id，落盘位置 = run 级联末）
    const replayState = replayEntries([
      { type: 'message', id: piId(1), parentId: null, timestamp: ts(1000), message: { role: 'user', content: [{ type: 'text', text: '跑个长命令' }], timestamp: 1000 } },
      { type: 'message', id: piId(2), parentId: piId(1), timestamp: ts(2000), message: { role: 'assistant', content: [{ type: 'text', text: '执行中' }], timestamp: 2000 } },
      { type: 'message', id: piId(3), parentId: piId(2), timestamp: ts(3000), message: cancelledBashBody },
      { type: 'message', id: piId(4), parentId: piId(3), timestamp: ts(5000), message: { role: 'user', content: [{ type: 'text', text: '换个任务' }], timestamp: 5000 } },
      { type: 'message', id: piId(5), parentId: piId(4), timestamp: ts(6000), message: { role: 'assistant', content: [{ type: 'text', text: '好的' }], timestamp: 6000 } },
    ])

    // ① 数量一致 + 归一 deep-equal（无任何剔除——等价性恢复到全量）
    expect(replayState.messages).toHaveLength(liveState.messages.length)
    expect(normalizeIds(liveState)).toEqual(normalizeIds(replayState))

    // ② 分组骨架一致：cancelled bash 是 turn 内 inline notice（W3 规则），两侧 turn 数 /
    //    user / assistants / notices 全等（含 noticeCommands——不再需要剥离分歧点）
    const skeleton = (state: ChatViewState) =>
      toRenderItems(normalizeIds(state).messages)
        .map((item) =>
          item.kind === 'turn'
            ? {
                kind: 'turn' as const,
                user: item.turn.user?.content ?? null,
                assistants: item.turn.assistants.map((a) => a.content),
                trigger: item.turn.trigger ?? null,
                noticeCommands: (item.turn.notices ?? []).map((n) => n.bashExecution?.command ?? n.content),
              }
            : { kind: item.kind, content: item.message.content },
        )
    expect(skeleton(liveState)).toEqual(skeleton(replayState))
    expect(skeleton(liveState)).toHaveLength(2) // 两个 user 锚 turn
    expect(skeleton(liveState)[0]).toMatchObject({ kind: 'turn', noticeCommands: ['sleep 300'] }) // cancelled 归首 turn notices
  })

  it('E3b: transport 抛错例外锁定（收窄后唯一残余分歧——abort 且 await 抛错时 live 无 cancelled entry、pi 独立落盘有）', () => {
    // 语义链（收窄例外，dispatcher catch 分支维持 skip）：abort 后 sendBash await **抛错**
    // （transport 断 / pi 死——与正常 resolve 的 cancelled result 不同路径）→ 无真实数据可
    // 发布，catch 守卫跳过（哨兵帧已清态）。pi 进程若独立存活仍 recordBashResult 落盘 →
    // 重开侧多一条 cancelled bash 记录。触发条件「abort 且 transport 抛错」——比原例外①
    // 「任何 abort」窄，登记 data-source-registry #7。
    // live 侧：无 bash entry（哨兵帧不产 entry、catch 无数据）
    const liveState = replayEntries([
      { type: 'message', id: 'u-1', parentId: null, timestamp: ts(1000), message: { role: 'user', content: [{ type: 'text', text: '跑个长命令' }], timestamp: 1000 } },
      { type: 'message', id: undefined, parentId: null, timestamp: ts(2000), message: { role: 'assistant', content: [{ type: 'text', text: '执行中' }], timestamp: 2000 } },
      { type: 'message', id: 'u-2', parentId: null, timestamp: ts(5000), message: { role: 'user', content: [{ type: 'text', text: '换个任务' }], timestamp: 5000 } },
      { type: 'message', id: undefined, parentId: null, timestamp: ts(6000), message: { role: 'assistant', content: [{ type: 'text', text: '好的' }], timestamp: 6000 } },
    ])
    // replay 侧：pi 文件含 cancelled bash entry（落盘位置 = run 级联末，a1 之后 user2 之前）
    const replayState = replayEntries([
      { type: 'message', id: piId(1), parentId: null, timestamp: ts(1000), message: { role: 'user', content: [{ type: 'text', text: '跑个长命令' }], timestamp: 1000 } },
      { type: 'message', id: piId(2), parentId: piId(1), timestamp: ts(2000), message: { role: 'assistant', content: [{ type: 'text', text: '执行中' }], timestamp: 2000 } },
      { type: 'message', id: piId(3), parentId: piId(2), timestamp: ts(3000), message: { role: 'bashExecution', command: 'sleep 300', output: '', exitCode: null, cancelled: true, truncated: false, timestamp: 3000 } },
      { type: 'message', id: piId(4), parentId: piId(3), timestamp: ts(5000), message: { role: 'user', content: [{ type: 'text', text: '换个任务' }], timestamp: 5000 } },
      { type: 'message', id: piId(5), parentId: piId(4), timestamp: ts(6000), message: { role: 'assistant', content: [{ type: 'text', text: '好的' }], timestamp: 6000 } },
    ])

    // ① 差异恰为该 entry：数量恰差 1，且 replay 剔除该条后与 live 归一 deep-equal
    expect(replayState.messages).toHaveLength(liveState.messages.length + 1)
    const replayMinusCancelled = replayState.messages.filter((m) => m.bashExecution?.cancelled !== true)
    expect(replayMinusCancelled).toHaveLength(replayState.messages.length - 1)
    expect(normalizeIds(liveState)).toEqual(normalizeIds({ ...replayState, messages: replayMinusCancelled }))

    // ② 分组不因它变化：turn 骨架（turn 数 / user / assistants / trigger）两侧一致，
    //    差异仅首 turn 的 notices 多一条——bash 是 inline notice，不影响 turn 边界
    const skeleton = (state: ChatViewState, msgs: Message[]) =>
      toRenderItems(normalizeIds({ ...state, messages: msgs }).messages)
        .map((item) =>
          item.kind === 'turn'
            ? {
                kind: 'turn' as const,
                user: item.turn.user?.content ?? null,
                assistants: item.turn.assistants.map((a) => a.content),
                trigger: item.turn.trigger ?? null,
                noticeCommands: (item.turn.notices ?? []).map((n) => n.bashExecution?.command ?? n.content),
              }
            : { kind: item.kind, content: item.message.content },
        )
    const liveSkeleton = skeleton(liveState, liveState.messages)
    const replaySkeleton = skeleton(replayState, replayState.messages)
    expect(liveSkeleton).toHaveLength(2) // 两个 user 锚 turn，两侧一致
    // 除 noticeCommands 外全等（结构 diff 收敛到唯一分歧点）
    const stripNotices = (s: typeof liveSkeleton) =>
      s.map((row) => (row.kind === 'turn' ? { ...row, noticeCommands: undefined } : row))
    expect(stripNotices(liveSkeleton)).toEqual(stripNotices(replaySkeleton))
    expect(liveSkeleton[0]).toMatchObject({ kind: 'turn', noticeCommands: [] })
    expect(replaySkeleton[0]).toMatchObject({ kind: 'turn', noticeCommands: ['sleep 300'] })
  })

  it('E4: compactionSummary 处置（W6 entry 化）——live 帧构造 entry 与 replay compaction entry 经 reducer 产出归一 deep-equal', () => {
    // live 侧：registry compactionSummary handler 从帧构造的 entry（cmp- 前缀客户端 id，
    // 形态契约见 handler 注释——帧数据源与 pi 落盘 entry 同源同值）
    const liveCompaction: PiEntry = {
      type: 'compaction',
      id: 'cmp-00000006-0000-4000-8000-000000000006',
      parentId: null,
      timestamp: ts(8000),
      summary: '压缩摘要',
      tokensBefore: 12345,
    }
    // replay 侧：pi 持久化 compaction entry（uuidv7 id）
    const replayCompaction: PiEntry = {
      type: 'compaction',
      id: piId(8),
      parentId: null,
      timestamp: ts(8000),
      summary: '压缩摘要',
      tokensBefore: 12345,
    }
    expect(normalizeIds(replayEntries([liveCompaction])))
      .toEqual(normalizeIds(replayEntries([replayCompaction])))
    // 用户可见行为：压缩记录作 system 消息（content = summary，compactionSummary 字段完整）
    const [msg] = normalizeIds(replayEntries([liveCompaction])).messages
    expect(msg).toMatchObject({
      role: 'system',
      content: '压缩摘要',
      status: 'complete',
      compactionSummary: { summary: '压缩摘要', tokensBefore: 12345 },
    })
    // 分组语义：compaction 作 boundary systemNotice 独立行（关闭当前 turn，W3 规则 5）
    const items = toRenderItems(normalizeIds(replayEntries([liveCompaction])).messages)
    expect(items).toHaveLength(1)
    expect(items[0]!.kind).toBe('systemNotice')
  })

  it('E4b: compaction summary-less 处置（D2 closure——interpreter 恒发帧后，无摘要 compaction 两侧同产 fallback 行）', () => {
    // 语义链（conversation-turn-attribution-closure D2）：pi appendCompaction 无条件落盘，
    // summary 缺失（undefined）的成功 compaction——interpreter 恒发帧（payload.summary 缺省
    // 透传）→ registry readCompactionSummary 不设 summary 字段 → 构造的 entry 无 summary →
    // reducer `summary ?? '上下文已压缩'` fallback。replay 侧文件 entry 同样无 summary →
    // 同一 fallback。原登记例外④（live 无 / reload 有）消灭。
    // live 侧：帧构造 entry（cmp- 前缀客户端 id，无 summary 字段）
    const liveCompaction: PiEntry = {
      type: 'compaction',
      id: 'cmp-00000007-0000-4000-8000-000000000007',
      parentId: null,
      timestamp: ts(9000),
      tokensBefore: 99999,
    }
    // replay 侧：pi 持久化 compaction entry（uuidv7 id，同样无 summary 字段）
    const replayCompaction: PiEntry = {
      type: 'compaction',
      id: piId(9),
      parentId: null,
      timestamp: ts(9000),
      tokensBefore: 99999,
    }
    const liveState = normalizeIds(replayEntries([liveCompaction]))
    const replayState = normalizeIds(replayEntries([replayCompaction]))
    // 归一 deep-equal（含 fallback 投影两侧一致）
    expect(liveState).toEqual(replayState)
    // 用户可见行为：两侧都产出 fallback 文案行（原 live 无消息的差异消灭）
    expect(liveState.messages).toHaveLength(1)
    expect(liveState.messages[0]).toMatchObject({
      role: 'system',
      content: '上下文已压缩',
      status: 'complete',
      compactionSummary: { summary: undefined, tokensBefore: 99999 },
    })
    // 分组语义：同 E4——boundary systemNotice 独立行
    const items = toRenderItems(liveState.messages)
    expect(items).toHaveLength(1)
    expect(items[0]!.kind).toBe('systemNotice')
  })

  it("E4c: compaction 空串 summary 处置（实施审查 MF-1——'' 经 readers 空串透传门保留，两侧同值同路径不分叉）", () => {
    // 语义链（closure 实施审查 r1 MF-1）：pi appendCompaction 无条件直写 summary 字段，
    // '' 落盘后 replay 侧 `'' ?? fallback` 不触发 → 保留空行。live 链原先在
    // readCompactionSummary 的 truthiness 门（`if (s)`）处把 '' 丢成 undefined → 走
    // fallback 文案 → 内容级分叉。修复 = readers 门改 `s !== undefined`（空串透传），
    // '' 与 undefined 两种形态各自两侧一致（undefined → 双侧 fallback，见 E4b；'' → 双侧空行）。
    // live 侧：帧 summary:'' → readers 透传 → entry summary:''（cmp- 前缀客户端 id）
    const liveCompaction: PiEntry = {
      type: 'compaction',
      id: 'cmp-00000008-0000-4000-8000-000000000008',
      parentId: null,
      timestamp: ts(9500),
      summary: '',
      tokensBefore: 123456,
    }
    // replay 侧：pi 持久化 entry（summary 字段 ''，`'' ?? fallback` 不触发）
    const replayCompaction: PiEntry = {
      type: 'compaction',
      id: piId(10),
      parentId: null,
      timestamp: ts(9500),
      summary: '',
      tokensBefore: 123456,
    }
    const liveState = normalizeIds(replayEntries([liveCompaction]))
    const replayState = normalizeIds(replayEntries([replayCompaction]))
    expect(liveState).toEqual(replayState)
    // 用户可见行为：两侧都是空 content 行（不走 fallback 文案——与 E4b 的 undefined 形态对照）
    expect(liveState.messages[0]).toMatchObject({ role: 'system', content: '' })
    expect(replayState.messages[0]).toMatchObject({ role: 'system', content: '' })
  })

  it('E5: branchSummary 处置（D13 entry 化）——live 帧构造 branch_summary entry 与 replay pi entry 经 reducer 产出归一 deep-equal', () => {
    // live 侧：registry branchSummary handler 从帧构造的 entry（br- 前缀客户端 id，
    // 形态契约见 handler 注释——summary/fromId 帧值透传，timestamp 帧 ms → ISO）
    const liveBranch: PiEntry = {
      type: 'branch_summary',
      id: 'br-00000009-0000-4000-8000-000000000009',
      parentId: null,
      timestamp: ts(6000),
      summary: '分支摘要',
      fromId: 'msg-9',
    }
    // replay 侧：pi 持久化 branch_summary entry（uuidv7 id）
    const replayBranch: PiEntry = {
      type: 'branch_summary',
      id: piId(9),
      parentId: null,
      timestamp: ts(6000),
      summary: '分支摘要',
      fromId: 'msg-9',
    }
    expect(normalizeIds(replayEntries([liveBranch]))).toEqual(normalizeIds(replayEntries([replayBranch])))
    // 用户可见行为：分支记录作 system 消息（content = summary，branchSummary 字段完整）
    const [m] = normalizeIds(replayEntries([liveBranch])).messages
    expect(m).toMatchObject({
      role: 'system',
      content: '分支摘要',
      status: 'complete',
      branchSummary: { summary: '分支摘要', fromId: 'msg-9', timestamp: 6000 },
    })
    // 分组语义：branchSummary 作 boundary systemNotice 独立行（W3 规则 5，同 compaction E4）
    const items = toRenderItems(normalizeIds(replayEntries([liveBranch])).messages)
    expect(items).toHaveLength(1)
    expect(items[0]!.kind).toBe('systemNotice')
  })

  it("E5b: branchSummary summary-less 处置（D13——无摘要两侧同产空串行，live 'Branched' 占位消灭）", () => {
    // 语义链（renderer-deepening D13，本设计第二处有意行为变化）：live 侧原直插
    // `summary ?? 'Branched'` 与 reload 侧 reducer `rawSummary ?? ''` 分叉（live 显示
    // 'Branched'、重开为空串）。entry 化后两侧共用 reducer branch_summary case——
    // summary 缺失（undefined）时同走 `?? ''` 空串投影，行为不一致消灭。
    // live 侧：帧构造 entry（br- 前缀客户端 id，无 summary 字段）
    const liveBranch: PiEntry = {
      type: 'branch_summary',
      id: 'br-00000010-0000-4000-8000-000000000010',
      parentId: null,
      timestamp: ts(9600),
      fromId: 'n-1',
    }
    // replay 侧：pi 持久化 entry（uuidv7 id，同样无 summary 字段）
    const replayBranch: PiEntry = {
      type: 'branch_summary',
      id: piId(10),
      parentId: null,
      timestamp: ts(9600),
      fromId: 'n-1',
    }
    const liveState = normalizeIds(replayEntries([liveBranch]))
    const replayState = normalizeIds(replayEntries([replayBranch]))
    expect(liveState).toEqual(replayState)
    // 用户可见行为：两侧都产出空串行（原 live 'Branched' 的差异消灭）
    expect(liveState.messages).toHaveLength(1)
    expect(liveState.messages[0]).toMatchObject({
      role: 'system',
      content: '',
      status: 'complete',
      branchSummary: { summary: undefined, fromId: 'n-1', timestamp: 9600 },
    })
  })

  it("E5c: branchSummary 空串 summary 处置（readBranchSummary 空串门——'' 保留 '' 不丢成 undefined，两侧同值同路径）", () => {
    // 与 E4c（compaction 空串）同族：readBranchSummary 的 `s !== undefined` 门透传 ''，
    // reducer `'' ?? ''` 不触发——两侧同保留空行，与 E5b 的 undefined 形态对照。
    const liveBranch: PiEntry = {
      type: 'branch_summary',
      id: 'br-00000011-0000-4000-8000-000000000011',
      parentId: null,
      timestamp: ts(9700),
      summary: '',
      fromId: 'n-2',
    }
    const replayBranch: PiEntry = {
      type: 'branch_summary',
      id: piId(11),
      parentId: null,
      timestamp: ts(9700),
      summary: '',
      fromId: 'n-2',
    }
    const liveState = normalizeIds(replayEntries([liveBranch]))
    const replayState = normalizeIds(replayEntries([replayBranch]))
    expect(liveState).toEqual(replayState)
    expect(liveState.messages[0]).toMatchObject({ role: 'system', content: '', branchSummary: { summary: '', fromId: 'n-2' } })
    expect(replayState.messages[0]).toMatchObject({ role: 'system', content: '' })
  })
})

// ── 双入口等价（R1-S1 修复锁定 / R2-TC S1）──────────────────────────────────────
//
// 生产实际输入（runtime worker 对 pi 0.84.1 实证）：同一条 toolResult 双发
// tool_execution_end + message_end{role:'toolResult'} 两个事件 → xyz 两条帧
// （message.tool_call_end / message.message_end）各喂 applyEntry 一次（registry 两
// handler）。此前 reducer 无幂等：异常时序（assistant 帧丢失 / hydrate 空窗）下第二条帧
// 重复收集 orphan 或二次回填，orphan 永久残留 → live/reload 漂移。修复 = reducer
// deliveredToolResultIds 幂等（applyToolResultMessage：同 toolCallId 首次投递后二次 no-op）。
// 本组断言：双喂入序列终态 ≡ 单喂入序列终态（全量 state deep-equal，非抽样），且单入口
// 契约不被去重破坏——去重键是「已投递过该 toolCallId 的 toolResult」而非「存在该
// toolCallId」。entry 按生产构造点形态手写（tool_call_end：event-adapter
// handleToolExecutionEnd；message_end：handleMessageEnd——同内容同构、均无 entry id）。
describe('双入口等价（R2-TC S1）——同 toolCallId 双帧喂入 ≡ 单帧喂入', () => {
  const ts = (ms: number) => new Date(ms).toISOString()

  const assistantWithTc1: PiEntry = {
    type: 'message',
    id: undefined,
    parentId: null,
    timestamp: ts(2000),
    message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tc-1', name: 'bash', arguments: { command: 'npm test' } }], timestamp: 2000 },
  }
  /** 同一条 toolResult 的帧 entry 构造（两入口构造点产出同内容同构 entry） */
  const toolResultEntry = (text: string): PiEntry => ({
    type: 'message',
    id: undefined,
    parentId: null,
    timestamp: ts(3000),
    message: { role: 'toolResult', toolCallId: 'tc-1', toolName: 'bash', content: [{ type: 'text', text }], timestamp: 3000 },
  })
  const viaToolCallEnd = toolResultEntry('all green') // message.tool_call_end 帧（生产时序先到）
  const viaMessageEnd = toolResultEntry('all green') // message.message_end 帧（后到）

  it('S1a: 正常时序双喂入 ≡ 单喂入——回填恰一次、无 orphan、无重复消息', () => {
    const dual = replayEntries([assistantWithTc1, viaToolCallEnd, viaMessageEnd])
    const single = replayEntries([assistantWithTc1, viaToolCallEnd])
    expect(dual).toEqual(single) // 全量 state（messages + orphan + 簿记）deep-equal
    // 用户可见行为：host toolCall 不因双喂复制 / 二次改写，orphan 为零
    expect(dual.messages).toHaveLength(1)
    expect(dual.messages[0].toolCalls).toHaveLength(1)
    expect(dual.messages[0].toolCalls![0]).toMatchObject({ id: 'tc-1', output: 'all green', status: 'completed' })
    expect(dual.orphanToolResults).toHaveLength(0)
  })

  it('S1b: 异常时序（assistant 帧丢失）双喂入 ≡ 单喂入——orphan 恰一条不重复收集', () => {
    const dual = replayEntries([viaToolCallEnd, viaMessageEnd])
    const single = replayEntries([viaToolCallEnd])
    expect(dual).toEqual(single)
    expect(dual.messages).toHaveLength(0)
    expect(dual.orphanToolResults).toHaveLength(1) // 修复前为 2：重复收集且永久残留（漂移源）
  })

  it('S1c: 单入口契约——tool_call_end 帧丢失时 message_end 是唯一载体，照常投影', () => {
    const state = replayEntries([assistantWithTc1, viaMessageEnd])
    expect(state.messages[0].toolCalls![0]).toMatchObject({ id: 'tc-1', output: 'all green' })
    expect(state.orphanToolResults).toHaveLength(0)
  })

  it('S1d: 首投递优先——第二条帧内容不同（tool_call_end hook 改写 vs message_end 原始）不覆盖', () => {
    const state = replayEntries([assistantWithTc1, toolResultEntry('hook-rewritten'), toolResultEntry('original')])
    expect(state.messages[0].toolCalls![0].output).toBe('hook-rewritten') // no-op 保留首条（与 overlay 收口同值）
  })

  it('S1e: 同 turn 多 toolCall 各自双喂——按 id 各自回填恰一次，互不干扰', () => {
    const assistant: PiEntry = {
      type: 'message',
      id: undefined,
      parentId: null,
      timestamp: ts(2000),
      message: {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'tc-a', name: 'read', arguments: { path: '/a' } },
          { type: 'toolCall', id: 'tc-b', name: 'bash', arguments: { command: 'ls' } },
        ],
        timestamp: 2000,
      },
    }
    const result = (id: string, text: string): PiEntry => ({
      type: 'message',
      id: undefined,
      parentId: null,
      timestamp: ts(3000),
      message: { role: 'toolResult', toolCallId: id, toolName: 'read', content: [{ type: 'text', text }], timestamp: 3000 },
    })
    // 生产时序：tc-a 双帧 → tc-b 双帧
    const dual = replayEntries([assistant, result('tc-a', 'A'), result('tc-a', 'A'), result('tc-b', 'B'), result('tc-b', 'B')])
    const single = replayEntries([assistant, result('tc-a', 'A'), result('tc-b', 'B')])
    expect(dual).toEqual(single)
    expect(dual.orphanToolResults).toHaveLength(0)
    expect(dual.messages[0].toolCalls!.map((t) => t.output)).toEqual(['A', 'B'])
  })
})
