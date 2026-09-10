/**
 * userStopped 标记 + restore-abort 收敛环单测（session-dead-structural-fixes D4，
 * 实施计划 u2 验收条款③：abort→settled→补发→再 abort→静默窗→清标记序列
 * +「settled 未到窗满不清」边界；条款③配套：K1/K2 置位分型 + 显式投递清标记）。
 *
 * 覆盖映射：
 * - UserStoppedGate 状态机（fake timers）：静默窗起算/重置/窗满收敛/掐而 settled 未到不清；
 * - interpreter 挂点接线：hook agent_start → noteAgentStart（拦截再 abort）、
 *   agent-settled → noteAgentSettled（窗重置）；
 * - dispatcher 置位分型：K1 forceQuit → source='user_force_quit'、K2 abort 超时强杀
 *   → source='abort_timeout'；
 * - sendPrompt 显式投递清标记放行（投递前清标记 + 停环，agent_start 不再被拦）。
 *
 * mock 策略：全部依赖 mock，不 spawn pi；收敛环定时器走 vi.useFakeTimers。
 * 运行：cd packages/runtime && npx vitest run test/user-stopped-convergence.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  UserStoppedGate,
  userStoppedGate,
  ABORT_STALL_CONVERGENCE_WINDOW_MS,
} from '../src/services/session/event-interpreter.js'
import { EventInterpreter } from '../src/services/session/event-interpreter.js'
import { MessageDispatcher } from '../src/services/session/message-dispatcher.js'
import { RpcTimeoutError } from '../src/utils/errors.js'
import type { ServerMessage } from '@xyz-agent/shared'
import type { UserStoppedMarkStore } from '../src/services/session/types.js'
import type { IDispatcherSessionOps } from '../src/services/session/session-internal.js'
import type { IManagedSessionView } from '../src/services/session/types.js'
import type { IMessageBus } from '../src/services/message-bus/message-bus.js'
import type { IPiEngine, IProcessManager } from '../src/services/ports/pi-engine.js'
import type { WorkspaceService } from '../src/services/workspace/workspace-service.js'

/** 记账式 mock 标记宿主（模拟 session-service.ts 模块级 Map 的语义）。 */
function makeMarkStore(): UserStoppedMarkStore & {
  marks: Map<string, { source: string }>
} {
  const marks = new Map<string, { source: string }>()
  return {
    marks,
    markUserStopped: vi.fn((sessionId: string, source: string) => { marks.set(sessionId, { source }) }),
    hasUserStoppedMark: vi.fn((sessionId: string) => marks.has(sessionId)),
    clearUserStoppedMark: vi.fn((sessionId: string) => { marks.delete(sessionId) }),
    clearAllUserStoppedMarks: vi.fn(() => marks.clear()),
  }
}

/** 组装 gate + 注入 mock 依赖（abort spy 可控）。 */
function makeGate() {
  const store = makeMarkStore()
  const abortSession = vi.fn<(sessionId: string) => Promise<void>>(async () => {})
  const gate = new UserStoppedGate()
  gate.configure({ marks: store, abortSession })
  return { gate, store, abortSession }
}

// ── Part A：UserStoppedGate 收敛环状态机（fake timers）──────────

