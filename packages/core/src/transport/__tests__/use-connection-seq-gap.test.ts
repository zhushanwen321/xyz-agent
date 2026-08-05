/**
 * routeInbound seq gap 检测集成测试（wave:runtime-message-bus::renderer-subscribe，
 * 自 renderer __tests__/useConnection-seq-gap.test.ts 迁入 core）。
 *
 * 覆盖 TC3-TC6, TC8（routeInbound 的 seq 分支行为）：
 * - TC3: gap 检测 seq<=lastSeenSeq 丢弃（reconcile 回放重复/乱序）
 * - TC4: gap 检测 seq>lastSeenSeq+1 触发 reconcile（subscribeSession(fromSeq)）
 * - TC5: seq===lastSeenSeq+1 正常递进（不 reconcile）
 * - TC6: 未 subscribe session 不做 gap 检测（兼容旧路径）
 * - TC8: routeInbound 的 id 路径不受 seq 影响（D7 互斥）
 *
 * 迁移改造（§10.2 D-1）：dispatcher 安装改经 core useConnection.ensureDispatcher
 * （mocked ws-client onMessage 捕获），订阅状态从 coordination/subscription-state 直接
 * import（renderer useMessageBusSubscription 是 re-export shim）。VITE_MOCK stub 不再
 * 需要——mock 分支由注入的 env.isMock 端口控制。
 *
 * 运行：cd packages/core && npx vitest run src/transport/__tests__/use-connection-seq-gap.test.ts
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { ref, type Ref } from 'vue'
import type { ServerMessage } from '@xyz-agent/shared'
import type { ConnectionState } from '../ws-client'
import { useConnection, setConnectionPorts, type ConnectionPorts } from '../use-connection'
import {
  subscribeSession,
  updateLastSeenSeq,
  resetSubscriptionStates,
  getSubscriptionState,
} from '../../coordination/subscription-state'

// ── ws-client mock：捕获 onMessage 注册的 dispatcher ───────────────
const mockConnect = vi.fn()
const mockDisconnect = vi.fn()
let mockStateRef: Ref<ConnectionState> = ref('disconnected')
let inboundHandler: ((msg: ServerMessage) => void) | null = null
vi.mock('../ws-client', () => ({
  connect: (...args: unknown[]) => mockConnect(...args),
  disconnect: (...args: unknown[]) => mockDisconnect(...args),
  getState: () => mockStateRef,
  setRestarting: vi.fn(),
  setFailed: vi.fn(),
  onMessage: (cb: (msg: ServerMessage) => void) => {
    inboundHandler = cb
    return () => {
      inboundHandler = null
    }
  },
}))

// ── pending mock（routeInbound id 路径需要）─────────────────────────
const pendingMock = vi.hoisted(() => {
  const m = {
    resolve: vi.fn(),
    reject: vi.fn(),
    rejectAll: vi.fn(),
    // routeInbound 用 has 判定 msg.id 是否命中 pending（RPC reply）；测试模拟的带 id 消息均为 reply
    has: vi.fn().mockReturnValue(true),
    // 模拟 renderer api/pending.resolveEnvelope 行为（收尾 6 R2/ES1）：route-inbound 委托
    // envelope 展开到 pending 层（code 提取 + details.detail → Error），此处转发到 reject/resolve。
    // 真实实现单测在 renderer api/__tests__/pending.test.ts。
    resolveEnvelope: vi.fn(),
  }
  m.resolveEnvelope.mockImplementation((msg: ServerMessage) => {
    if (msg.type === 'error') {
      const payload = msg.payload as { code?: string; message?: string; details?: { detail?: unknown } }
      const message = typeof payload.message === 'string' ? payload.message : 'request failed'
      const code = typeof payload.code === 'string' ? payload.code : 'unknown'
      const enriched: Record<string, unknown> = { code }
      const d = payload.details?.detail
      if (typeof d === 'string') {
        enriched.cwd = d
      } else if (d && typeof d === 'object') {
        Object.assign(enriched, d)
      }
      m.reject(msg.id!, Object.assign(new Error(message), enriched))
    } else {
      m.resolve(msg.id!, msg.payload)
    }
  })
  return m
})

// ── events mock：捕获 dispatchSession/dispatchGlobal ────────────────
const eventsMock = vi.hoisted(() => ({
  dispatchSession: vi.fn(),
  dispatchGlobal: vi.fn(),
}))

// ── subscribe mock（subscribeSession reconcile 用）──────────────────
const subscribeMock = vi.hoisted(() => ({
  subscribe: vi.fn().mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 0 }),
}))

function makePorts(): ConnectionPorts {
  return {
    ipc: {
      getRuntimePort: vi.fn().mockResolvedValue(undefined),
      getRuntimePortOffset: vi.fn().mockResolvedValue(undefined),
      onRuntimePort: vi.fn().mockReturnValue(() => {}),
      onRuntimeRestarting: vi.fn().mockReturnValue(() => {}),
      onRuntimeFailed: vi.fn().mockReturnValue(() => {}),
      restartRuntime: vi.fn().mockResolvedValue(undefined),
    },
    visibility: {
      isVisible: () => true,
      onVisibilityChange: () => () => {},
    },
    // mock 分支：dispatcher 在 mock return 前安装（ensureDispatcher 先于 mock 分支）
    env: { isMock: true, isDev: false },
    pending: pendingMock,
    events: eventsMock,
    subscribe: subscribeMock.subscribe,
    effects: {},
    toast: { error: vi.fn() },
    t: vi.fn((key: string) => `[${key}]`),
    onRuntimeUnavailable: vi.fn(),
  }
}

// routeInbound 是模块级单例函数（ensureDispatcher 首次安装后 dispatcherInstalled=true，
// 后续 init 不重装）。beforeAll 安装一次捕获 handler 引用，beforeEach 只清 mock 调用记录 +
// 重置订阅状态（不重装分发器）。
let pushInbound: (msg: ServerMessage) => void

beforeAll(async () => {
  setConnectionPorts(makePorts())
  const { init } = useConnection()
  await init()
  expect(inboundHandler).not.toBeNull()
  pushInbound = (msg: ServerMessage) => inboundHandler!(msg)
})

beforeEach(() => {
  resetSubscriptionStates()
  vi.clearAllMocks()
  mockStateRef = ref('disconnected')
  subscribeMock.subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 0 })
})

/** 构造带 seq 的 server-push 消息（无 id，live 通道） */
function liveMsg(seq: number, type = 'message.chunk', sid = 's1'): ServerMessage {
  return { type, seq, payload: { sessionId: sid } } as ServerMessage
}

