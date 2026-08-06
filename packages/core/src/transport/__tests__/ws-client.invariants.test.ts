// ws-client 不变量测试（D2：AC7 双交付之可执行骨架 → P1 已激活 ①⑤）。
//
// 激活范围（F4）：① 连接状态机 3 条 + ⑤ 重连退避 2 条为真实断言（fake 注入 + vi.useFakeTimers）。
// 保持 todo 范围（C4 deferred）：
//   ② auth 握手、③ close code 分流、④ seq 回放 —— 属后续迁移 wave（auth/seq/RTT 能力迁入 core 时激活）。
//   ⑤ visibilitychange 立即重连 —— 归 coordination/connection-lifecycle（架构文档 §5.2），
//      headless core 无 document，本 wave 不实现。
//
// 不变量定义修正（renderer-rebuild-architecture.md §5.1 / B.2-4）：
//   旧「本地模式逐字节不变」不可执行（测试无法锁定字节级）→
//   新「特征测试覆盖的关键行为不变」（5 类行为特征断言）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { providePlatform } from '../../platform/port'
import {
  connect,
  disconnect,
  getState,
  onMessage,
  setFailed,
  setRestarting,
  send,
} from '../ws-client'
import { configureRouteInbound, type TransportPorts } from '../../coordination/route-inbound'
import { subscribeSession, resetSubscriptionStates } from '../../coordination/subscription-state'
import { createFakeWebSocket, type FakeWebSocket } from './helpers/fake-websocket'

// ── 测试平台注入（fake websocket factory，每次 create 产出新 fake 并登记） ──
let fakes: FakeWebSocket[]

function installTestPlatform(): void {
  fakes = []
  providePlatform({
    kind: 'mock',
    storage: {
      get: async () => null,
      set: async () => {},
      remove: async () => {},
    },
    webSocket: {
      create: () => {
        const f = createFakeWebSocket()
        fakes.push(f)
        return f
      },
    },
    ipc: null,
  })
}

function latestFake(): FakeWebSocket {
  expect(fakes.length).toBeGreaterThan(0)
  return fakes[fakes.length - 1]
}

describe('ws-client 不变量 ① 连接状态机', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    installTestPlatform()
    disconnect() // 重置模块级单例状态（上轮残留连接/定时器）
  })
  afterEach(() => {
    disconnect()
    vi.useRealTimers()
  })

  it('合法迁移 connecting → open 可达（onopen 触发）', () => {
    connect('ws://test')
    expect(getState().value).toBe('connecting')
    latestFake().triggerOpen()
    expect(getState().value).toBe('connected')
  })

  it('合法迁移 open → closed 可达（主动 disconnect，残余回调被摘除）', () => {
    connect('ws://test')
    latestFake().triggerOpen()
    expect(getState().value).toBe('connected')

    disconnect()
    expect(getState().value).toBe('disconnected')
    // 主动断开摘回调：fake 的 onclose/onerror/onmessage 已置 null（onopen 原版不摘，gen 检查兜底），
    // 残余 trigger 不干扰新连接
    const f = latestFake()
    expect(f.onclose).toBeNull()
    expect(f.onerror).toBeNull()
    expect(f.onmessage).toBeNull()
    f.triggerOpen()
    expect(getState().value).toBe('disconnected')
  })

  it('非法迁移 open → connecting 被拒绝（connect 幂等 no-op，不重置状态）', () => {
    connect('ws://test')
    latestFake().triggerOpen()
    expect(getState().value).toBe('connected')
    expect(fakes.length).toBe(1)

    connect('ws://test-2') // 已连接，重复建连应被拒绝
    expect(fakes.length).toBe(1) // 未创建新 WS
    expect(getState().value).toBe('connected')
  })
})

describe('ws-client 不变量 ② auth 握手', () => {
  // [C4 deferred] auth 握手属后续迁移 wave（auth 能力迁入 core 时激活，本 wave 不转断言）
  it.todo('auth.ok 后触发 session 通道订阅 + flush pending 队列')
  it.todo('auth.reject 后触发降级（不进入消息处理，标记连接不可用）')
  it.todo('auth 消息在 open 前不发（连接就绪后才握手）')
})

describe('ws-client 不变量 ③ close code 分流', () => {
  // [C4 deferred] close code 分流属后续迁移 wave（close code 处理能力迁入 core 时激活）
  it.todo('1006（异常关闭）触发重连走退避序列')
  it.todo('4001（认证失效）不重连，标记需重新认证（壳降级 UI）')
  it.todo('4xxx（服务端正常关闭，如 4000/4003）不重连')
})

