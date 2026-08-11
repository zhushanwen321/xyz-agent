/**
 * route-inbound.test.ts —— configureRouteInbound 行为等价断言（F8，TC-2）。
 *
 * 覆盖 IF4 处理顺序全路径：
 * ① msg.id + type==='error' → 委托 pending.resolveEnvelope（收到完整原始 error envelope，不直接 reject）+ 不进路由表
 * ② msg.id + 非 error → 委托 pending.resolveEnvelope（不直接 resolve）+ 不进路由表
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
      // 默认「命中 pending」对齐现有用例意图（①② 验证 pending 分流，msg.id 均为 RPC reply id）。
      // broadcast-id 走 dispatchGlobal 的场景在专门用例里 mockReturnValue(false)。
      has: vi.fn().mockReturnValue(true),
      // 委托契约 mock（收尾 6 R2/ES1）：route-inbound 不再做 envelope 展开，只透传原始 msg。
      // 展开细节（code 提取 + details.detail → Error）由 renderer api/__tests__/pending.test.ts 单测覆盖。
      resolveEnvelope: vi.fn(),
    },
    events: {
      dispatchSession: vi.fn(),
      dispatchGlobal: vi.fn(),
      dispatchCrossSession: vi.fn(),
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

  it('① error + msg.id：委托 pending.resolveEnvelope（完整原始 envelope 透传，不直接 reject）+ 不进路由表', () => {
    const ports = makePorts()
    const effects = makeEffects()
    const dispatcher = configureRouteInbound(ports, effects)

    // 默认值分支（message/code 兜底、details.detail 展开是 pending 层职责，renderer pending.test.ts 覆盖）
    dispatcher({
      type: 'error',
      id: 'req-1',
      payload: {},
    } as unknown as ServerMessage)
    expect(ports.pending.resolveEnvelope).toHaveBeenCalledTimes(1)
    expect(ports.pending.resolveEnvelope).toHaveBeenLastCalledWith({ type: 'error', id: 'req-1', payload: {} })
    // 委托后 route-inbound 不再直接 reject（展开逻辑在 pending 层）
    expect(ports.pending.reject).not.toHaveBeenCalled()
    // 不进路由表：无 sessionId 也不 dispatchGlobal（D7）
    expect(ports.events.dispatchGlobal).not.toHaveBeenCalled()
    expect(ports.events.dispatchSession).not.toHaveBeenCalled()

    // string detail → 原样透传
    dispatcher({
      type: 'error',
      id: 'req-2',
      payload: { code: 'WORKTREE_EXISTS', message: 'exists', details: { detail: '/path/cwd' } },
    } as unknown as ServerMessage)
    expect(ports.pending.resolveEnvelope).toHaveBeenLastCalledWith({
      type: 'error',
      id: 'req-2',
      payload: { code: 'WORKTREE_EXISTS', message: 'exists', details: { detail: '/path/cwd' } },
    })

    // object detail → 原样透传
    dispatcher({
      type: 'error',
      id: 'req-3',
      payload: { code: 'SETUP_FAILED', message: 'setup', details: { detail: { exitCode: 1, stderr: 'boom' } } },
    } as unknown as ServerMessage)
    expect(ports.pending.resolveEnvelope).toHaveBeenCalledTimes(3)
    expect(ports.pending.reject).not.toHaveBeenCalled()
  })

  it('② 非 error + msg.id：委托 pending.resolveEnvelope（不直接 resolve）+ 不进路由表', () => {
    const ports = makePorts()
    const dispatcher = configureRouteInbound(ports)
    dispatcher({
      type: 'session.getHistory',
      id: 'req-9',
      payload: { sessionId: 's1', messages: [] },
    } as unknown as ServerMessage)
    expect(ports.pending.resolveEnvelope).toHaveBeenCalledWith({
      type: 'session.getHistory',
      id: 'req-9',
      payload: { sessionId: 's1', messages: [] },
    })
    expect(ports.pending.resolve).not.toHaveBeenCalled()
    // D7：pending 分流后 return，不再进路由表（即使 payload 带 sessionId）
    expect(ports.events.dispatchSession).not.toHaveBeenCalled()
  })

  it('⑨ broadcast 带 id 但未命中 pending（如 config.skills 携带 nextPushId）：不进 pending 分流，无 sessionId → 走 dispatchGlobal（回归 2026-08 R5 问题 9）', () => {
    // 根因：runtime broadcast（config.skills/agents/...）都带 `id: nextPushId()`。
    // 旧实现 `if (msg.id)` 误吞，广播被 pending 静默丢弃，skills/agents store 永空。
    // 修复后：msg.id 未命中 pending → 继续路由 → FALLBACK → dispatchGlobal。
    const ports = makePorts({
      pending: {
        resolve: vi.fn(),
        reject: vi.fn(),
        rejectAll: vi.fn(),
        has: vi.fn().mockReturnValue(false), // 模拟 push_id 不在 pendingMap
        resolveEnvelope: vi.fn(),
      },
    })
    const dispatcher = configureRouteInbound(ports)
    dispatcher({ type: 'config.skills', id: 'push_5', payload: { skills: [] } } as unknown as ServerMessage)
    // 未进 pending 分流
    expect(ports.pending.resolve).not.toHaveBeenCalled()
    expect(ports.pending.resolveEnvelope).not.toHaveBeenCalled()
    // 无 sessionId → FALLBACK → dispatchGlobal（settings store 靠此更新）
    expect(ports.events.dispatchGlobal).toHaveBeenCalledTimes(1)
    expect(ports.events.dispatchGlobal).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'config.skills', id: 'push_5' }),
    )
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

describe('configureRouteInbound — crossSession 通道（ADR-0060）', () => {
  beforeEach(() => {
    resetSubscriptionStates()
  })

  it('⑩a 带 sid + CROSS_SESSION_TYPES type（extension:widget）→ dispatchSession + dispatchCrossSession', () => {
    const ports = makePorts()
    const dispatcher = configureRouteInbound(ports)
    dispatcher(sessionMsg('extension:widget', { widgetKey: 'w', lines: [] }))
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1)
    expect(ports.events.dispatchCrossSession).toHaveBeenCalledTimes(1)
    expect(ports.events.dispatchCrossSession).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'extension:widget' }),
    )
  })

  it('⑩b 带 sid + 非 CROSS_SESSION_TYPES type → 只 dispatchSession，不 dispatchCrossSession', () => {
    const ports = makePorts()
    const dispatcher = configureRouteInbound(ports)
    dispatcher(sessionMsg('config.providers', { providers: [] }))
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1)
    expect(ports.events.dispatchCrossSession).not.toHaveBeenCalled()
  })

  it('⑩c extension.ui_request（点号）命中白名单 → dispatchCrossSession', () => {
    // 点号是 runtime wire 实际格式（event-adapter.ts），ADR 文档冒号为笔误
    const ports = makePorts()
    const dispatcher = configureRouteInbound(ports)
    dispatcher(sessionMsg('extension.ui_request', { requestId: 'r', method: 'input' }))
    expect(ports.events.dispatchCrossSession).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'extension.ui_request' }),
    )
  })

  it('⑩d seq gap drop 的 CROSS_SESSION_TYPES 消息 → dispatchSession / dispatchCrossSession 均不调', async () => {
    const ports = makePorts()
    const dispatcher = configureRouteInbound(ports)
    ;(ports.subscribe as ReturnType<typeof vi.fn>).mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 10 })
    await subscribeSession('s1')
    // seq<=lastSeenSeq → applySeqGap drop，crossSession 也不发（防 ExtensionHost 重复处理）
    dispatcher(sessionMsg('extension:widget', { widgetKey: 'w', lines: [] }, { seq: 8 }))
    expect(ports.events.dispatchSession).not.toHaveBeenCalled()
    expect(ports.events.dispatchCrossSession).not.toHaveBeenCalled()
  })

  it('⑩e 无 sid 的 CROSS_SESSION_TYPES type → 走 dispatchGlobal，不 dispatchCrossSession', () => {
    // crossSession 只在有 sid 分支触发；无 sid 走 global 通道
    const ports = makePorts()
    const dispatcher = configureRouteInbound(ports)
    dispatcher({ type: 'extension:widget', payload: { widgetKey: 'w', lines: [] } } as unknown as ServerMessage)
    expect(ports.events.dispatchGlobal).toHaveBeenCalledTimes(1)
    expect(ports.events.dispatchCrossSession).not.toHaveBeenCalled()
  })

  it('⑩f 全量 CROSS_SESSION_TYPES 字面量逐项命中（防拼写回归）', () => {
    // 与 route-inbound.ts CROSS_SESSION_TYPES 集合字面量同步（集合未导出，逐项行为断言代替）。
    // 任一成员拼写漂移（如 extension.ui_request 误写成冒号）→ dispatchCrossSession 不再被调
    const literals = [
      'extension:widget',
      'extension:widgetGui',
      'extension:status',
      'extension:notify',
      'extension.ui_request',
      'extension.ui_timeout',
      'plugin:uiRequest',
      'plugin:viewUpdate',
    ]
    for (const type of literals) {
      const ports = makePorts()
      const dispatcher = configureRouteInbound(ports)
      dispatcher(sessionMsg(type, { requestId: 'r', method: 'input' }))
      expect(ports.events.dispatchCrossSession).toHaveBeenCalledWith(
        expect.objectContaining({ type }),
      )
    }
  })
})
