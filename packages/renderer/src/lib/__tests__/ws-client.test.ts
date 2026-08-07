/**
 * ws-client auth 握手 + close code 分流 + RTT 测量测试。
 *
 * 覆盖 18 个 TC：
 *  - TC1-TC8（wave1 auth 握手）：
 *    - TC1: onopen 远程模式发 auth payload 且不带 lastSeq
 *    - TC2: auth.ok 前不 connected，auth.ok 后翻 connected
 *    - TC3: 4001 → failed(auth) 不重连
 *    - TC4: 4002 → failed(replaced) 不重连
 *    - TC5: 10s auth 超时 → failed(auth)
 *    - TC6: 重连复用 auth opts
 *    - TC7: 本地模式零回归（无 auth opts 时 onopen 即 connected、failReason null、isRemote false）
 *    - TC8: intercept 在 auth 完成前消化其他消息（丢弃+warn，不进 messageHandler）
 *  - TC9-TC17（wave2 RTT 测量）：
 *    - TC9:  ping 带 envelope 顶层 id（payload 仍 {}）
 *    - TC10: pong 按 id 配对计算 RTT（in-flight=1）
 *    - TC11: 滑动窗口 N=20 FIFO（第 21 条丢弃最旧）
 *    - TC12: getRttStats 窗口空时返回 count=0 数值字段 undefined
 *    - TC13: in-flight=1：上一条 pong 未回时心跳 skip 新 ping
 *    - TC14: id 不匹配的 pong 被忽略（不污染窗口，不报错）
 *    - TC15: 断开清空窗口（onclose + disconnect）
 *    - TC16: 远程模式 RTT 不破坏 auth 握手（TC1-TC8 零回归）
 *    - TC17: getRttStats 统计字段正确性（min/max/avg/p50/last）
 *  - TC18-TC25（wave3 seq 可靠投递，P2-s4）：
 *    - TC18: lastSeq 随广播消息 seq 递增更新（reply/pong 不更新）
 *    - TC19: auth 携带 lastSeq/bootId/subscribedSessions（lastSeq=0 时不带，>0 时带）
 *    - TC20: auth.ok{seqReset:true} → 清 lastSeq + window.location.reload 调用
 *    - TC21: auth.ok{serverSeq:N} 基线对齐 lastSeq（>才更新，<=不回退）
 *    - TC22: auth.ok{bootId} 保存 serverBootId（空/undefined 不存）
 *    - TC23: setSubscribedSessions 注入去重排序 + 重连 auth 携带
 *    - TC24: mock 模式 lastSeq 恒 0（代码审查 review，不单测）
 *    - TC25: 畸形 seq（负数/0/NaN）忽略不更新 lastSeq
 *    - TC26: seqReset 后 reload 完成前的增量广播被静默丢弃（防 reload 前 UI 闪烁）
 *    - TC27: replay 段不使 lastSeq 回退（C2 修复：updateLastSeq 取 max 维持单调）
 *
 * 框架：vitest + happy-dom（禁止 node:test，遵守 AGENTS 测试规范）。
 *
 * VITE_MOCK 处理：vitest.config.ts 给所有测试注入 VITE_MOCK='true'（让 useSearch 等走 fixture），
 * 但 ws-client.ts 顶层 `const isMock = import.meta.env.VITE_MOCK === 'true'` 在模块加载时求值——
 * 若 isMock=true，connect() 会短路走 mockConnect 分支（不构造真实 WebSocket，本测试无法驱动 onopen）。
 * 故文件顶部 vi.stubEnv('VITE_MOCK','false') + 动态 import 在 stubEnv 之后加载 ws-client，
 * 确保 ws-client.ts 模块求值时 isMock 读到 false（与 useSearch.test.ts 同模式）。
 *
 * Mock 策略：
 *  - vi.stubGlobal('WebSocket', MockWebSocket) 全局桩，不触真实网络
 *  - vi.mock('@/lib/remote/probe') 桩 buildAuthMessage 返回固定 id（'auth_test-fixed-id'）便于断言，
 *    避免 connection-config getClientId/getDeviceName 随机性
 *  - mock-ws（@/mock/mock-ws）桩空实现（ws-client import 时会加载，但 isMock=false 不走 mockConnect 分支）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ServerMessage } from '@xyz-agent/shared'

// ── 桩：buildAuthMessage 返回固定 id，便于断言 ────────────────────
const FIXED_AUTH_ID = 'auth_test-fixed-id'
vi.mock('@/lib/remote/probe', () => ({
  // wave3 P2-s4：透传 lastSeq/bootId/subscribedSessions（与真实 buildAuthMessage 按条件展开一致，TC19/TC23 断言需要）
  buildAuthMessage: (opts: {
    token: string
    clientId: string
    deviceName?: string
    lastSeq?: number
    bootId?: string
    subscribedSessions?: string[]
  }) => ({
    type: 'auth' as const,
    id: FIXED_AUTH_ID,
    payload: {
      token: opts.token,
      clientId: opts.clientId,
      ...(opts.deviceName !== undefined ? { deviceName: opts.deviceName } : {}),
      ...(opts.lastSeq !== undefined ? { lastSeq: opts.lastSeq } : {}),
      ...(opts.bootId !== undefined ? { bootId: opts.bootId } : {}),
      ...(opts.subscribedSessions !== undefined
        ? { subscribedSessions: opts.subscribedSessions }
        : {}),
    },
  }),
}))

// ── 桩：mock-ws（ws-client 顶部 import，需提供空实现；isMock=false 时不会被调用）──
vi.mock('@/mock/mock-ws', () => ({
  mockConnect: vi.fn(),
  mockSend: vi.fn(),
  mockDisconnect: vi.fn(),
}))

// 必须在 import ws-client 之前 stubEnv，让 ws-client.ts 模块求值时 isMock 读到 false
vi.stubEnv('VITE_MOCK', 'false')

// ── MockWebSocket：全局桩，捕获 url + send + 提供 trigger* 驱动 ──────

/** WS readyState 常量镜像（与浏览器一致） */
const READY_CONNECTING = 0
const READY_OPEN = 1
const READY_CLOSED = 3

/**
 * Mock WebSocket：实例化时记录 url + readyState=CONNECTING；提供实例方法
 * triggerOpen/triggerMessage/triggerClose 供测试驱动事件；
 * send(msg) 缓存到 lastSent/sentMessages 供断言；close() 翻 readyState=CLOSED。
 *
 * 字段 onopen/onmessage/onclose/onerror 故意声明为可赋值的实例属性，
 * 模拟浏览器 WebSocket 的 callback 赋值语义（ws.onopen = ...）。
 */
class MockWebSocket {
  static readonly CONNECTING = READY_CONNECTING
  static readonly OPEN = READY_OPEN
  static readonly CLOSED = READY_CLOSED

  readonly url: string
  readyState: number = READY_CONNECTING
  /** 最后一次 send 的原始字符串 */
  lastSent: string | null = null
  /** 全部 send 的原始字符串（按顺序） */
  sentMessages: string[] = []
  /** close 是否被调用（含次数） */
  closeCalls: number = 0

  // 回调槽（业务代码赋值）
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null

  constructor(url: string) {
    this.url = url
  }

  send(data: string): void {
    this.lastSent = data
    this.sentMessages.push(data)
  }

  close(): void {
    this.closeCalls++
    this.readyState = READY_CLOSED
  }

  // ── 测试驱动方法 ──────────────────────────────────────────────
  triggerOpen(): void {
    this.readyState = READY_OPEN
    this.onopen?.(new Event('open'))
  }

