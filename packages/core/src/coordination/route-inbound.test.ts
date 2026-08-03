/**
 * route-inbound.test.ts —— configureRouteInbound 行为等价断言（F8，TC-2）。
 *
 * 覆盖 IF4 处理顺序全路径：
 * ① msg.id + type==='error' → pending.reject(Error) + error envelope 展开（ES1）+ 不进路由表
 * ② msg.id + 非 error → pending.resolve(id, payload) + 不进路由表
 * ③ 有 sessionId 未注册 type → seq gap 中间件 + dispatchSession + 更新 lastSeenSeq
 * ④ gap（seq>lastSeenSeq+1）→ subscribeSession(sid, seq-1) 被调用 + 当前消息仍 dispatch
 * ⑤ 无 sessionId → dispatchGlobal + L9 warn（session./message. 前缀）
 * ⑥ 未注册 type 落 fallback（恒真条目，有 sid 也 dispatchSession）
 * ⑦ effects 回调：session.exited / message.complete / session.subagents /
 *    session.workflowUpdate / error 无 id → onGlobalError
 * ⑧ configureRouteInbound 注入三件套 + dispatcher 可调用
 *
 * 全部注入驱动：vi.fn 注入 TransportPorts（pending/events/subscribe）+ InboundEffects 5 回调 spy。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { configureRouteInbound } from './route-inbound'
import type { TransportPorts, InboundEffects } from './route-inbound'
import { resetSubscriptionStates, subscribeSession } from './subscription-state'
import type { ServerMessage } from '@xyz-agent/shared'

function makePorts(overrides?: Partial<TransportPorts>): TransportPorts {
  return {
    pending: {
      resolve: vi.fn(),
      reject: vi.fn(),
      rejectAll: vi.fn(),
    },
    events: {
      dispatchSession: vi.fn(),
      dispatchGlobal: vi.fn(),
    },
    subscribe: vi.fn().mockResolvedValue({
      snapshot: [],
      stateSnapshot: [],
      lastSeq: 0,
      gap: false,
    }),
    ...overrides,
  }
}

function makeEffects(overrides?: Partial<InboundEffects>): InboundEffects {
  return {
    onSessionExited: vi.fn(),
    onMessageComplete: vi.fn(),
    onSubagents: vi.fn(),
    onWorkflowUpdate: vi.fn(),
    onGlobalError: vi.fn(),
    ...overrides,
  }
}

/** 构造带 sessionId payload 的消息（session 通道） */
function sessionMsg(type: string, payload: Record<string, unknown>, extra?: Partial<ServerMessage>): ServerMessage {
  return { type: type as ServerMessage['type'], payload: { sessionId: 's1', ...payload }, ...extra } as ServerMessage
}