describe('UserStoppedGate 收敛环状态机', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('常量：静默观察窗初值 3s（P-1 实测标定前的 SSOT）', () => {
    expect(ABORT_STALL_CONVERGENCE_WINDOW_MS).toBe(3_000)
  })

  it('idle 场景：restore-abort 完成起算静默窗，窗满无 agent_start → 判收敛清标记', async () => {
    const { gate, store, abortSession } = makeGate()
    gate.markUserStopped('s1', 'user_force_quit')
    gate.beginRestoreConvergence('s1')
    expect(store.hasUserStoppedMark('s1')).toBe(true)
    await vi.advanceTimersByTimeAsync(ABORT_STALL_CONVERGENCE_WINDOW_MS - 1)
    expect(store.hasUserStoppedMark('s1')).toBe(true) // 窗未满
    await vi.advanceTimersByTimeAsync(1)
    expect(store.hasUserStoppedMark('s1')).toBe(false) // 窗满收敛清标记
    expect(abortSession).not.toHaveBeenCalled() // idle 场景无补发 turn，收敛环零 abort
  })

  it('完整序列：abort→settled→补发 agent_start→再 abort→settled→静默窗满→清标记', async () => {
    const { gate, store, abortSession } = makeGate()
    gate.markUserStopped('s1', 'user_force_quit')
    // restore-abort 完成起算（restoreSession 返回前调用）
    gate.beginRestoreConvergence('s1')

    // 补发腿 #1：notify replay turn 开跑 → 拦截再 abort
    gate.noteAgentStart('s1')
    expect(abortSession).toHaveBeenCalledTimes(1)
    // 被掐 turn 收尾 → settled 边沿重置观察窗
    gate.noteAgentSettled('s1')
    await vi.advanceTimersByTimeAsync(ABORT_STALL_CONVERGENCE_WINDOW_MS - 100)
    expect(store.hasUserStoppedMark('s1')).toBe(true) // settled 重置过窗，未满

    // 补发腿 #2（多通知场景第二条 parked 通知）
    gate.noteAgentStart('s1')
    expect(abortSession).toHaveBeenCalledTimes(2)
    // 掐而 settled 未到：窗满不清（边界，见下一用例专测）——先推进超窗
    await vi.advanceTimersByTimeAsync(ABORT_STALL_CONVERGENCE_WINDOW_MS + 1_000)
    expect(store.hasUserStoppedMark('s1')).toBe(true)

    // settled 到达 → 重置窗 → 新窗满 → 判收敛清标记
    gate.noteAgentSettled('s1')
    await vi.advanceTimersByTimeAsync(ABORT_STALL_CONVERGENCE_WINDOW_MS - 1)
    expect(store.hasUserStoppedMark('s1')).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(store.hasUserStoppedMark('s1')).toBe(false)
  })

  it('边界「settled 未到窗满不清」：再 abort 掐掉的 turn 收尾超窗，settled 到达前标记不消费', async () => {
    const { gate, store, abortSession } = makeGate()
    gate.markUserStopped('s1', 'abort_timeout')
    gate.beginRestoreConvergence('s1')
    gate.noteAgentStart('s1') // 掐 → pendingSettled=true
    expect(abortSession).toHaveBeenCalledTimes(1)

    // 窗满时点：settled 未到（pi 收尾卡顿超窗）→ 不清，标记保留
    await vi.advanceTimersByTimeAsync(ABORT_STALL_CONVERGENCE_WINDOW_MS * 3)
    expect(store.hasUserStoppedMark('s1')).toBe(true)

    // settled 到达 → 重置窗；重置后窗内无新 agent_start → 窗满清
    gate.noteAgentSettled('s1')
    await vi.advanceTimersByTimeAsync(ABORT_STALL_CONVERGENCE_WINDOW_MS)
    expect(store.hasUserStoppedMark('s1')).toBe(false)
  })

  it('标记存活期内的 agent_start 一律拦截；环未活跃（正常会话/显式投递后）零拦截', () => {
    const { gate, abortSession } = makeGate()
    // 环未活跃：正常会话的 agent_start（含显式投递开 turn）不触发 abort
    gate.noteAgentStart('s1')
    expect(abortSession).not.toHaveBeenCalled()
  })

  it('再 abort 失败：标记不视为已消费（窗满不清），等待 settled 或用户恢复路径', async () => {
    const { gate, store, abortSession } = makeGate()
    abortSession.mockRejectedValueOnce(new Error('pi unresponsive'))
    gate.markUserStopped('s1', 'user_force_quit')
    gate.beginRestoreConvergence('s1')
    gate.noteAgentStart('s1') // abort 将 reject
    await vi.advanceTimersByTimeAsync(ABORT_STALL_CONVERGENCE_WINDOW_MS * 2)
    // pendingSettled=true（掐了 turn）→ 窗满不清；标记保留（错误规格 §3.4：收敛环未完成）
    expect(store.hasUserStoppedMark('s1')).toBe(true)
  })

  it('显式投递清标记放行：consumeForExplicitDelivery 清标记 + 停环，后续 agent_start 不再被拦', async () => {
    const { gate, store, abortSession } = makeGate()
    gate.markUserStopped('s1', 'user_force_quit')
    gate.beginRestoreConvergence('s1')
    gate.consumeForExplicitDelivery('s1')
    expect(store.hasUserStoppedMark('s1')).toBe(false)
    // 新意图开 turn 的 agent_start（事件回流晚于清标记）不再被拦截
    gate.noteAgentStart('s1')
    expect(abortSession).not.toHaveBeenCalled()
    // 窗推进不再有任何收敛动作（环已停）
    await vi.advanceTimersByTimeAsync(ABORT_STALL_CONVERGENCE_WINDOW_MS * 2)
    expect(store.hasUserStoppedMark('s1')).toBe(false)
  })

  it('disposeForEntryRemoval 只停环不清标记（forceQuit 尾步 removeSessionEntry 经过，标记须存活到 restore）；disposeForDelete 全清', () => {
    const { gate, store } = makeGate()
    gate.markUserStopped('s1', 'user_force_quit')
    gate.beginRestoreConvergence('s1')
    gate.disposeForEntryRemoval('s1')
    expect(store.hasUserStoppedMark('s1')).toBe(true) // 标记存活
    gate.noteAgentStart('s1') // 环已停 → 不拦
    gate.disposeForDelete('s1')
    expect(store.hasUserStoppedMark('s1')).toBe(false) // delete 全清
  })

  it('disposeAll：全量停环 + 清全部标记（destroyAll shutdown 路径）', async () => {
    const { gate, store } = makeGate()
    gate.markUserStopped('a', 'user_force_quit')
    gate.markUserStopped('b', 'abort_timeout')
    gate.beginRestoreConvergence('a')
    gate.beginRestoreConvergence('b')
    gate.disposeAll()
    expect(store.hasUserStoppedMark('a')).toBe(false)
    expect(store.hasUserStoppedMark('b')).toBe(false)
    await vi.advanceTimersByTimeAsync(ABORT_STALL_CONVERGENCE_WINDOW_MS * 2) // 定时器已清，无副作用
  })

  it('未 configure（deps 缺省）：hasMark false，消费/观测 no-op 不抛（存量测试环境零接线兼容）', () => {
    const gate = new UserStoppedGate()
    expect(gate.hasUserStoppedMark('s1')).toBe(false)
    expect(() => gate.consumeForExplicitDelivery('s1')).not.toThrow()
    expect(() => gate.noteAgentStart('s1')).not.toThrow()
    expect(() => gate.noteAgentSettled('s1')).not.toThrow()
    expect(() => gate.disposeForDelete('s1')).not.toThrow()
  })
})