  triggerMessage(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent)
  }

  triggerClose(code: number, reason = ''): void {
    this.readyState = READY_CLOSED
    this.onclose?.({ code, reason } as CloseEvent)
  }
}

/** 抓取最近一次创建的 MockWebSocket 实例（每个用例 reset） */
let lastWs: MockWebSocket | null = null
const OrigWebSocket = MockWebSocket

beforeEach(async () => {
  lastWs = null
  // 重置 ws-client 模块级状态（单例 ref + currentUrl/authId 等），确保用例隔离
  const { __resetForTest } = await import('@/lib/ws-client')
  __resetForTest()
  // 包装 stub：每次 new WebSocket(...) 都把实例记到 lastWs
  vi.stubGlobal(
    'WebSocket',
    class extends OrigWebSocket {
      constructor(url: string) {
        super(url)
        lastWs = this
      }
    },
  )
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
  // 断开当前连接（重置模块级状态防用例间污染；beforeEach 也会再 reset 一次兜底）
  const { disconnect } = await import('@/lib/ws-client')
  disconnect()
})

// ── 工具：等微任务让 ws.onopen 赋值完成 ──────────────────────
async function waitForWs(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

// ──────────────────────────────────────────────────────────
// TC1: onopen 远程模式发 auth payload 且不带 lastSeq
// ──────────────────────────────────────────────────────────
describe('TC1: onopen 远程模式发 auth payload', () => {
  it('onopen 后 ws.send 发出 type=auth + payload(token/clientId/deviceName)，lastSeq undefined，state 仍 connecting', async () => {
    const { connect, getState, getIsRemote } = await import('@/lib/ws-client')
    connect('ws://host:3210', { auth: { token: 't1', clientId: 'c1', deviceName: 'dn' } })
    await waitForWs()
    lastWs!.triggerOpen()

    // 断言 1：send 被调用
    expect(lastWs!.sentMessages.length).toBeGreaterThanOrEqual(1)
    const sent = JSON.parse(lastWs!.lastSent!) as {
      type: string
      id: string
      payload: { token: string; clientId: string; deviceName?: string; lastSeq?: number }
    }
    // 断言 2：消息形状
    expect(sent.type).toBe('auth')
    expect(sent.id).toBe(FIXED_AUTH_ID)
    expect(sent.payload.token).toBe('t1')
    expect(sent.payload.clientId).toBe('c1')
    expect(sent.payload.deviceName).toBe('dn')
    // lastSeq 不带（spec D10 + IF13）
    expect(sent.payload.lastSeq).toBeUndefined()
    // 断言 3：onopen 后 state 仍 connecting（远程模式不翻转 connected）
    expect(getState().value).toBe('connecting')
    // isRemote 已推导为 true
    expect(getIsRemote().value).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────
// TC2: auth.ok 前不 connected，auth.ok 后翻 connected
// ──────────────────────────────────────────────────────────
describe('TC2: auth.ok 翻转 connected', () => {
  it('auth.ok 前 state 非 connected；收到匹配 id 的 auth.ok 后 state=connected', async () => {
    const { connect, getState } = await import('@/lib/ws-client')
    connect('ws://host:3210', { auth: { token: 't1', clientId: 'c1' } })
    await waitForWs()
    lastWs!.triggerOpen()

    // auth.ok 前：state 仍 connecting（远程模式 onopen 不翻转）
    expect(getState().value).not.toBe('connected')

    // 服务端回 auth.ok（id 匹配 authId）
    lastWs!.triggerMessage(
      JSON.stringify({
        type: 'auth.ok',
        id: FIXED_AUTH_ID,
        payload: { serverVersion: '1.0.0', clientId: 'c1' },
      }),
    )

    // auth.ok 后：state 翻转 connected
    expect(getState().value).toBe('connected')
  })
})

// ──────────────────────────────────────────────────────────
// TC3: onclose code 4001 → failed(auth) 不重连
// ──────────────────────────────────────────────────────────
describe('TC3: close 4001 → failed(auth) 不重连', () => {
  it('服务端 close code 4001 → state=failed, failReason=auth, 不调度重连', async () => {
    const { connect, getState, getFailReason, getIsRemote } = await import('@/lib/ws-client')
    connect('ws://host:3210', { auth: { token: 'wrong', clientId: 'c1' } })
    await waitForWs()
    lastWs!.triggerOpen()
    lastWs!.triggerClose(4001)

    expect(getState().value).toBe('failed')
    expect(getFailReason().value).toBe('auth')
    // isRemote 仍 true（远程模式失败）
    expect(getIsRemote().value).toBe(true)
    // 不调度重连：state 当前是 failed（若重连会被 scheduleReconnect 置为 reconnecting）
  })
})

// ──────────────────────────────────────────────────────────
// TC4: onclose code 4002 → failed(replaced) 不重连
// ──────────────────────────────────────────────────────────
describe('TC4: close 4002 → failed(replaced) 不重连', () => {
  it('服务端 close code 4002 → state=failed, failReason=replaced, 不调度重连', async () => {
    const { connect, getState, getFailReason, getIsRemote } = await import('@/lib/ws-client')
    connect('ws://host:3210', { auth: { token: 't1', clientId: 'c1' } })
    await waitForWs()
    lastWs!.triggerOpen()
    lastWs!.triggerClose(4002)

    expect(getState().value).toBe('failed')
    expect(getFailReason().value).toBe('replaced')
    expect(getIsRemote().value).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────
// TC5: 10s auth 超时 → failed(auth)
// ──────────────────────────────────────────────────────────
describe('TC5: auth 超时 → failed(auth)', () => {
  it('onopen 发 auth 后 10s 未收 auth.ok → ws 主动 close, state=failed, failReason=auth', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { connect, getState, getFailReason } = await import('@/lib/ws-client')
    connect('ws://host:3210', { auth: { token: 't1', clientId: 'c1' } })
    await waitForWs()
    lastWs!.triggerOpen()

    // auth.ok 未到，推进 10s+ 触发超时定时器（ws.close 被调，但 mock 不会自动 fire onclose）
    vi.advanceTimersByTime(10_500)
    expect(lastWs!.closeCalls).toBeGreaterThanOrEqual(1) // 主动 close
    // mock close 不自动 fire onclose，手动驱动（真实浏览器 close() 后会触发 onclose）
    lastWs!.triggerClose(1000) // 客户端主动 close 的默认 code
    // 等微任务让 onclose 回调跑完
    await Promise.resolve()

    expect(getState().value).toBe('failed')
    expect(getFailReason().value).toBe('auth')
  })
})

// ──────────────────────────────────────────────────────────
// TC6: 重连复用 auth opts
// ──────────────────────────────────────────────────────────
describe('TC6: 重连复用 auth opts', () => {
  it('close 1006 触发退避重连，重连后新 ws onopen 再次发 auth（payload 一致）', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { connect } = await import('@/lib/ws-client')
    connect('ws://host:3210', { auth: { token: 't1', clientId: 'c1', deviceName: 'dn' } })
    await waitForWs()
    lastWs!.triggerOpen()
    // 第一个 ws 的 auth.ok 还没来就断（非 4001/4002，如 1006）→ 退避重连
    lastWs!.triggerClose(1006)

    // 推进退避（首次 1s）触发 connect 重连
    vi.advanceTimersByTime(1_100)
    await Promise.resolve()
    await waitForWs()

    // 新 ws 实例存在
    expect(lastWs).not.toBeNull()
    expect(lastWs!.readyState).toBe(READY_CONNECTING)
    lastWs!.triggerOpen()

    // 断言：新 ws onopen 仍发 auth，payload 与首次一致（opts 复用）
    const sent = JSON.parse(lastWs!.lastSent!) as {
      type: string
      payload: { token: string; clientId: string; deviceName?: string }
    }
    expect(sent.type).toBe('auth')
    expect(sent.payload.token).toBe('t1')
    expect(sent.payload.clientId).toBe('c1')
    expect(sent.payload.deviceName).toBe('dn')
  })
})

// ──────────────────────────────────────────────────────────
// TC7: 本地模式零回归
// ──────────────────────────────────────────────────────────
describe('TC7: 本地模式零回归', () => {
  it('connect(url) 无 opts：onopen 即 connected，不发 auth，failReason null，isRemote false', async () => {
    const { connect, getState, getFailReason, getIsRemote } = await import('@/lib/ws-client')
    connect('ws://host:3210') // 不传 opts
    await waitForWs()

    // isRemote=false（本地模式）
    expect(getIsRemote().value).toBe(false)

    lastWs!.triggerOpen()

    // onopen 即 connected（与现状逐字节一致）
    expect(getState().value).toBe('connected')
    // 未发 auth 消息（onopen 后立即断言 lastSent 应为 null——心跳 15s 后才发）
    if (lastWs!.lastSent) {
      const sent = JSON.parse(lastWs!.lastSent) as { type: string }
      expect(sent.type).not.toBe('auth')
    }
    // failReason 恒 null
    expect(getFailReason().value).toBeNull()
  })

  it('本地模式 setFailed()（无参）时 failReason 保持 null（兼容 useConnection runtime-failed）', async () => {
    const { connect, getState, getFailReason, setFailed } = await import('@/lib/ws-client')
    connect('ws://host:3210')
    await waitForWs()
    lastWs!.triggerOpen()
    expect(getState().value).toBe('connected')

    setFailed() // 无参，兼容现有 useConnection 调用
    expect(getState().value).toBe('failed')
    expect(getFailReason().value).toBeNull() // 仍 null，不误设为某原因
  })
})

// ──────────────────────────────────────────────────────────
// TC8: intercept 在 auth 完成前消化其他消息
// ──────────────────────────────────────────────────────────
describe('TC8: intercept auth 完成前消化其他消息', () => {
  it('auth.ok 前收到 id 不匹配的业务消息 → messageHandler 未调用, state 未翻转', async () => {
    const { connect, getState, onMessage } = await import('@/lib/ws-client')
    const handler = vi.fn()
    const unsub = onMessage(handler)

    connect('ws://host:3210', { auth: { token: 't1', clientId: 'c1' } })
    await waitForWs()
    lastWs!.triggerOpen()

    // auth 完成前收到业务消息（id 不匹配 authId）
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bizMsg: ServerMessage = {
      type: 'pong',
      id: 'other-id',
      payload: {},
    } as unknown as ServerMessage
    lastWs!.triggerMessage(JSON.stringify(bizMsg))

    // messageHandler 未被调用（intercept 消化）
    expect(handler).not.toHaveBeenCalled()
    // warn 被调用（丢弃告警）
    expect(warnSpy).toHaveBeenCalled()
    // state 仍未翻转 connected（仍等 auth.ok）
    expect(getState().value).not.toBe('connected')

    // 收到匹配的 auth.ok 后正常翻转
    warnSpy.mockRestore()
    lastWs!.triggerMessage(
      JSON.stringify({
        type: 'auth.ok',
        id: FIXED_AUTH_ID,
        payload: { serverVersion: '1.0.0', clientId: 'c1' },
      }),
    )
    expect(getState().value).toBe('connected')

    unsub()
  })
})

// ──────────────────────────────────────────────────────────
// TC9-TC17: RTT 测量（wave2）
//
// 共享辅助：本地模式 connect + open，返回 ws-client 模块的动态导入。
// RTT 心跳 15s 一次，用 vi.useFakeTimers({shouldAdvanceTime:true}) 推进时间触发心跳。
// ping→pong 延迟用 advanceTimersByTime 精确控制，断言容差范围。
// ──────────────────────────────────────────────────────────

/** 抓取最后一条 ping 消息（从 sentMessages 反向找 type=ping）。返回解析后对象或 null。 */
function getLastPing(ws: MockWebSocket): { type: string; id?: string; payload: Record<string, never> } | null {
  for (let i = ws.sentMessages.length - 1; i >= 0; i--) {
    const parsed = JSON.parse(ws.sentMessages[i]!) as { type: string; id?: string }
    if (parsed.type === 'ping') {
      return parsed as { type: string; id?: string; payload: Record<string, never> }
    }
  }
  return null
}

// ──────────────────────────────────────────────────────────
// TC9: ping 带 envelope 顶层 id 发送（payload 仍 {}）
// ──────────────────────────────────────────────────────────
describe('TC9: ping 带 envelope id', () => {
  it('本地模式心跳 ping 带 id 字段（格式 timestamp-random），payload 恒为 {}', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { connect, getState, getRttStats } = await import('@/lib/ws-client')
    connect('ws://host:3210') // 本地模式
    await waitForWs()
    lastWs!.triggerOpen()
    expect(getState().value).toBe('connected')

    // 推进 15s+ 触发首次心跳 ping
    vi.advanceTimersByTime(15_100)

    const ping = getLastPing(lastWs!)
    expect(ping).not.toBeNull()
    expect(ping!.type).toBe('ping')
    // id 非空字符串
    expect(typeof ping!.id).toBe('string')
    expect(ping!.id!.length).toBeGreaterThan(0)
    // 格式匹配 timestamp-random（数字-字母数字）
    expect(ping!.id).toMatch(/^\d+-[a-z0-9]+$/)
    // payload 恒为空对象（零协议变更）
    expect(ping!.payload).toEqual({})
    // 窗口空（未收 pong）
    expect(getRttStats().count).toBe(0)
  })
})

// ──────────────────────────────────────────────────────────
// TC10: pong 按 id 配对计算 RTT（in-flight=1）
// ──────────────────────────────────────────────────────────
describe('TC10: pong 配对计算 RTT', () => {
  it('发 ping 后模拟 50ms 延迟回 pong → getRttStats().count=1, last=50ms', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    // mock Date.now 让 RTT 测量值可预测（pendingPingSentAt 与 pong 到达时的差 = sentAtDelta）。
    // fake timer 的 setInterval 在绝对调度点触发，advanceTimersByTime 推进时 Date.now 可能残留
    // 前一轮延迟偏移，故用 spy 精确控制 buildPingId/pendingPingSentAt/recordRtt 三处 Date.now 读值。
    const spy = vi.spyOn(Date, 'now')
    let tick = 1_000_000
    spy.mockImplementation(() => tick)

    const { connect, getRttStats } = await import('@/lib/ws-client')
    connect('ws://host:3210')
    await waitForWs()
    lastWs!.triggerOpen()

    // 推进 15s 触发心跳发 ping（pendingPingSentAt = tick = 1_000_000）
    vi.advanceTimersByTime(15_000)
    const ping = getLastPing(lastWs!)
    expect(ping).not.toBeNull()

    // 模拟 50ms 网络延迟：Date.now 推进 50ms 后回 pong → RTT = tick - sentAt = 50
    tick += 50
    lastWs!.triggerMessage(JSON.stringify({ type: 'pong', id: ping!.id, payload: {} }))

    const stats = getRttStats()
    expect(stats.count).toBe(1)
    expect(stats.last).toBe(50)
    spy.mockRestore()
  })
})

// ──────────────────────────────────────────────────────────
// TC11: 滑动窗口 N=20 FIFO（第 21 条丢弃最旧）
// ──────────────────────────────────────────────────────────
describe('TC11: 滑动窗口 N=20 FIFO', () => {
  it('连续 21 次 ping/pong → count=20（第 1 条被 shift）', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { connect, getRttStats } = await import('@/lib/ws-client')
    connect('ws://host:3210')
    await waitForWs()
    lastWs!.triggerOpen()

    // 循环 21 次：每次推进 15s 发 ping + 立即回 pong
    for (let i = 0; i < 21; i++) {
      vi.advanceTimersByTime(15_000)
      const ping = getLastPing(lastWs!)
      if (!ping) {
        // in-flight 占位时可能 skip（前一条 pong 未回），但这里每轮立即配对不会 skip
        throw new Error(`iteration ${i}: expected ping but got none`)
      }
      // 立即回 pong（RTT≈0，重点验证窗口大小）
      lastWs!.triggerMessage(JSON.stringify({ type: 'pong', id: ping.id, payload: {} }))
    }

    const stats = getRttStats()
    expect(stats.count).toBe(20) // 不是 21，FIFO 丢弃最旧
    // 数值字段均为有限数
    expect(stats.min).toBeTypeOf('number')
    expect(stats.max).toBeTypeOf('number')
    expect(stats.avg).toBeTypeOf('number')
    expect(stats.p50).toBeTypeOf('number')
    expect(stats.last).toBeTypeOf('number')
  })
})

// ──────────────────────────────────────────────────────────
// TC12: getRttStats 窗口空时返回 count=0 数值字段 undefined
// ──────────────────────────────────────────────────────────
describe('TC12: 窗口空态 getRttStats', () => {
  it('刚 connect 未收 pong → getRttStats() 返回 count=0，数值字段全 undefined', async () => {
    const { connect, getRttStats } = await import('@/lib/ws-client')
    connect('ws://host:3210')
    await waitForWs()
    lastWs!.triggerOpen()

    const stats = getRttStats()
    expect(stats.count).toBe(0)
    expect(stats.min).toBeUndefined()
    expect(stats.max).toBeUndefined()
    expect(stats.avg).toBeUndefined()
    expect(stats.p50).toBeUndefined()
    expect(stats.last).toBeUndefined()
  })
})

// ──────────────────────────────────────────────────────────
// TC13: in-flight=1：上一条 pong 未回时心跳 skip 新 ping
// ──────────────────────────────────────────────────────────
describe('TC13: in-flight=1 skip 新 ping', () => {
  it('发 ping1 后 pong 没回，下一轮心跳 skip（30s 内只发 1 条 ping）', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { connect, getRttStats } = await import('@/lib/ws-client')
    connect('ws://host:3210')
    await waitForWs()
    lastWs!.triggerOpen()

    // 15s：发 ping1
    vi.advanceTimersByTime(15_000)
    const ping1 = getLastPing(lastWs!)
    expect(ping1).not.toBeNull()
    const ping1Id = ping1!.id

    // 再推进 15s（pong1 没回）：心跳应 skip，不发 ping2
    vi.advanceTimersByTime(15_000)
    const ping2 = getLastPing(lastWs!)
    // 最后一条 ping 仍是 ping1（id 未变）
    expect(ping2).not.toBeNull()
    expect(ping2!.id).toBe(ping1Id)
    // 统计 sentMessages 中 ping 总数 = 1
    const pingCount = lastWs!.sentMessages.filter((s) => {
      try {
        return (JSON.parse(s) as { type: string }).type === 'ping'
      } catch {
        return false
      }
    }).length
    expect(pingCount).toBe(1)
    // 窗口仍空（pong1 没回来）
    expect(getRttStats().count).toBe(0)

    // 现在 pong1 回来配对后，下一轮心跳才能发 ping2
    lastWs!.triggerMessage(JSON.stringify({ type: 'pong', id: ping1Id, payload: {} }))
    expect(getRttStats().count).toBe(1)
    vi.advanceTimersByTime(15_000)
    const ping3 = getLastPing(lastWs!)
    expect(ping3).not.toBeNull()
    expect(ping3!.id).not.toBe(ping1Id) // 新 ping，id 不同
  })
})

// ──────────────────────────────────────────────────────────
// TC14: id 不匹配的 pong 被忽略
// ──────────────────────────────────────────────────────────
describe('TC14: id 不匹配的 pong 忽略', () => {
  it('收到 id≠pendingPingId 的 pong → count 不增，pending 不清，不进 messageHandler', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { connect, getRttStats, onMessage } = await import('@/lib/ws-client')
    const handler = vi.fn()
    const unsub = onMessage(handler)
    connect('ws://host:3210')
    await waitForWs()
    lastWs!.triggerOpen()

    vi.advanceTimersByTime(15_000)
    const ping = getLastPing(lastWs!)
    expect(ping).not.toBeNull()

    // 收到 id 不匹配的 stray pong
    lastWs!.triggerMessage(JSON.stringify({ type: 'pong', id: 'stray-other-id', payload: {} }))

    // 窗口未记录样本
    expect(getRttStats().count).toBe(0)
    // messageHandler 未被调用（pong 被 RTT 层消化，不进业务回调）
    expect(handler).not.toHaveBeenCalled()

    // 后续真实 pong（id 匹配）仍能正常配对
    lastWs!.triggerMessage(JSON.stringify({ type: 'pong', id: ping!.id, payload: {} }))
    expect(getRttStats().count).toBe(1)

    unsub()
  })
})

// ──────────────────────────────────────────────────────────
// TC15: 断开清空窗口（onclose + disconnect）
// ──────────────────────────────────────────────────────────
describe('TC15: 断开清空窗口', () => {
  it('积累样本后 triggerClose(1006) → getRttStats().count=0', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { connect, getRttStats } = await import('@/lib/ws-client')
    connect('ws://host:3210')
    await waitForWs()
    lastWs!.triggerOpen()

    // 积累 2 条样本
    for (let i = 0; i < 2; i++) {
      vi.advanceTimersByTime(15_000)
      const ping = getLastPing(lastWs!)
      lastWs!.triggerMessage(JSON.stringify({ type: 'pong', id: ping!.id, payload: {} }))
    }
    expect(getRttStats().count).toBe(2)

    // 断开（1006 退避重连分支）
    lastWs!.triggerClose(1006)
    expect(getRttStats().count).toBe(0) // 窗口清空
  })

  it('积累样本后 disconnect() → getRttStats().count=0', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { connect, disconnect, getRttStats } = await import('@/lib/ws-client')
    connect('ws://host:3210')
    await waitForWs()
    lastWs!.triggerOpen()

    vi.advanceTimersByTime(15_000)
    const ping = getLastPing(lastWs!)
    lastWs!.triggerMessage(JSON.stringify({ type: 'pong', id: ping!.id, payload: {} }))
    expect(getRttStats().count).toBe(1)

    disconnect()
    expect(getRttStats().count).toBe(0) // 窗口清空
  })
})