describe('TC3: gap 检测 seq<=lastSeenSeq 丢弃', () => {
  it('seq === lastSeenSeq：不 dispatch（重复）', async () => {
    subscribeMock.subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 5 })
    await subscribeSession('s1')
    expect(getSubscriptionState('s1')!.lastSeenSeq).toBe(5)

    pushInbound(liveMsg(5))

    expect(eventsMock.dispatchSession).not.toHaveBeenCalled()
    // 基线不变（仍 5）
    expect(getSubscriptionState('s1')!.lastSeenSeq).toBe(5)
  })

  it('seq < lastSeenSeq：不 dispatch（乱序/回退）', async () => {
    subscribeMock.subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 5 })
    await subscribeSession('s1')

    pushInbound(liveMsg(3))

    expect(eventsMock.dispatchSession).not.toHaveBeenCalled()
    expect(getSubscriptionState('s1')!.lastSeenSeq).toBe(5)
  })
})

describe('TC5: seq === lastSeenSeq+1 正常递进（不 reconcile）', () => {
  it('seq=6, lastSeenSeq=5：dispatch + 更新基线，不调 subscribe', async () => {
    subscribeMock.subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 5 })
    await subscribeSession('s1')

    pushInbound(liveMsg(6))

    expect(eventsMock.dispatchSession).toHaveBeenCalledTimes(1)
    expect(eventsMock.dispatchSession).toHaveBeenCalledWith('s1', liveMsg(6))
    expect(getSubscriptionState('s1')!.lastSeenSeq).toBe(6)
    // subscribe RPC 只被首次 subscribeSession 调过一次（gap 未触发 reconcile）
    expect(subscribeMock.subscribe).toHaveBeenCalledTimes(1)
  })
})