// ── Part B：interpreter 挂点接线（agent_start / agent_settled）──

describe('EventInterpreter 收敛环挂点接线', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    userStoppedGate.resetForTest()
  })

  it('hook agent_start（标记存活 + 环活跃）→ 触发拦截再 abort', () => {
    const store = makeMarkStore()
    const abortSession = vi.fn(async () => {})
    // 挂点读模块级单例——begin/置标记必须作用在同一单例上（与生产 SessionService.configure 形态一致）
    userStoppedGate.configure({ marks: store, abortSession })
    userStoppedGate.markUserStopped('s1', 'user_force_quit')
    userStoppedGate.beginRestoreConvergence('s1')

    const sent: ServerMessage[] = []
    const interpreter = new EventInterpreter('s1', { send: (m) => { sent.push(m) } })
    interpreter.interpret([{ kind: 'hook', eventType: 'agent_start', data: {} }])
    expect(abortSession).toHaveBeenCalledTimes(1)
  })

  it('agent-settled 事件 → 重置静默窗（掐而未 settled 的窗满不清被 settled 解锁）', async () => {
    const store = makeMarkStore()
    const abortSession = vi.fn(async () => {})
    userStoppedGate.configure({ marks: store, abortSession })
    userStoppedGate.markUserStopped('s1', 'user_force_quit')
    userStoppedGate.beginRestoreConvergence('s1')

    const sent: ServerMessage[] = []
    const interpreter = new EventInterpreter('s1', { send: (m) => { sent.push(m) } })
    interpreter.interpret([{ kind: 'hook', eventType: 'agent_start', data: {} }])
    expect(abortSession).toHaveBeenCalledTimes(1)
    interpreter.interpret([{ kind: 'agent-settled' }])
    await vi.advanceTimersByTimeAsync(ABORT_STALL_CONVERGENCE_WINDOW_MS)
    expect(store.hasUserStoppedMark('s1')).toBe(false) // settled 重置窗 → 新窗满 → 收敛
  })
})

// ── Part C：dispatcher 置位分型（K1/K2）与显式投递清标记 ─────────