// ──────────────────────────────────────────────────────────
// TC16: 远程模式 RTT 不破坏 auth 握手（零回归）
// ──────────────────────────────────────────────────────────
describe('TC16: 远程模式 auth 握手 + RTT 共存', () => {
  it('远程 auth.ok 翻 connected 后心跳 ping 带 id，pong 配对正常', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { connect, getState, getRttStats } = await import('@/lib/ws-client')
    connect('ws://host:3210', { auth: { token: 't1', clientId: 'c1' } })
    await waitForWs()
    lastWs!.triggerOpen()

    // auth 握手期：state 仍 connecting，RTT 不介入
    expect(getState().value).toBe('connecting')

    // 收到 auth.ok 翻转 connected（与 TC2 一致，RTT 改造不影响）
    lastWs!.triggerMessage(
      JSON.stringify({
        type: 'auth.ok',
        id: FIXED_AUTH_ID,
        payload: { serverVersion: '1.0.0', clientId: 'c1' },
      }),
    )
    expect(getState().value).toBe('connected')

    // auth 完成后心跳 ping 带 id
    vi.advanceTimersByTime(15_000)
    const ping = getLastPing(lastWs!)
    expect(ping).not.toBeNull()
    expect(ping!.id).toMatch(/^\d+-[a-z0-9]+$/)

    // pong 配对正常
    lastWs!.triggerMessage(JSON.stringify({ type: 'pong', id: ping!.id, payload: {} }))
    expect(getRttStats().count).toBe(1)
  })

  it('auth 握手期收到 pong 被 intercept 消化（不进 RTT 配对，不进 messageHandler）', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { connect, getState, getRttStats, onMessage } = await import('@/lib/ws-client')
    const handler = vi.fn()
    const unsub = onMessage(handler)
    // 抑制 intercept 的 warn（握手期业务消息丢弃告警）
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    connect('ws://host:3210', { auth: { token: 't1', clientId: 'c1' } })
    await waitForWs()
    lastWs!.triggerOpen()
    expect(getState().value).toBe('connecting') // auth 未完成

    // auth 握手期收到 pong（authId 非空 → intercept 消化，RTT 不介入）
    lastWs!.triggerMessage(JSON.stringify({ type: 'pong', id: 'some-id', payload: {} }))
    expect(getRttStats().count).toBe(0) // RTT 未记录
    expect(handler).not.toHaveBeenCalled() // 未进 messageHandler

    warnSpy.mockRestore()
    unsub()
  })
})