describe('configureRouteInbound — pending 分流（①/②/⑧）', () => {
  beforeEach(() => {
    resetSubscriptionStates()
  })

  it('① error + msg.id：reject(Error) + error envelope 展开（ES1：message/code 默认值、details.detail string→cwd、object→Object.assign）+ 不进路由表', () => {
    const ports = makePorts()
    const effects = makeEffects()
    const dispatcher = configureRouteInbound(ports, effects)

    // 默认值分支
    dispatcher({
      type: 'error',
      id: 'req-1',
      payload: {},
    } as unknown as ServerMessage)
    expect(ports.pending.reject).toHaveBeenCalledTimes(1)
    const err1 = (ports.pending.reject as ReturnType<typeof vi.fn>).mock.calls[0][1] as Error & Record<string, unknown>
    expect(err1.message).toBe('request failed')
    expect(err1.code).toBe('unknown')
    // 不进路由表：无 sessionId 也不 dispatchGlobal（D7）
    expect(ports.events.dispatchGlobal).not.toHaveBeenCalled()
    expect(ports.events.dispatchSession).not.toHaveBeenCalled()

    // string detail → cwd
    dispatcher({
      type: 'error',
      id: 'req-2',
      payload: { code: 'WORKTREE_EXISTS', message: 'exists', details: { detail: '/path/cwd' } },
    } as unknown as ServerMessage)
    const err2 = (ports.pending.reject as ReturnType<typeof vi.fn>).mock.calls[1][1] as Error & Record<string, unknown>
    expect(err2.message).toBe('exists')
    expect(err2.code).toBe('WORKTREE_EXISTS')
    expect(err2.cwd).toBe('/path/cwd')

    // object detail → Object.assign 展开
    dispatcher({
      type: 'error',
      id: 'req-3',
      payload: { code: 'SETUP_FAILED', message: 'setup', details: { detail: { exitCode: 1, stderr: 'boom' } } },
    } as unknown as ServerMessage)
    const err3 = (ports.pending.reject as ReturnType<typeof vi.fn>).mock.calls[2][1] as Error & Record<string, unknown>
    expect(err3.code).toBe('SETUP_FAILED')
    expect(err3.exitCode).toBe(1)
    expect(err3.stderr).toBe('boom')
  })

  it('② 非 error + msg.id：resolve(id, payload) + 不进路由表', () => {
    const ports = makePorts()
    const dispatcher = configureRouteInbound(ports)
    dispatcher({
      type: 'session.getHistory',
      id: 'req-9',
      payload: { sessionId: 's1', messages: [] },
    } as unknown as ServerMessage)
    expect(ports.pending.resolve).toHaveBeenCalledWith('req-9', { sessionId: 's1', messages: [] })
    // D7：pending 分流后 return，不再进路由表（即使 payload 带 sessionId）
    expect(ports.events.dispatchSession).not.toHaveBeenCalled()
  })

  it('⑧ configureRouteInbound 返回可调用 dispatcher；effects 可选（不传不崩）', () => {
    const ports = makePorts()
    const dispatcher = configureRouteInbound(ports) // 无 effects
    expect(typeof dispatcher).toBe('function')
    expect(() => dispatcher({ type: 'x.unknown', payload: {} } as unknown as ServerMessage)).not.toThrow()
    expect(ports.events.dispatchGlobal).toHaveBeenCalled()
  })
})

describe('configureRouteInbound — session 通道 + seq gap 中间件（③/④/⑥）', () => {
  beforeEach(() => {
    resetSubscriptionStates()
  })

  it('③ 有 sessionId 未注册 type（fallback）：seq gap 中间件 + dispatchSession', () => {
    const ports = makePorts()
    const dispatcher = configureRouteInbound(ports)
    dispatcher(sessionMsg('config.providers', { providers: [] }))
    expect(ports.events.dispatchSession).toHaveBeenCalledWith('s1', expect.objectContaining({ type: 'config.providers' }))
    expect(ports.events.dispatchGlobal).not.toHaveBeenCalled()
  })

  it('④ gap（seq>lastSeenSeq+1）→ subscribeSession(sid, seq-1) + 当前消息仍 dispatch', async () => {
    const ports = makePorts()
    const dispatcher = configureRouteInbound(ports)
    // 先建立订阅（模拟 renderer ensureStreamSubscription）：lastSeenSeq 基线 = 10
    ;(ports.subscribe as ReturnType<typeof vi.fn>).mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 10 })
    await subscribeSession('s1')
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(0) // 空回放

    // gap：seq 13 > 10+1 → reconcile 回拉 + 当前消息仍 dispatch
    dispatcher(sessionMsg('session.ping', {}, { seq: 13 }))
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1) // 当前消息仍 dispatch
    expect(ports.subscribe).toHaveBeenCalledTimes(2) // 第二次 = reconcile 回拉
    expect(ports.subscribe).toHaveBeenLastCalledWith('s1', 12) // fromSeq = seq-1
  })

  it('④b drop（seq<=lastSeenSeq）：不 dispatch 不触发 reconcile', async () => {
    const ports = makePorts()
    const dispatcher = configureRouteInbound(ports)
    ;(ports.subscribe as ReturnType<typeof vi.fn>).mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 10 })
    await subscribeSession('s1')

    dispatcher(sessionMsg('session.ping', {}, { seq: 8 })) // 重复/乱序
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(0) // 不 dispatch
    expect(ports.subscribe).toHaveBeenCalledTimes(1) // 不触发 reconcile
  })

  it('④c 正常递进（seq === lastSeenSeq+1）：dispatch + 更新基线', async () => {
    const ports = makePorts()
    const dispatcher = configureRouteInbound(ports)
    ;(ports.subscribe as ReturnType<typeof vi.fn>).mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 10 })
    await subscribeSession('s1')

    dispatcher(sessionMsg('session.ping', {}, { seq: 11 }))
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1)
    expect(ports.subscribe).toHaveBeenCalledTimes(1) // 不触发 reconcile
    // 下一条 seq=12 正常递进（基线已推进到 11）
    dispatcher(sessionMsg('session.ping', {}, { seq: 12 }))
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(2)
    expect(ports.subscribe).toHaveBeenCalledTimes(1)
  })

  it('⑥ 未注册 type 落 fallback（恒真条目）——有 sid 走 dispatchSession、无 sid 走 dispatchGlobal', () => {
    const ports = makePorts()
    const dispatcher = configureRouteInbound(ports)
    dispatcher(sessionMsg('some.new.type', { data: 1 }))
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1)
    dispatcher({ type: 'config.model.list', payload: { models: [] } } as unknown as ServerMessage)
    expect(ports.events.dispatchGlobal).toHaveBeenCalledTimes(1)
  })
})

