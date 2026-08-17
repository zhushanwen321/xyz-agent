/**
 * WS 重连后订阅恢复集成测试（M1 / W09 follow-up）。
 *
 * 根因链（四段缺一不可）：
 * 1. runtime：ws onDisconnect → bus.unsubscribeAll(ws) 清空该连接全部订阅
 * 2. core ws-client onopen 只置状态 + 心跳；use-connection 重连路径只重连不重订阅
 * 3. useChat.ensureStreamSubscription 的 streamSubscriptions.has 幂等守卫 + 本模块
 *    subscriptionStates.subscribed 标记，重连后全部短路 → subscribe 永不重发
 * 4. 唯一自愈通道（seq-gap 分支 5 reconcile）需要先收到一条带 seq 的跳号消息才触发——
 *    W09 删除 broadcast 兜底腿后无消息到达，自愈通道失效
 *
 * 修复：connected false→true 迁移时 use-connection 调 resubscribeAll()——
 * subscribed 条目重置后带 fromSeq=lastSeenSeq 增量重订（回放断线期间 ring 消息），
 * 新 bus（runtime 重启）基线收缩到新 seq 空间，断线期间失败的订阅意图（subscribed=false）重发。
 *
 * 覆盖：
 * - TC-R1: 重连触发增量重订阅（subscribe(sid, lastSeenSeq)）
 * - TC-R2: 断线期间 stream 消息经 snapshot 增量回放恢复，且无重复 dispatch
 * - TC-R3: state 类经 stateSnapshot 恢复（last-value 语义）
 * - TC-R4: 重连后 transient（无 seq）live 消息正常 dispatch（订阅已重建）
 * - TC-R5: 重连后 stream 递进消息正常 dispatch，旧 seq 仍被 drop（gap 检测恢复）
 * - TC-R6: 断线期间订阅失败的意图条目（subscribed=false）重连后重发（无 fromSeq）
 * - TC-R7: runtime 重启（新 bus，seqCounter 归零）基线收缩——后续 seq=1 消息不被 drop
 * - TC-R8: 无订阅条目时重连 no-op
 *
 * 运行：cd packages/core && npx vitest run src/transport/__tests__/use-connection-reconnect-resubscribe.test.ts
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { ref, nextTick, type Ref } from 'vue'
import type { ServerMessage } from '@xyz-agent/shared'
import type { ConnectionState } from '../ws-client'
import { useConnection, setConnectionPorts, type ConnectionPorts } from '../use-connection'
import {
  subscribeSession,
  resetSubscriptionStates,
  getSubscriptionState,
} from '../../coordination/subscription-state'

// ── ws-client mock：捕获 onMessage 注册的 dispatcher + 可控连接状态 ref ──
// mockStateRef 必须是单一 const 实例：use-connection 的 connected 迁移 watch 在 beforeAll
// init() 时捕获 getState() 返回的 ref，重新赋值变量会让 watch 失联（只允许 .value 变更）。
const mockStateRef = ref<ConnectionState>('disconnected')
let inboundHandler: ((msg: ServerMessage) => void) | null = null
vi.mock('../ws-client', () => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
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
const pendingMock = {
  resolve: vi.fn(),
  reject: vi.fn(),
  rejectAll: vi.fn(),
  has: vi.fn().mockReturnValue(false),
  resolveEnvelope: vi.fn(),
}

// ── events mock：捕获 dispatchSession（消息到达断言）────────────────
const eventsMock = {
  dispatchSession: vi.fn(),
  dispatchGlobal: vi.fn(),
  dispatchCrossSession: vi.fn(),
}

// ── subscribe mock：resubscribeAll / subscribeSession 的 RPC 出口 ────
const subscribeMock = {
  subscribe: vi.fn().mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 0 }),
}

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
  mockStateRef.value = 'connected'
  subscribeMock.subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 0 })
})

/** 模拟断开 → 重连（触发 use-connection 的 connected 迁移 watch → resubscribeAll） */
async function simulateReconnect(): Promise<void> {
  mockStateRef.value = 'disconnected'
  await nextTick()
  mockStateRef.value = 'connected'
  await nextTick()
}