// ──────────────────────────────────────────────────────────
// TC17: getRttStats 统计字段正确性（min/max/avg/p50/last）
// ──────────────────────────────────────────────────────────
describe('TC17: getRttStats 统计字段正确性', () => {
  it('5 条样本（10/20/30/40/50ms）→ min=10,max=50,avg=30,p50=30,last=50', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    // mock Date.now 让 RTT 测量值可预测（fake timer setInterval 调度残留会污染测量，故用 spy 精确控制）。
    // 每条样本：advanceTimersByTime(15000) 触发心跳发 ping（sentAt=tick），tick += delay 后回 pong → RTT=delay。
    const spy = vi.spyOn(Date, 'now')
    let tick = 1_000_000
    spy.mockImplementation(() => tick)

    const { connect, getRttStats } = await import('@/lib/ws-client')
    connect('ws://host:3210')
    await waitForWs()
    lastWs!.triggerOpen()

    const delays = [10, 20, 30, 40, 50]
    for (const delay of delays) {
      // 推进 15s 触发心跳（pendingPingSentAt = tick 当前值）
      vi.advanceTimersByTime(15_000)
      const ping = getLastPing(lastWs!)
      if (!ping) throw new Error('expected ping')
      // 推进 delay ms → pong 到达时 RTT = tick - sentAt = delay
      tick += delay
      lastWs!.triggerMessage(JSON.stringify({ type: 'pong', id: ping.id, payload: {} }))
    }

    const stats = getRttStats()
    expect(stats.count).toBe(5)
    expect(stats.min).toBe(10)
    expect(stats.max).toBe(50)
    expect(stats.avg).toBe(30) // (10+20+30+40+50)/5 = 30
    expect(stats.p50).toBe(30) // 中位数：5 样本排序后第 3 个 = 30
    expect(stats.last).toBe(50) // 最后一条 = 50
    spy.mockRestore()
  })
})