describe('configureRouteInbound — global 通道 + L9 + effects（⑤/⑦）', () => {
  beforeEach(() => {
    resetSubscriptionStates()
  })

  it('⑤ 无 sessionId → dispatchGlobal + L9 warn（session./message. 前缀）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ports = makePorts()
    const dispatcher = configureRouteInbound(ports)
    dispatcher({ type: 'session.exited', payload: { code: 1, reason: 'x' } } as unknown as ServerMessage)
    expect(ports.events.dispatchGlobal).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('session-level message missing sessionId'),
      'session.exited',
    )
    warnSpy.mockRestore()
  })

  it('⑦ session.exited 条目：dispatchSession 后 onSessionExited 回调', () => {
    const ports = makePorts()
    const effects = makeEffects()
    const dispatcher = configureRouteInbound(ports, effects)
    dispatcher(sessionMsg('session.exited', { code: 1, reason: 'boom\nline2' }))
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1)
    // payload 原样透传（含 sessionMsg 注入的 sessionId 字段）
    expect(effects.onSessionExited).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ code: 1, reason: 'boom\nline2' }),
    )
  })

  it('⑦ message.complete 条目：dispatchSession 后 onMessageComplete 回调', () => {
    const ports = makePorts()
    const effects = makeEffects()
    const dispatcher = configureRouteInbound(ports, effects)
    dispatcher(sessionMsg('message.complete', { stopReason: 'stop' }))
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1)
    expect(effects.onMessageComplete).toHaveBeenCalledWith('s1', { sessionId: 's1', stopReason: 'stop' })
  })

  it('⑦ session.subagents 条目：dispatchSession 后 onSubagents 回调（非数组跳过）', () => {
    const ports = makePorts()
    const effects = makeEffects()
    const dispatcher = configureRouteInbound(ports, effects)
    dispatcher(sessionMsg('session.subagents', { subagents: [{ id: 'sa-1', status: 'done' }] }))
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1)
    expect(effects.onSubagents).toHaveBeenCalledWith('s1', [{ id: 'sa-1', status: 'done' }])
    // 非数组 payload → 跳过回调
    dispatcher(sessionMsg('session.subagents', { subagents: 'not-array' }))
    expect(effects.onSubagents).toHaveBeenCalledTimes(1)
  })

  it('⑦ session.workflowUpdate 条目：dispatchSession 后 onWorkflowUpdate 回调', () => {
    const ports = makePorts()
    const effects = makeEffects()
    const dispatcher = configureRouteInbound(ports, effects)
    dispatcher(sessionMsg('session.workflowUpdate', { update: { status: 'running' } }))
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1)
    expect(effects.onWorkflowUpdate).toHaveBeenCalledWith('s1', { status: 'running' })
  })

  it('⑦ error 无 id 无 sid → onGlobalError 回调（fallback 分支）', () => {
    const ports = makePorts()
    const effects = makeEffects()
    const dispatcher = configureRouteInbound(ports, effects)
    dispatcher({ type: 'error', payload: { message: 'config load failed' } } as unknown as ServerMessage)
    expect(ports.events.dispatchGlobal).toHaveBeenCalledTimes(1)
    expect(effects.onGlobalError).toHaveBeenCalledWith('config load failed')
    // message 缺失 → 默认 'Unknown error'
    dispatcher({ type: 'error', payload: {} } as unknown as ServerMessage)
    expect(effects.onGlobalError).toHaveBeenLastCalledWith('Unknown error')
  })
})
