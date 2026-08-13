/**
 * MessageDispatcher 竞态守卫测试（PR#116 review W1 + W3）。
 *
 * 锁定：
 * - W1: sendBash 在 await client.bash() 期间被 abortBash 抢先收口时，
 *   pi 响应到达后 sendBash 静默跳过终态广播（不重复广播 bashResult / message.error）。
 *   验证两条终态不会同时出现：cancelled bashResult（来自 abortBash）+ 真实 output bashResult（来自 sendBash）。
 * - W1b: sendBash await 抛错时若已被 abortBash 抢先收口，也不广播 message.error（避免双重报错）。
 * - W3: compact() 在 isBashRunning=true 或 isGenerating=true 时被拒（广播 session.compacted{error} + throw）。
 *
 * 运行：npx vitest run src/__tests__/message-dispatcher-bash-race.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MessageDispatcher } from '../services/session/message-dispatcher.js'
import type { ISessionServiceInternal } from '../services/session/session-internal.js'
import type { IManagedSessionView } from '../services/session/types.js'
import type { IMessageBroker } from '../interfaces.js'
import type { IPiEngine, IProcessManager, PiBashResult } from '../services/ports/pi-engine.js'
import type { ServerMessage } from '@xyz-agent/shared'
import type { WorkspaceService } from '../services/workspace/workspace-service.js'

type BashResultMsg = ServerMessage<'message.bashResult'>
/** 返回所有 message.bashResult 广播（W1 竞态需断言「总数==1」故需数组而非首条）。 */
function findBashResults(b: ServerMessage[]): BashResultMsg[] {
  return b.filter((m): m is BashResultMsg => m.type === 'message.bashResult')
}

function makeMockSession(overrides: Partial<IManagedSessionView> = {}): IManagedSessionView {
  return {
    id: 's1',
    cwd: '/test',
    label: 'test',
    modelId: 'm1',
    createdAt: 1,
    lastActiveAt: 1,
    tokenCount: 0,
    inputTokens: 0,
    isGenerating: false,
    isCompacting: false,
    isBashRunning: false,
    bashRunToken: undefined,
    labelPersisted: false,
    ...overrides,
  }
}

/**
 * W1 专用 mock：client.bash 用可控 Promise（bashResolve/bashReject），
 * 调用方可在 sendBash await 期间触发 abortBash，再 resolve/reject client.bash。
 */
function makeRaceMocks() {
  const session = makeMockSession()

  let bashResolve!: (r: PiBashResult) => void
  let bashReject!: (e: Error) => void
  const bashPromise = new Promise<PiBashResult>((res, rej) => {
    bashResolve = res
    bashReject = rej
  })
  const bashFn = vi.fn(() => bashPromise)
  const abortBashFn = vi.fn(async () => ({}) as Awaited<ReturnType<IPiEngine['abortBash']>>)
  const compactFn = vi.fn(async () => ({}) as Awaited<ReturnType<IPiEngine['compact']>>)

  const client = {
    prompt: vi.fn(async () => ({})),
    bash: bashFn,
    abortBash: abortBashFn,
    compact: compactFn,
  } as unknown as IPiEngine

  const broadcasts: ServerMessage[] = []
  const broker = { broadcast: vi.fn((m: ServerMessage) => { broadcasts.push(m) }) } as unknown as IMessageBroker

  const svc = {
    ensureActive: vi.fn(async () => client),
    getSessionByClient: vi.fn(() => session),
  } as unknown as ISessionServiceInternal

  const pm = { getClient: vi.fn(() => client) } as unknown as IProcessManager
  const workspace = { record: vi.fn() } as unknown as WorkspaceService

  const dispatcher = new MessageDispatcher(svc, pm, broker, workspace)
  return { dispatcher, session, bashFn, abortBashFn, compactFn, broadcasts, bashResolve, bashReject }
}