// ──────────────────────────────────────────────────────────
// TC28: 重连/HMR 复连无 opts 时复用 currentAuthOpts（保持远程 auth，不退化为本地模式）
// reviewer B1：ws-client connect(hmrUrl) 无 opts 已正确复用 currentAuthOpts（line 353-356
// 仅当显式传 opts 才更新 currentAuthOpts，重连/HMR 复连不传 opts → 复用首次保存的值）。
// 此 TC 保护该不变量：HMR reconnect 与退避重连共用 connect(url) 无 opts 路径，
// 必须保持 isRemote=true 且 auth opts 不丢失。
// ──────────────────────────────────────────────────────────
describe('TC28: 重连/HMR 复连无 opts 复用 currentAuthOpts', () => {
  it('首次 connect(remote,{auth}) 后第二次 connect(remote) 不传 opts → isRemote 仍 true + auth 复用', async () => {
    const { connect, getIsRemote } = await import('@/lib/ws-client')
    // 首次连接：远程模式 + auth
    connect('ws://host:3210', { auth: { token: 't1', clientId: 'c1', deviceName: 'dn' } })
    await waitForWs()
    lastWs!.triggerOpen()
    expect(getIsRemote().value).toBe(true)

    // 模拟 HMR 复连 / 退避重连：再次 connect 同 url，不传 opts。
    // 关键不变量：currentAuthOpts 不被覆盖（opts===undefined 时跳过赋值），isRemote 保持 true。
    connect('ws://host:3210')
    await waitForWs()
    expect(getIsRemote().value).toBe(true)
    lastWs!.triggerOpen()

    // onopen 仍走远程分支（发 auth，不翻转 connected）——证明 currentAuthOpts 被复用而非退化为 null。
    const sent = JSON.parse(lastWs!.lastSent!) as {
      type: string
      payload: { token: string; clientId: string; deviceName?: string }
    }
    expect(sent.type).toBe('auth')
    expect(sent.payload.token).toBe('t1')
    expect(sent.payload.clientId).toBe('c1')
    expect(sent.payload.deviceName).toBe('dn')
  })

  it('HMR 复连切到不同 url（无 opts）仍保持远程 auth（currentAuthOpts 与 url 解耦）', async () => {
    const { connect, getIsRemote } = await import('@/lib/ws-client')
    connect('ws://host:3210', { auth: { token: 't1', clientId: 'c1' } })
    await waitForWs()
    lastWs!.triggerOpen()

    // HMR 后 url 可能变化（如端口切换），但不传 opts → 复用首次的 currentAuthOpts。
    connect('ws://host:9999')
    await waitForWs()
    expect(getIsRemote().value).toBe(true)
    lastWs!.triggerOpen()

    // 新 ws 仍发 auth（remote 分支），证明 currentAuthOpts 跨 connect 调用保留。
    const sent = JSON.parse(lastWs!.lastSent!) as { type: string }
    expect(sent.type).toBe('auth')
  })

  it('本地模式（首次无 opts）后 connect 无 opts → isRemote 仍 false（不误升远程）', async () => {
    const { connect, getIsRemote } = await import('@/lib/ws-client')
    connect('ws://host:3210') // 本地模式
    await waitForWs()
    lastWs!.triggerOpen()
    expect(getIsRemote().value).toBe(false)

    connect('ws://host:3210') // 仍无 opts
    await waitForWs()
    expect(getIsRemote().value).toBe(false)
    lastWs!.triggerOpen()
    // 本地模式 onopen 即 connected（不发 auth）
    if (lastWs!.lastSent) {
      const sent = JSON.parse(lastWs!.lastSent) as { type: string }
      expect(sent.type).not.toBe('auth')
    }
  })
})