describe('MessageDispatcher 置位分型与显式投递清标记', () => {
  function makeDispatcher(opts: {
    session?: IManagedSessionView
    abortBehavior?: 'ok' | 'rpc-timeout'
  } = {}) {
    const session = opts.session ?? makeMockSession()
    const abortFn = opts.abortBehavior === 'rpc-timeout'
      ? vi.fn(async () => { throw new RpcTimeoutError('abort', 60000) })
      : vi.fn(async () => {})
    const client = {
      prompt: vi.fn(async () => ({}) as unknown as Awaited<ReturnType<IPiEngine['prompt']>>),
      abort: abortFn,
    } as unknown as IPiEngine
    const svc: IDispatcherSessionOps = {
      ensureActive: vi.fn(async () => client),
      getSessionByClient: vi.fn(() => session),
      persistSessionOutcome: vi.fn(),
      getSession: vi.fn(() => session),
      removeSessionEntry: vi.fn(),
      detachSession: vi.fn(),
    }
    const pm = {
      getClient: vi.fn(() => client),
      destroySession: vi.fn(async () => {}),
    } as unknown as IProcessManager
    const publish = vi.fn()
    const dispatcher = new MessageDispatcher(svc, pm, { record: vi.fn() } as unknown as WorkspaceService, { publish } as unknown as IMessageBus)
    return { dispatcher, session, publish, abortFn }
  }

  function makeMockSession(overrides: Partial<IManagedSessionView> = {}): IManagedSessionView {
    return {
      id: 's1', cwd: '/test', label: 'test', modelId: 'm1', createdAt: 1, lastActiveAt: 1,
      tokenCount: 0, inputTokens: 0, isGenerating: false, isCompacting: false, isBashRunning: false,
      bashRunToken: undefined,
      ...overrides,
    }
  }

  let store: ReturnType<typeof makeMarkStore>
  let abortSession: (sessionId: string) => Promise<void>

  beforeEach(() => {
    vi.useFakeTimers()
    store = makeMarkStore()
    abortSession = vi.fn(async (_sessionId: string) => {})
    userStoppedGate.configure({ marks: store, abortSession })
  })
  afterEach(() => {
    vi.useRealTimers()
    userStoppedGate.resetForTest()
  })

  it('K1：forceQuit（用户强制退出）→ 置标记 source=user_force_quit', async () => {
    const { dispatcher } = makeDispatcher()
    await dispatcher.forceQuit('s1')
    expect(store.marks.get('s1')).toEqual({ source: 'user_force_quit' })
  })

  it('K2：abort RPC 超时强杀收口 → 置标记 source=abort_timeout', async () => {
    const { dispatcher } = makeDispatcher({
      session: makeMockSession({ isGenerating: true }),
      abortBehavior: 'rpc-timeout',
    })
    await dispatcher.abort('s1')
    expect(store.marks.get('s1')).toEqual({ source: 'abort_timeout' })
    expect(store.marks.size).toBe(1) // 分型：只置一次标记（forceQuitSession 单一置位入口）
  })

  it('sendPrompt 显式投递：投递前清标记放行，标记不在时照常投递（零开销）', async () => {
    const { dispatcher } = makeDispatcher()
    userStoppedGate.markUserStopped('s1', 'user_force_quit')
    gateBegin('s1')
    const result = await dispatcher.sendMessage('s1', 'hello')
    expect(result.blocked).toBe(false)
    expect(store.hasUserStoppedMark('s1')).toBe(false) // 投递前已清
  })

  it('显式投递开 turn 的 agent_start 事件回流不被收敛环误掐（时序构造性：清标记先于 prompt）', async () => {
    const { dispatcher } = makeDispatcher()
    userStoppedGate.markUserStopped('s1', 'user_force_quit')
    gateBegin('s1')
    await dispatcher.sendMessage('s1', 'hello') // 清标记 + 停环 + prompt 发出
    // 模拟 pi 处理 prompt 后开 turn，agent_start 事件回流 interpreter
    const sent: ServerMessage[] = []
    const interpreter = new EventInterpreter('s1', { send: (m) => { sent.push(m) } })
    interpreter.interpret([{ kind: 'hook', eventType: 'agent_start', data: {} }])
    expect(abortSession).not.toHaveBeenCalled()
  })

  /** gate.begin 的测试辅助（确保 store 与 gate 共用同一 mock 宿主）。 */
  function gateBegin(sessionId: string): void {
    userStoppedGate.beginRestoreConvergence(sessionId)
  }
})