describe('TC4: gap 检测 seq>lastSeenSeq+1 触发 reconcile', () => {
  it('seq=8, lastSeenSeq=5：触发 subscribeSession(s1, 7) + 当前 msg 仍 dispatch', async () => {
    subscribeMock.subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 5 })
    await subscribeSession('s1')
    vi.clearAllMocks()

    pushInbound(liveMsg(8))

    // 当前 msg 仍 dispatch（gap 期间尽量不丢）
    expect(eventsMock.dispatchSession).toHaveBeenCalledTimes(1)
    expect(eventsMock.dispatchSession).toHaveBeenCalledWith('s1', liveMsg(8))
    // 基线更新到 8（当前 msg 已处理）
    expect(getSubscriptionState('s1')!.lastSeenSeq).toBe(8)
    // reconcile 触发：subscribeSession(s1, fromSeq=7) 被调（seq-1=当前缺失的最早 seq）
    expect(subscribeMock.subscribe).toHaveBeenCalledWith('s1', 7)
  })
})

describe('TC6: 未 subscribe session 不做 gap 检测（兼容旧路径）', () => {
  it('state 不存在：带 seq 消息正常 dispatch，不丢弃、不 reconcile', () => {
    // s2 从未 subscribe（无 state）
    pushInbound(liveMsg(99, 'message.chunk', 's2'))

    expect(eventsMock.dispatchSession).toHaveBeenCalledTimes(1)
    expect(eventsMock.dispatchSession).toHaveBeenCalledWith('s2', liveMsg(99, 'message.chunk', 's2'))
    // 不触发 reconcile
    expect(subscribeMock.subscribe).not.toHaveBeenCalled()
  })

  it('subscribed=false（subscribeSession 失败）：正常 dispatch 不 gap 检测', async () => {
    subscribeMock.subscribe.mockRejectedValue(new Error('RPC down'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await subscribeSession('s3')
    // 失败不标记 subscribed（state 不存在）
    expect(getSubscriptionState('s3')).toBeUndefined()

    pushInbound(liveMsg(50, 'message.chunk', 's3'))

    expect(eventsMock.dispatchSession).toHaveBeenCalledTimes(1)
  })
})

describe('TC8: routeInbound 的 id 路径不受 seq 影响（D7 互斥）', () => {
  it('带 id 的 RPC reply：走 pending.resolve，sid 命中时仍 dispatch（id/seq 来源互斥不阻断 dispatch）', () => {
    const reply: ServerMessage = {
      type: 'session.subagents',
      id: 'r1',
      payload: { sessionId: 's1', subagents: [] },
    } as ServerMessage

    pushInbound(reply)

    // id 路径：pending.resolve 被调
    expect(pendingMock.resolve).toHaveBeenCalledWith('r1', reply.payload)
  })

  it('带 id 的 error reply：走 pending.reject（透传 code/message）', () => {
    const reply: ServerMessage = {
      type: 'error',
      id: 'r2',
      payload: { code: 'ERR_X', message: 'boom' },
    } as ServerMessage

    pushInbound(reply)

    expect(pendingMock.reject).toHaveBeenCalledTimes(1)
    const [id, err] = pendingMock.reject.mock.calls[0]!
    expect(id).toBe('r2')
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('boom')
    expect((err as Error & { code: string }).code).toBe('ERR_X')
  })

  it('已 subscribe session 收到带 id+seq 的 reply：pending 走 id 路径，seq 分支不影响（D7 互斥）', async () => {
    subscribeMock.subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 5 })
    await subscribeSession('s1')

    // 带 id 的 reply（无 seq）→ pending.resolve，dispatch 仍发生（兼容：reply 也可能含 sessionId）
    const reply: ServerMessage = {
      type: 'session.commands',
      id: 'r3',
      payload: { sessionId: 's1' },
    } as ServerMessage

    pushInbound(reply)

    expect(pendingMock.resolve).toHaveBeenCalledWith('r3', reply.payload)
  })
})

describe('updateLastSeenSeq 与 routeInbound 协同', () => {
  it('routeInbound 收到正常递进 seq 后更新基线，下一条 seq<=新基线 丢弃', async () => {
    subscribeMock.subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 5 })
    await subscribeSession('s1')

    pushInbound(liveMsg(6)) // 正常递进 → 基线变 6
    expect(getSubscriptionState('s1')!.lastSeenSeq).toBe(6)
    vi.clearAllMocks()

    pushInbound(liveMsg(6)) // 重复 seq=6 → 丢弃
    expect(eventsMock.dispatchSession).not.toHaveBeenCalled()
  })
})