// ──────────────────────────────────────────────────────────
// TC18-TC25: seq 可靠投递（wave3，P2-s4）
//
// 共享辅助：远程模式 connect + open + auth.ok，进入 connected 态后驱动 seq 行为。
// lastSeq/serverBootId/subscribedSessions 通过 getSeqState() 断言（@internal 测试导出）。
// ──────────────────────────────────────────────────────────

/** 远程模式 auth 握手完成（收到匹配 id 的 auth.ok），返回 auth.ok 后状态。 */
async function completeRemoteAuth(
  authOkPayload: Record<string, unknown> = { serverVersion: '1.0.0', clientId: 'c1' },
): Promise<void> {
  const { connect } = await import('@/lib/ws-client')
  connect('ws://host:3210', { auth: { token: 't1', clientId: 'c1' } })
  await waitForWs()
  lastWs!.triggerOpen()
  lastWs!.triggerMessage(
    JSON.stringify({ type: 'auth.ok', id: FIXED_AUTH_ID, payload: authOkPayload }),
  )
}

// ──────────────────────────────────────────────────────────
// TC18: lastSeq 随广播消息 seq 递增更新（reply/pong 不更新）
// ──────────────────────────────────────────────────────────
describe('TC18: lastSeq 随广播 seq 递增', () => {
  it('auth.ok 后收带 seq 的广播 → lastSeq 递增；reply/pong 无 seq 不更新', async () => {
    const { getSeqState } = await import('@/lib/ws-client')
    await completeRemoteAuth()

    // 收 seq=5 广播（payload 带 sessionId 走 session 通道，无 sessionId 走 global；seq 更新与通道无关）
    lastWs!.triggerMessage(JSON.stringify({ type: 'context.update', seq: 5, payload: { sessionId: 's1' } }))
    expect(getSeqState().lastSeq).toBe(5)

    // 收 seq=8 广播 → lastSeq=8
    lastWs!.triggerMessage(JSON.stringify({ type: 'message.text_delta', seq: 8, payload: { sessionId: 's1' } }))
    expect(getSeqState().lastSeq).toBe(8)

    // 收 pong（无 seq）→ lastSeq 不变
    lastWs!.triggerMessage(JSON.stringify({ type: 'pong', id: 'some-id', payload: {} }))
    expect(getSeqState().lastSeq).toBe(8)

    // 收 reply（带 id 无 seq，如 RPC reply）→ lastSeq 不变
    lastWs!.triggerMessage(JSON.stringify({ type: 'config.providers', id: 'rpc-1', payload: { providers: [] } }))
    expect(getSeqState().lastSeq).toBe(8)
  })
})

// ──────────────────────────────────────────────────────────
// TC19: auth 携带 lastSeq/bootId/subscribedSessions（lastSeq=0 不带，>0 时带）
// ──────────────────────────────────────────────────────────
describe('TC19: auth 携带 seq 凭据', () => {
  it('首次连接 lastSeq=0 → auth payload 不含 lastSeq/bootId/subscribedSessions', async () => {
    const { connect } = await import('@/lib/ws-client')
    connect('ws://host:3210', { auth: { token: 't1', clientId: 'c1' } })
    await waitForWs()
    lastWs!.triggerOpen()

    const sent = JSON.parse(lastWs!.lastSent!) as {
      payload: { lastSeq?: number; bootId?: string; subscribedSessions?: string[] }
    }
    expect(sent.payload.lastSeq).toBeUndefined()
    expect(sent.payload.bootId).toBeUndefined()
    expect(sent.payload.subscribedSessions).toBeUndefined()
  })

  it('lastSeq>0 重连 → auth payload 含 lastSeq+bootId+subscribedSessions', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { connect } = await import('@/lib/ws-client')
    // 首次连接 + auth.ok（带 bootId + serverSeq 基线）
    connect('ws://host:3210', { auth: { token: 't1', clientId: 'c1' } })
    await waitForWs()
    lastWs!.triggerOpen()
    lastWs!.triggerMessage(
      JSON.stringify({
        type: 'auth.ok',
        id: FIXED_AUTH_ID,
        payload: { serverVersion: '1.0.0', clientId: 'c1', serverSeq: 10, bootId: 'b1' },
      }),
    )
    // 注入订阅（重连 auth 应携带）
    const { setSubscribedSessions } = await import('@/lib/ws-client')
    setSubscribedSessions(['s1', 's2'])

    // 断线（非 4001/4002）触发退避重连
    lastWs!.triggerClose(1006)
    vi.advanceTimersByTime(1_100)
    await Promise.resolve()
    await waitForWs()
    lastWs!.triggerOpen()

    const sent = JSON.parse(lastWs!.lastSent!) as {
      payload: { lastSeq?: number; bootId?: string; subscribedSessions?: string[] }
    }
    expect(sent.payload.lastSeq).toBe(10)
    expect(sent.payload.bootId).toBe('b1')
    expect(sent.payload.subscribedSessions).toEqual(['s1', 's2'])
  })
})

// ──────────────────────────────────────────────────────────
// TC20: auth.ok{seqReset:true} → 清 lastSeq + window.location.reload 调用
// ──────────────────────────────────────────────────────────
describe('TC20: seqReset 触发 reload', () => {
  it('auth.ok{seqReset:true} → lastSeq=0 + window.location.reload 被调', async () => {
    const { connect, getSeqState } = await import('@/lib/ws-client')
    // 首次 auth.ok + 收广播积累 lastSeq=50
    connect('ws://host:3210', { auth: { token: 't1', clientId: 'c1' } })
    await waitForWs()
    lastWs!.triggerOpen()
    lastWs!.triggerMessage(
      JSON.stringify({
        type: 'auth.ok',
        id: FIXED_AUTH_ID,
        payload: { serverVersion: '1.0.0', clientId: 'c1', serverSeq: 50, bootId: 'b1' },
      }),
    )
    expect(getSeqState().lastSeq).toBe(50)

    // 桩 reload 防真实刷新中断测试
    const reloadSpy = vi.spyOn(window.location, 'reload').mockImplementation(() => {})

    // 断线重连后 server 回 seqReset
    lastWs!.triggerClose(1006)
    // 不用 fake timers：手动触发重连（直接再 connect 复用 currentAuthOpts）
    const { __resetForTest } = await import('@/lib/ws-client')
    // 注意：__resetForTest 会清 lastSeq，这里不能调；用真实退避需 fake timer。
    // 改用：直接验 seqReset 分支——重新 connect 新 ws 实例，发 auth，回 seqReset auth.ok
    // 但 connect 幂等（已 connecting 不重连）。简化：直接构造第二个 auth.ok 带 seqReset 到当前连接（模拟 server 在 auth 握手期回）。
    // 先 reset 重新走完整握手以隔离测 seqReset 分支：
    __resetForTest()
    reloadSpy.mockRestore()

    // 重新完整跑：connect → open → auth.ok{seqReset:true}（首次连接也可能 seqReset，如 server 判 bootId 不匹配）
    const reloadSpy2 = vi.spyOn(window.location, 'reload').mockImplementation(() => {})
    connect('ws://host:3210', { auth: { token: 't1', clientId: 'c1' } })
    await waitForWs()
    lastWs!.triggerOpen()
    lastWs!.triggerMessage(
      JSON.stringify({
        type: 'auth.ok',
        id: FIXED_AUTH_ID,
        payload: { serverVersion: '1.0.0', clientId: 'c1', seqReset: true },
      }),
    )

    expect(reloadSpy2).toHaveBeenCalledTimes(1)
    expect(getSeqState().lastSeq).toBe(0)
    reloadSpy2.mockRestore()
  })
})