/** 等 fire-and-forget 的 subscribeSession 完成（RPC mock resolve + snapshot 回放微任务） */
async function flushAsync(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

/** 构造带 seq 的 server-push 消息（无 id，live 通道） */
function liveMsg(seq: number, type = 'message.status', sid = 's1'): ServerMessage {
  return { type, seq, payload: { sessionId: sid } } as ServerMessage
}

describe('M1: WS 重连后订阅恢复', () => {
  it('TC-R1: 重连对 subscribed 条目发增量重订阅 subscribe(sid, lastSeenSeq)', async () => {
    // 断线前已订阅：基线 5
    subscribeMock.subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 5 })
    await subscribeSession('s1')
    expect(getSubscriptionState('s1')).toEqual({ lastSeenSeq: 5, subscribed: true })
    vi.clearAllMocks()

    await simulateReconnect()
    await flushAsync()

    // 重连 → 增量重订阅（fromSeq=5：回放断线期间 seq>5 的消息）
    expect(subscribeMock.subscribe).toHaveBeenCalledWith('s1', 5)
  })

  it('TC-R2: 断线期间 stream 消息经 snapshot 增量回放恢复，无重复 dispatch', async () => {
    subscribeMock.subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 5 })
    await subscribeSession('s1')
    vi.clearAllMocks()

    // 断线期间 runtime publish 了 seq 6/7（ring 内，live 推送不可达）
    subscribeMock.subscribe.mockResolvedValue({
      snapshot: [liveMsg(6), liveMsg(7)],
      stateSnapshot: [],
      lastSeq: 7,
    })
    await simulateReconnect()
    await flushAsync()

    // seq 6/7 各 dispatch 恰好一次（fromSeq=5 增量过滤，无重复）
    const seqs = eventsMock.dispatchSession.mock.calls
      .filter(([sid]) => sid === 's1')
      .map(([, msg]) => (msg as ServerMessage).seq)
    expect(seqs).toEqual([6, 7])
    // 基线收敛到 7（同一 bus，max 不回退）
    expect(getSubscriptionState('s1')).toEqual({ lastSeenSeq: 7, subscribed: true })
  })

  it('TC-R3: state 类经 stateSnapshot 恢复（last-value，不受 fromSeq 过滤）', async () => {
    subscribeMock.subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 5 })
    await subscribeSession('s1')
    vi.clearAllMocks()

    const contextUpdate = {
      type: 'context.update',
      seq: 4,
      payload: { sessionId: 's1', usedPercent: 60 },
    } as ServerMessage
    subscribeMock.subscribe.mockResolvedValue({
      snapshot: [],
      stateSnapshot: [contextUpdate],
      lastSeq: 5,
    })
    await simulateReconnect()
    await flushAsync()

    expect(eventsMock.dispatchSession).toHaveBeenCalledWith('s1', contextUpdate)
  })

  it('TC-R4: 重连后 transient（无 seq）live 消息正常 dispatch（订阅已重建）', async () => {
    subscribeMock.subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 5 })
    await subscribeSession('s1')

    subscribeMock.subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 5 })
    await simulateReconnect()
    await flushAsync()
    vi.clearAllMocks()

    // 重连后的 transient live 推送（text_delta 不占 seq）——恢复的关键验收点：
    // transient 不入 ring 不可回放，只有订阅重建后才能收到
    const delta = {
      type: 'message.text_delta',
      payload: { sessionId: 's1', delta: 'hi' },
    } as ServerMessage
    pushInbound(delta)

    expect(eventsMock.dispatchSession).toHaveBeenCalledTimes(1)
    expect(eventsMock.dispatchSession).toHaveBeenCalledWith('s1', delta)
  })

  it('TC-R5: 重连恢复后 stream 递进消息正常 dispatch，旧 seq 仍被 drop', async () => {
    subscribeMock.subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 5 })
    await subscribeSession('s1')

    subscribeMock.subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 5 })
    await simulateReconnect()
    await flushAsync()
    vi.clearAllMocks()

    // 递进 seq=6 → dispatch + 基线推进
    pushInbound(liveMsg(6))
    expect(eventsMock.dispatchSession).toHaveBeenCalledTimes(1)
    expect(getSubscriptionState('s1')!.lastSeenSeq).toBe(6)

    // 旧 seq=5（重放/乱序）→ drop（gap 检测随订阅恢复而恢复）
    pushInbound(liveMsg(5))
    expect(eventsMock.dispatchSession).toHaveBeenCalledTimes(1)
  })

  it('TC-R6: 断线期间订阅失败的意图条目重连后重发（无 fromSeq）', async () => {
    // 断线期间 subscribeSession 被调（如 useSessionStreamSync 对新增 session）→ RPC 失败
    // → intent 条目留存 subscribed=false（修复前条目不存在，重连恢复遍历不到）
    subscribeMock.subscribe.mockRejectedValue(new Error('ws closed'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await subscribeSession('s-new')
    expect(getSubscriptionState('s-new')).toEqual({ lastSeenSeq: 0, subscribed: false })
    vi.clearAllMocks()

    // 重连 → 意图重发（fromSeq=undefined 走正常订阅路径；subscribeImpl 显式透传 undefined）
    subscribeMock.subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 0 })
    await simulateReconnect()
    await flushAsync()

    expect(subscribeMock.subscribe).toHaveBeenCalledWith('s-new', undefined)
    expect(getSubscriptionState('s-new')).toEqual({ lastSeenSeq: 0, subscribed: true })
  })

  it('TC-R7: runtime 重启（新 bus seqCounter 归零）基线收缩，后续 seq=1 不被 drop', async () => {
    // 断线前基线 500（旧 bus）
    subscribeMock.subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 500 })
    await subscribeSession('s1')
    expect(getSubscriptionState('s1')!.lastSeenSeq).toBe(500)

    // runtime 重启 → 重连后 subscribe 到新 bus：空 ring，lastSeq=0
    subscribeMock.subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 0 })
    await simulateReconnect()
    await flushAsync()

    // 基线收缩到新 seq 空间原点（若保持 500，新消息 seq(1..) 会被 evalSeqGap 永久 drop）
    expect(getSubscriptionState('s1')).toEqual({ lastSeenSeq: 0, subscribed: true })

    // 新 bus 的首条消息 seq=1 → 正常递进 dispatch
    pushInbound(liveMsg(1))
    expect(eventsMock.dispatchSession).toHaveBeenCalledTimes(1)
    expect(eventsMock.dispatchSession).toHaveBeenCalledWith('s1', liveMsg(1))
    expect(getSubscriptionState('s1')!.lastSeenSeq).toBe(1)
  })

  it('TC-R8: 无订阅条目时重连 no-op（首次连接场景）', async () => {
    resetSubscriptionStates()

    await simulateReconnect()
    await flushAsync()

    expect(subscribeMock.subscribe).not.toHaveBeenCalled()
  })
})