describe('MessageDispatcher —— W1 abortBash/sendBash 竞态守卫', () => {
  beforeEach(() => vi.clearAllMocks())

  it('W1a: abortBash 在 sendBash await 期间抢先收口后，pi resolve 到达时 sendBash 不再广播真实 bashResult（无重复终态）', async () => {
    const { dispatcher, broadcasts, bashResolve, abortBashFn } = makeRaceMocks()

    // sendBash 启动，await client.bash() 挂起
    const sendPromise = dispatcher.sendBash('s1', 'long-running-cmd', false)
    await Promise.resolve() // 让 sendBash 跑到 await client.bash

    // 此时 bashStart 已广播，client.bash 已被调用（pending）
    expect(broadcasts.some((m) => m.type === 'message.bashStart')).toBe(true)
    expect(abortBashFn).not.toHaveBeenCalled()

    // 用户调 abortBash：抢先广播 cancelled bashResult 终态
    await dispatcher.abortBash('s1')
    expect(abortBashFn).toHaveBeenCalledTimes(1)
    // abortBash 广播了 cancelled bashResult
    const cancelledResults = broadcasts.filter(
      (m) => m.type === 'message.bashResult' && (m as BashResultMsg).payload.cancelled === true,
    )
    expect(cancelledResults).toHaveLength(1)

    // pi 响应到达：client.bash resolve 带真实 output
    bashResolve({ output: 'real output', exitCode: 0, cancelled: false, truncated: false })
    const result = await sendPromise

    // 关键断言：sendBash 检测到被 abort 抢先收口，不再广播带真实 output 的 bashResult。
    // bashResult 总数应仍为 1（只有 abortBash 广播的 cancelled 那条），无第二条带 real output 的。
    const allResults = findBashResults(broadcasts)
    expect(allResults).toHaveLength(1)
    expect(allResults[0]!.payload.cancelled).toBe(true)
    expect(allResults.some((r) => r.payload.output === 'real output')).toBe(false)

    // 不广播 message.error（pi 是正常 resolve，无错误）
    expect(broadcasts.some((m) => m.type === 'message.error')).toBe(false)

    // sendBash 返回 blocked（静默跳过）
    expect(result).toEqual({ blocked: true })
  })

  it('W1b: abortBash 抢先收口后，client.bash reject 到达时 sendBash 不广播 message.error（避免双重报错）', async () => {
    const { dispatcher, broadcasts, bashReject } = makeRaceMocks()

    const sendPromise = dispatcher.sendBash('s1', 'doomed-cmd', false)
    await Promise.resolve()

    // abortBash 抢先收口（广播 cancelled bashResult）
    await dispatcher.abortBash('s1')
    const cancelledCount = broadcasts.filter(
      (m) => m.type === 'message.bashResult' && (m as BashResultMsg).payload.cancelled === true,
    ).length
    expect(cancelledCount).toBe(1)

    // pi 响应到达：client.bash reject
    bashReject(new Error('stream closed by abort'))
    const result = await sendPromise

    // 关键断言：sendBash 检测到被 abort 抢先收口，不广播 message.error
    // （cancelled bashResult 已是终态，再补 message.error 会双重报错）。
    expect(broadcasts.some((m) => m.type === 'message.error')).toBe(false)

    // 仍只有 abortBash 广播的那条 cancelled bashResult，无 S2 兜底 bashResult（因已被 abort 抢先）
    const allResults = findBashResults(broadcasts)
    expect(allResults).toHaveLength(1)
    expect(allResults[0]!.payload.cancelled).toBe(true)

    expect(result).toEqual({ blocked: true })
  })

  it('W1c: 无 abort 时 sendBash 正常广播真实 bashResult（守卫不影响正常路径）', async () => {
    const { dispatcher, broadcasts, bashResolve } = makeRaceMocks()

    const sendPromise = dispatcher.sendBash('s1', 'normal-cmd', false)
    await Promise.resolve()

    // 无 abort：pi 正常 resolve
    bashResolve({ output: 'done', exitCode: 0, cancelled: false, truncated: false })
    const result = await sendPromise

    // 正常广播真实 bashResult（cancelled:false）
    const allResults = findBashResults(broadcasts)
    expect(allResults).toHaveLength(1)
    expect(allResults[0]!.payload).toMatchObject({ output: 'done', exitCode: 0, cancelled: false })
    // 不广播 message.error
    expect(broadcasts.some((m) => m.type === 'message.error')).toBe(false)
    expect(result).toEqual({ blocked: false })
  })
})

describe('MessageDispatcher —— W3 compact busy 预检', () => {
  beforeEach(() => vi.clearAllMocks())

  it('W3a: isBashRunning=true 时 compact → throw + 零 compaction 广播（M4 事件驱动）+ 不调 client.compact', async () => {
    const { dispatcher, compactFn, broadcasts, session } = makeRaceMocks()
    session.isBashRunning = true

    await expect(dispatcher.compact('s1')).rejects.toThrow(/bash running/)

    // 不调 client.compact
    expect(compactFn).not.toHaveBeenCalled()
    // 零 compaction 广播（M4：dispatcher 退化为预检+RPC+复位，生命周期由 interpreter 唯一编排）
    const compactionBroadcasts = broadcasts.filter((m) =>
      ['session.compacting', 'session.compacted', 'message.compactionSummary'].includes(m.type),
    )
    expect(compactionBroadcasts).toHaveLength(0)
    // 未置 isCompacting（被拒；置位归 interpreter 的 compaction_start）
    expect(session.isCompacting).toBe(false)
  })

  it('W3b: isGenerating=true 时 compact → throw + 零 compaction 广播 + 不调 client.compact', async () => {
    const { dispatcher, compactFn, broadcasts, session } = makeRaceMocks()
    session.isGenerating = true

    await expect(dispatcher.compact('s1')).rejects.toThrow(/generating/)

    expect(compactFn).not.toHaveBeenCalled()
    const compactionBroadcasts = broadcasts.filter((m) =>
      ['session.compacting', 'session.compacted', 'message.compactionSummary'].includes(m.type),
    )
    expect(compactionBroadcasts).toHaveLength(0)
    expect(session.isCompacting).toBe(false)
  })

  it('W3c: idle 时 compact 正常进入压缩流程（预检不误拒，零 compaction 广播）', async () => {
    const { dispatcher, compactFn, broadcasts, session } = makeRaceMocks()
    // idle（isBashRunning=false, isGenerating=false）
    await dispatcher.compact('s1')

    // 调 client.compact（RPC 触发保留）
    expect(compactFn).toHaveBeenCalledTimes(1)
    // 零 compaction 广播（compacting/compacted/summary 由 interpreter 从 pi 事件驱动）
    const compactionBroadcasts = broadcasts.filter((m) =>
      ['session.compacting', 'session.compacted', 'message.compactionSummary'].includes(m.type),
    )
    expect(compactionBroadcasts).toHaveLength(0)
    // isCompacting 兜底复位（finally；置位归 interpreter，此处对 false 无害）
    expect(session.isCompacting).toBe(false)
  })
})