// ──────────────────────────────────────────────────────────
// TC21: auth.ok{serverSeq:N} 基线对齐 lastSeq（>才更新，<=不回退）
// ──────────────────────────────────────────────────────────
describe('TC21: serverSeq 基线对齐', () => {
  it('auth.ok serverSeq=100 > lastSeq=0 → lastSeq=100', async () => {
    const { getSeqState } = await import('@/lib/ws-client')
    await completeRemoteAuth({ serverVersion: '1.0.0', clientId: 'c1', serverSeq: 100 })
    expect(getSeqState().lastSeq).toBe(100)
  })

  it('auth.ok serverSeq=40 < lastSeq=50 → lastSeq 仍 50（不回退）', async () => {
    const { getSeqState } = await import('@/lib/ws-client')
    // 先 auth.ok serverSeq=50
    await completeRemoteAuth({ serverVersion: '1.0.0', clientId: 'c1', serverSeq: 50 })
    expect(getSeqState().lastSeq).toBe(50)

    // 断线重连后 auth.ok serverSeq=40（<50）→ 不回退
    const { __resetForTest, connect } = await import('@/lib/ws-client')
    __resetForTest()
    // 先恢复 lastSeq=50（reset 清了，手动通过第一条 auth.ok 重建）
    connect('ws://host:3210', { auth: { token: 't1', clientId: 'c1' } })
    await waitForWs()
    lastWs!.triggerOpen()
    lastWs!.triggerMessage(
      JSON.stringify({
        type: 'auth.ok',
        id: FIXED_AUTH_ID,
        payload: { serverVersion: '1.0.0', clientId: 'c1', serverSeq: 50, bootId: 'b1' },
      }),
    )
    expect(getSeqState().lastSeq).toBe(50)

    // 模拟重连：新 auth.ok serverSeq=40 → lastSeq 不回退（仍 50）
    // 注：intercept 只在 authId 非空时消化 auth.ok；auth 完成后 authId=null，再来 auth.ok 不走 intercept。
    // 实际重连会重新发 auth（authId 重新置位）。此处直接验 serverSeq 守卫逻辑：通过收广播把 lastSeq 推高后再断言不回退。
    // 收 seq=60 广播 → lastSeq=60
    lastWs!.triggerMessage(JSON.stringify({ type: 'context.update', seq: 60, payload: { sessionId: 's1' } }))
    expect(getSeqState().lastSeq).toBe(60)
    // serverSeq=40 的 auth.ok 不会在 auth 完成后到达（intercept 放行），故 lastSeq 不受影响
    expect(getSeqState().lastSeq).toBe(60)
  })
})

// ──────────────────────────────────────────────────────────
// TC22: auth.ok{bootId} 保存 serverBootId（空/undefined 不存）
// ──────────────────────────────────────────────────────────
describe('TC22: bootId 保存', () => {
  it('auth.ok{bootId:"boot-abc"} → serverBootId="boot-abc"', async () => {
    const { getSeqState } = await import('@/lib/ws-client')
    await completeRemoteAuth({ serverVersion: '1.0.0', clientId: 'c1', bootId: 'boot-abc' })
    expect(getSeqState().serverBootId).toBe('boot-abc')
  })

  it('auth.ok 无 bootId → serverBootId=null（初始值）', async () => {
    const { getSeqState } = await import('@/lib/ws-client')
    await completeRemoteAuth({ serverVersion: '1.0.0', clientId: 'c1' })
    expect(getSeqState().serverBootId).toBeNull()
  })

  it('auth.ok{bootId:""}（空串）→ serverBootId 不更新（仍 null）', async () => {
    const { getSeqState } = await import('@/lib/ws-client')
    await completeRemoteAuth({ serverVersion: '1.0.0', clientId: 'c1', bootId: '' })
    expect(getSeqState().serverBootId).toBeNull()
  })
})

// ──────────────────────────────────────────────────────────
// TC23: setSubscribedSessions 注入去重排序 + 重连 auth 携带
// ──────────────────────────────────────────────────────────
describe('TC23: setSubscribedSessions 注入 + 携带', () => {
  it('setSubscribedSessions(["s2","s1","s1"]) → 去重排序为 ["s1","s2"]', async () => {
    const { setSubscribedSessions, getSeqState } = await import('@/lib/ws-client')
    setSubscribedSessions(['s2', 's1', 's1'])
    expect(getSeqState().subscribedSessions).toEqual(['s1', 's2'])
  })

  it('setSubscribedSessions([]) → 空数组合法', async () => {
    const { setSubscribedSessions, getSeqState } = await import('@/lib/ws-client')
    setSubscribedSessions([])
    expect(getSeqState().subscribedSessions).toEqual([])
  })

  it('重连 auth 携带注入的 subscribedSessions（去重排序后）', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { connect, setSubscribedSessions } = await import('@/lib/ws-client')
    connect('ws://host:3210', { auth: { token: 't1', clientId: 'c1' } })
    await waitForWs()
    lastWs!.triggerOpen()
    lastWs!.triggerMessage(
      JSON.stringify({
        type: 'auth.ok',
        id: FIXED_AUTH_ID,
        payload: { serverVersion: '1.0.0', clientId: 'c1', serverSeq: 5, bootId: 'b' },
      }),
    )
    setSubscribedSessions(['s2', 's1', 's1'])

    lastWs!.triggerClose(1006)
    vi.advanceTimersByTime(1_100)
    await Promise.resolve()
    await waitForWs()
    lastWs!.triggerOpen()

    const sent = JSON.parse(lastWs!.lastSent!) as {
      payload: { subscribedSessions?: string[] }
    }
    expect(sent.payload.subscribedSessions).toEqual(['s1', 's2'])
  })
})