describe('ws-client 不变量 ④ seq 回放', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    installTestPlatform()
    disconnect()
    // 清订阅状态 Map（上轮用例残留 subscribed 标记会干扰 gap 判定，RK3）
    resetSubscriptionStates()
  })
  afterEach(() => {
    disconnect()
    vi.useRealTimers()
  })

  it('seq gap 检测后发起 reconcile 请求（拉取缺失区间）', async () => {
    // spyPorts：pending/events/subscribe 全 vi.fn()，subscribe 返回空 snapshot + lastSeq=10 预置基线
    const subscribeSpy = vi.fn(async () => ({ snapshot: [], stateSnapshot: [], lastSeq: 10 }))
    const spyPorts: TransportPorts = {
      pending: { resolve: vi.fn(), reject: vi.fn(), rejectAll: vi.fn() },
      events: { dispatchSession: vi.fn(), dispatchGlobal: vi.fn(), dispatchCrossSession: vi.fn() },
      subscribe: subscribeSpy,
    }
    // 注册 dispatcher（模拟 renderer ensureDispatcher 安装：onMessage(configureRouteInbound(ports))）
    onMessage(configureRouteInbound(spyPorts))

    connect('ws://test')
    latestFake().triggerOpen()

    // 预置 subscribed state：经真实 subscribeSession（spy reply lastSeq=10 → state={10, true}）
    await subscribeSession('s1')
    expect(subscribeSpy).toHaveBeenCalledWith('s1', undefined)

    // fake WS push seq=13 的 session 通道消息：s1 已 subscribed（lastSeenSeq=10），
    // 13 > 10+1 → gap，reconcileFromSeq = seq-1 = 12 → fire-and-forget subscribeSession(s1, 12)
    latestFake().triggerMessage(
      JSON.stringify({ type: 'message.chunk', seq: 13, payload: { sessionId: 's1' } }),
    )
    // flush subscribeSession 内部 await（fire-and-forget 微任务）
    await Promise.resolve()
    await Promise.resolve()

    expect(subscribeSpy).toHaveBeenCalledTimes(2)
    expect(subscribeSpy).toHaveBeenLastCalledWith('s1', 12)
  })

  it.todo('reconcile 响应 → seqReset → reload 会话历史（重载前静默窗口逻辑保留）')
  it.todo('presence 弱可靠通道不入 seq 桶（靠 auth.ok/presence.list 兜底）')
})

describe('ws-client 不变量 ⑤ 重连退避', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    installTestPlatform()
    disconnect()
  })
  afterEach(() => {
    disconnect()
    vi.useRealTimers()
  })

  it('指数退避序列符合 base/cap 参数（1s/2s/4s… capped 30s）', () => {
    connect('ws://test')
    latestFake().triggerOpen()

    // attempt 1：base 1s
    latestFake().triggerClose()
    expect(getState().value).toBe('reconnecting')
    vi.advanceTimersByTime(999)
    expect(fakes.length).toBe(1) // 未到 1s 不重连
    vi.advanceTimersByTime(1)
    expect(fakes.length).toBe(2) // 1s 到 → 重连（create 新 fake）

    // attempt 2：×2 = 2s
    latestFake().triggerClose()
    vi.advanceTimersByTime(1999)
    expect(fakes.length).toBe(2)
    vi.advanceTimersByTime(1)
    expect(fakes.length).toBe(3)

    // attempt 3：×2 = 4s
    latestFake().triggerClose()
    vi.advanceTimersByTime(4000)
    expect(fakes.length).toBe(4)

    // attempt 5：理论 16s；attempt 6：理论 32s → capped 30s
    latestFake().triggerClose() // attempt 4 → 8s
    vi.advanceTimersByTime(8000)
    expect(fakes.length).toBe(5)
    latestFake().triggerClose() // attempt 5 → 16s
    vi.advanceTimersByTime(16_000)
    expect(fakes.length).toBe(6)
    latestFake().triggerClose() // attempt 6 → min(32s, 30s) = 30s
    vi.advanceTimersByTime(29_999)
    expect(fakes.length).toBe(6) // 未到 30s 不重连（未 cap 则需 32s）
    vi.advanceTimersByTime(1)
    expect(fakes.length).toBe(7) // 30s 到 → cap 生效
  })

  it('连续重连失败达上限后停止重连（防无限重试）', () => {
    connect('ws://test')
    latestFake().triggerOpen()

    let guard = 0
    while (getState().value !== 'failed' && guard < 30) {
      latestFake().triggerClose()
      vi.advanceTimersByTime(30_000)
      guard++
    }
    expect(getState().value).toBe('failed')
    const lenAtFail = fakes.length

    // 已 failed：后续不再调度重连（无新 WS 创建）
    vi.advanceTimersByTime(30_000)
    expect(fakes.length).toBe(lenAtFail)
    expect(getState().value).toBe('failed')
  })

  it.todo('visibilitychange（页面可见）触发立即重连，并重置退避计数')
  // [C4 deferred] visibility 重连归 coordination/connection-lifecycle（架构文档 §5.2），
  // headless core 无 document，本 wave 不实现该行为。
})

describe('ws-client 辅助状态（restarting/failed IPC 驱动）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    installTestPlatform()
    disconnect()
  })
  afterEach(() => {
    disconnect()
    vi.useRealTimers()
  })

  it('setFailed 停止自动重连并置 failed', () => {
    connect('ws://test')
    latestFake().triggerOpen()
    latestFake().triggerClose() // 触发重连调度
    expect(getState().value).toBe('reconnecting')

    setFailed()
    expect(getState().value).toBe('failed')
    const lenAtFail = fakes.length
    vi.advanceTimersByTime(30_000)
    expect(fakes.length).toBe(lenAtFail) // 定时器已清，不再重连
  })

  it('setRestarting 断开当前连接并置 restarting', () => {
    connect('ws://test')
    latestFake().triggerOpen()
    setRestarting()
    expect(getState().value).toBe('restarting')
    expect(latestFake().closeCalls).toBe(1) // 当前 WS 被主动 close
    expect(getState().value).not.toBe('disconnected') // 不被重连逻辑覆盖
  })

  it('send 在 OPEN 时发送并返回 true，非 OPEN 返回 false', () => {
    connect('ws://test')
    expect(send({ type: 'ping', payload: {} })).toBe(false) // CONNECTING 不可发送
    latestFake().triggerOpen()
    expect(send({ type: 'ping', payload: {} })).toBe(true)
    expect(latestFake().sent).toHaveLength(1)
    expect(JSON.parse(latestFake().sent[0])).toEqual({ type: 'ping', payload: {} })
  })
})
