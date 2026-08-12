import { afterEach, describe, expect, it, vi } from 'vitest'

import { replayFoldEntries, type SchedulerEntryLike } from '../replay.js'
import type { SchedulerEntryOp, TaskSnapshot } from '../types.js'

/** 构造 pi-scheduler:task custom entry（包装 op）。 */
function entry(op: SchedulerEntryOp): SchedulerEntryLike {
  return { type: 'custom', customType: 'pi-scheduler:task', data: op }
}

/** 构造非 scheduler 的 custom entry（应被折叠忽略）。 */
function otherEntry(): SchedulerEntryLike {
  return { type: 'custom', customType: 'some-other-ext', data: { foo: 1 } }
}

/** 构造 message entry（应被折叠忽略）。 */
function messageEntry(): SchedulerEntryLike {
  return { type: 'message', data: {} }
}

/** 构造 base task 快照（upsert op 用）。 */
function snapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    id: 'aaa',
    name: 'test',
    prompt: 'p',
    kind: 'recurring',
    schedule: { mode: 'interval', intervalMs: 60000 },
    enabled: true,
    force: false,
    createdAt: 0,
    nextRunAt: 100,
    runCount: 0,
    history: [],
    ...overrides,
  }
}

describe('replayFoldEntries', () => {
  // ── TC-W-REPLAY-FOLD：折叠协议正确性（4 op 混合）──
  it('TC-W-REPLAY-FOLD: 折叠 upsert/advance/toggle/delete 4 op 到正确末态', () => {
    const session = '/s.json'
    const entries = [
      entry({ op: 'upsert', taskId: 'A', ownerSessionFile: session, task: snapshot({ id: 'A' }) }),
      entry({ op: 'upsert', taskId: 'B', ownerSessionFile: session, task: snapshot({ id: 'B' }) }),
      entry({
        op: 'advance',
        taskId: 'A',
        nextRunAt: 200,
        at: 100,
        status: 'success',
      }),
      entry({ op: 'toggle', taskId: 'A', enabled: false }),
      entry({ op: 'delete', taskId: 'B' }),
    ]

    const result = replayFoldEntries(entries, session)

    expect(result.size).toBe(1)
    expect(result.has('B')).toBe(false) // B 被 delete，不复活

    const a = result.get('A')!
    expect(a).toBeDefined()
    expect(a.nextRunAt).toBe(200)
    expect(a.lastRunAt).toBe(100)
    expect(a.runCount).toBe(1)
    expect(a.history).toEqual([{ at: 100, status: 'success' }])
    expect(a.lastStatus).toBe('success') // gap2：advance 恢复 lastStatus
    expect(a.enabled).toBe(false)
    expect(a.ownerSessionFile).toBe(session) // ownerSessionFile 从 op 顶层恢复
  })

  it('折叠忽略非 pi-scheduler:task 的 custom entry 与 message entry', () => {
    const session = '/s.json'
    const entries = [
      messageEntry(),
      otherEntry(),
      entry({ op: 'upsert', taskId: 'aaa', ownerSessionFile: session, task: snapshot() }),
      otherEntry(),
    ]
    const result = replayFoldEntries(entries, session)
    expect(result.size).toBe(1)
    expect(result.get('aaa')).toBeDefined()
  })

  it('折叠忽略 data 缺失或 op 字段非法的 entry（防御损坏 entry）', () => {
    const session = '/s.json'
    const entries: SchedulerEntryLike[] = [
      { type: 'custom', customType: 'pi-scheduler:task' }, // data undefined
      { type: 'custom', customType: 'pi-scheduler:task', data: { op: 123 } }, // op 非字符串
      { type: 'custom', customType: 'pi-scheduler:task', data: {} }, // 缺 op
      { type: 'custom', customType: 'pi-scheduler:task', data: null },
    ]
    const result = replayFoldEntries(entries, session)
    expect(result.size).toBe(0)
  })

  // ── TC-W-REPLAY-NEXTRUNAT：nextRunAt 不回退（D1 核心）──
  it('TC-W-REPLAY-NEXTRUNAT: recurring advance 推进 nextRunAt，重放不回退到初值', () => {
    const session = '/s.json'
    const entries = [
      entry({
        op: 'upsert',
        taskId: 'X',
        ownerSessionFile: session,
        task: snapshot({ id: 'X', nextRunAt: 100 }),
      }),
      entry({ op: 'advance', taskId: 'X', nextRunAt: 500, at: 200, status: 'success' }),
    ]

    const result = replayFoldEntries(entries, session)
    const x = result.get('X')!
    expect(x.nextRunAt).toBe(500) // 非 upsert 初值 100
    expect(x.runCount).toBe(1)
    expect(x.lastRunAt).toBe(200)
    expect(x.lastStatus).toBe('success')
  })

  // ── TC-W-FORK-OWNER-FILTER：全量折叠后整体过滤（gap1）──
  it('TC-W-FORK-OWNER-FILTER: fork 继承序列在非 owner session 重放后 Map 为空', () => {
    // upsert owner=A + advance（advance op 无 ownerSessionFile 字段）
    const entries = [
      entry({
        op: 'upsert',
        taskId: 'X',
        ownerSessionFile: '/a.json',
        task: snapshot({ id: 'X' }),
      }),
      entry({ op: 'advance', taskId: 'X', nextRunAt: 500, at: 200, status: 'success' }),
    ]

    // session B 重放：步骤①全量折叠得到 task(owner=A)，步骤②整体过滤移除
    const inB = replayFoldEntries(entries, '/b.json')
    expect(inB.size).toBe(0)
    expect(inB.has('X')).toBe(false)

    // 对照：session A 重放应保留 X（验证不是「永远过滤」，而是 owner 不匹配才过滤）
    const inA = replayFoldEntries(entries, '/a.json')
    expect(inA.size).toBe(1)
    expect(inA.get('X')!.nextRunAt).toBe(500)
  })

  // ── TC-W-GETENTRIES-FALLBACK：getEntries 异常兜底（gap4）──
  it('TC-W-GETENTRIES-FALLBACK: 迭代器抛错时 console.warn + 返回空 Map，不崩溃', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 构造迭代时抛错的 iterable（模拟 session JSONL 损坏）
    const throwingIterable: Iterable<SchedulerEntryLike> = {
      [Symbol.iterator]() {
        let i = 0
        return {
          next() {
            if (i++ === 0) throw new Error('JSONL corrupted')
            return { done: true, value: undefined as unknown as SchedulerEntryLike }
          },
        }
      },
    }

    const result = replayFoldEntries(throwingIterable, '/s.json')
    expect(result.size).toBe(0)
    expect(warnSpy).toHaveBeenCalled()
    const msg = warnSpy.mock.calls[0]![0] as string
    expect(msg).toContain('replayFoldEntries failed')
    expect(msg).toContain('JSONL corrupted')
    warnSpy.mockRestore()
  })

  // ── gap2 补强：advance 后 lastStatus/lastRunAt/runCount/history 全恢复 ──
  it('gap2: 多次 advance 累积 runCount/history，history 超 20 裁剪', () => {
    const session = '/s.json'
    const entries = [
      entry({ op: 'upsert', taskId: 'X', ownerSessionFile: session, task: snapshot({ id: 'X' }) }),
    ]
    for (let i = 1; i <= 25; i++) {
      entries.push(entry({ op: 'advance', taskId: 'X', nextRunAt: 100 + i * 100, at: i * 10, status: 'success' }))
    }

    const result = replayFoldEntries(entries, session)
    const x = result.get('X')!
    expect(x.runCount).toBe(25)
    expect(x.lastRunAt).toBe(250) // 最后一次 advance at
    expect(x.nextRunAt).toBe(2600) // 最后一次 advance nextRunAt (100+25*100)
    expect(x.lastStatus).toBe('success')
    expect(x.history.length).toBe(20) // 裁剪到 20
    // 保留最后 20 条（at=60..250），最早 5 条（at=10..50）被 shift 掉
    expect(x.history[0]!.at).toBe(60)
    expect(x.history[19]!.at).toBe(250)
  })

  // ── gap1 补强：delete 后该 taskId 不复活（后续 upsert 仍可重建）──
  it('gap1 补强: delete 后同 taskId 的 upsert 仍可重建任务', () => {
    const session = '/s.json'
    const entries = [
      entry({ op: 'upsert', taskId: 'A', ownerSessionFile: session, task: snapshot({ id: 'A', nextRunAt: 100 }) }),
      entry({ op: 'delete', taskId: 'A' }),
      // advance 对已删 taskId 为 no-op（安全）
      entry({ op: 'advance', taskId: 'A', nextRunAt: 999, at: 999, status: 'success' }),
      // upsert 重建 A
      entry({ op: 'upsert', taskId: 'A', ownerSessionFile: session, task: snapshot({ id: 'A', nextRunAt: 200 }) }),
    ]
    const result = replayFoldEntries(entries, session)
    const a = result.get('A')!
    expect(a).toBeDefined()
    expect(a.nextRunAt).toBe(200) // 重建后的快照值，非 advance 的 999（advance 在 delete 后 no-op）
    expect(a.runCount).toBe(0) // 重建后重置
  })

  // ── currentSessionFile undefined：所有带 owner 的任务被过滤（--no-session 模式）──
  it('currentSessionFile 为 undefined 时，带 ownerSessionFile 的任务被过滤', () => {
    const entries = [
      entry({ op: 'upsert', taskId: 'A', ownerSessionFile: '/a.json', task: snapshot({ id: 'A' }) }),
    ]
    const result = replayFoldEntries(entries, undefined)
    expect(result.size).toBe(0)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })
})