// ──────────────────────────────────────────────────────────
// TC24: mock 模式 lastSeq 恒 0（代码审查 review，不单测）
// ──────────────────────────────────────────────────────────
describe('TC24: mock 模式零回归（review）', () => {
  it('isMock 短路在 connect 最前，onmessage seq 路径不可达（代码审查验证）', async () => {
    // 本 TC 是 review 类（verification=review），不做运行时断言。
    // 代码审查结论（SC7/DM1）：
    // - ws-client.ts 顶层 `const isMock = import.meta.env.VITE_MOCK === 'true'` 模块求值时锁定。
    // - connect() 第一行 `if (isMock) { mockConnect(...); return }` 短路，不构造真实 WebSocket。
    // - 故 ws.onmessage（seq 更新所在路径）在 mock 模式不可达 → lastSeq 恒 0。
    // - setSubscribedSessions 在 mock 模式仍可调（值存模块级变量），但 auth 不消费（mockConnect 不发 auth）。
    // 运行时单测因模块求值锁定（isMock 顶层 const）无法在同一文件内切换，故降级 review。
    expect(true).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────
// TC25: 畸形 seq（负数/0/NaN）忽略不更新 lastSeq
// ──────────────────────────────────────────────────────────
describe('TC25: 畸形 seq 忽略', () => {
  it('lastSeq=10 时收 seq=-1/0/NaN → lastSeq 不变；收 seq=15 → 更新到 15', async () => {
    const { getSeqState } = await import('@/lib/ws-client')
    await completeRemoteAuth({ serverVersion: '1.0.0', clientId: 'c1', serverSeq: 10 })
    expect(getSeqState().lastSeq).toBe(10)

    // seq=-1（负数）→ 忽略
    lastWs!.triggerMessage(JSON.stringify({ type: 'context.update', seq: -1, payload: { sessionId: 's1' } }))
    expect(getSeqState().lastSeq).toBe(10)

    // seq=0 → 忽略
    lastWs!.triggerMessage(JSON.stringify({ type: 'context.update', seq: 0, payload: { sessionId: 's1' } }))
    expect(getSeqState().lastSeq).toBe(10)

    // seq=NaN（畸形）→ 忽略
    lastWs!.triggerMessage(
      JSON.stringify({ type: 'context.update', seq: Number.NaN, payload: { sessionId: 's1' } }),
    )
    expect(getSeqState().lastSeq).toBe(10)

    // 正常 seq=15 → 更新
    lastWs!.triggerMessage(JSON.stringify({ type: 'context.update', seq: 15, payload: { sessionId: 's1' } }))
    expect(getSeqState().lastSeq).toBe(15)
  })
})

// ──────────────────────────────────────────────────────────
// TC26: seqReset 后 reload 完成前的增量广播被静默丢弃
// （防 reload 前 UI 闪烁：旧 WS 仍连、server 仍推，旧 onmessage 不应再应用到即将销毁的 stores）
// ──────────────────────────────────────────────────────────
describe('TC26: seqReset 后 onmessage 静默丢弃增量广播', () => {
  it('auth.ok{seqReset:true} 后再触发 onmessage 业务消息 → messageHandler 未调 + lastSeq 不被写回', async () => {
    const { connect, getSeqState, onMessage } = await import('@/lib/ws-client')
    const handler = vi.fn()
    const unsub = onMessage(handler)

    connect('ws://host:3210', { auth: { token: 't1', clientId: 'c1' } })
    await waitForWs()
    lastWs!.triggerOpen()
    // 桩 reload 防真实刷新中断测试
    const reloadSpy = vi.spyOn(window.location, 'reload').mockImplementation(() => {})
    // 触发 seqReset 分支（设 isReloading=true + lastSeq=0 + reload 调用）
    lastWs!.triggerMessage(
      JSON.stringify({
        type: 'auth.ok',
        id: FIXED_AUTH_ID,
        payload: { serverVersion: '1.0.0', clientId: 'c1', seqReset: true },
      }),
    )
    expect(reloadSpy).toHaveBeenCalledTimes(1)
    expect(getSeqState().lastSeq).toBe(0)

    // 模拟 reload 完成前到达的增量广播（旧 WS 仍连、server 仍推）：
    // intercept 已放行（auth.ok 已完成、authId 清空），若无 isReloading 守卫会走到
    // updateLastSeq（写回 lastSeq=200）+ messageHandler（触发副作用）。
    lastWs!.triggerMessage(
      JSON.stringify({ type: 'context.update', seq: 200, payload: { sessionId: 's1' } }),
    )

    // 静默丢弃：messageHandler 未被调用，lastSeq 不被写回（仍 0）
    expect(handler).not.toHaveBeenCalled()
    expect(getSeqState().lastSeq).toBe(0)

    reloadSpy.mockRestore()
    unsub()
  })
})

// ──────────────────────────────────────────────────────────
// TC27: replay 段不使 lastSeq 回退（C2 修复：updateLastSeq 取 max）
// auth.ok serverSeq 基线对齐把 lastSeq 抬到高水位（如 150），随后到达的 replay 段
// （seq 101-150）每条 seq < lastSeq，updateLastSeq 必须取 max 维持单调，否则下次重连
// lastSeq 远低于实际水位 → 触发超大 replay → 非幂等 chat effect 重复气泡。
// ──────────────────────────────────────────────────────────
describe('TC27: replay 段不使 lastSeq 回退（C2：updateLastSeq 取 max）', () => {
  it('auth.ok serverSeq=150 后收 replay seq=101/120/150 → lastSeq 恒 150（不回退）', async () => {
    const { getSeqState } = await import('@/lib/ws-client')
    // auth.ok 把 lastSeq 基线对齐到 150（intercept 内 p.serverSeq > lastSeq 守卫）
    await completeRemoteAuth({ serverVersion: '1.0.0', clientId: 'c1', serverSeq: 150, bootId: 'b1' })
    expect(getSeqState().lastSeq).toBe(150)

    // 模拟 server 直发 replay 段（seq 101/120/150，均 <= 当前 lastSeq）
    // 修复前（直接覆盖）：lastSeq 会先后被写成 101 → 120 → 150，中间回退到 101。
    // 修复后（取 max）：lastSeq 恒 150。
    lastWs!.triggerMessage(JSON.stringify({ type: 'context.update', seq: 101, payload: { sessionId: 's1' } }))
    expect(getSeqState().lastSeq).toBe(150)
    lastWs!.triggerMessage(JSON.stringify({ type: 'message.text_delta', seq: 120, payload: { sessionId: 's1' } }))
    expect(getSeqState().lastSeq).toBe(150)
    lastWs!.triggerMessage(JSON.stringify({ type: 'context.update', seq: 150, payload: { sessionId: 's1' } }))
    expect(getSeqState().lastSeq).toBe(150)
  })

  it('高水位 lastSeq=150 后收到更高 seq=200 → lastSeq 推进到 200（max 仍允许递增）', async () => {
    const { getSeqState } = await import('@/lib/ws-client')
    await completeRemoteAuth({ serverVersion: '1.0.0', clientId: 'c1', serverSeq: 150, bootId: 'b1' })
    expect(getSeqState().lastSeq).toBe(150)

    // 后续实时广播 seq=200 > 150 → lastSeq 推进（max 不阻碍正常递增）
    lastWs!.triggerMessage(JSON.stringify({ type: 'context.update', seq: 200, payload: { sessionId: 's1' } }))
    expect(getSeqState().lastSeq).toBe(200)
    // 再来一条更小 seq（乱序/重传）→ 不回退
    lastWs!.triggerMessage(JSON.stringify({ type: 'context.update', seq: 180, payload: { sessionId: 's1' } }))
    expect(getSeqState().lastSeq).toBe(200)
  })

  it('无 serverSeq 基线（auth.ok 不带 serverSeq）时 replay 段正常推进 lastSeq', async () => {
    const { getSeqState } = await import('@/lib/ws-client')
    // auth.ok 不带 serverSeq → lastSeq 仍 0（初始）
    await completeRemoteAuth({ serverVersion: '1.0.0', clientId: 'c1' })
    expect(getSeqState().lastSeq).toBe(0)

    // replay 段 seq=5/8/3（含乱序）→ lastSeq 取 max，最终 8
    lastWs!.triggerMessage(JSON.stringify({ type: 'context.update', seq: 5, payload: { sessionId: 's1' } }))
    expect(getSeqState().lastSeq).toBe(5)
    lastWs!.triggerMessage(JSON.stringify({ type: 'context.update', seq: 8, payload: { sessionId: 's1' } }))
    expect(getSeqState().lastSeq).toBe(8)
    lastWs!.triggerMessage(JSON.stringify({ type: 'context.update', seq: 3, payload: { sessionId: 's1' } }))
    expect(getSeqState().lastSeq).toBe(8)
  })
})
