/**
 * ws-client auth 握手 + close code 分流测试（wave1 p1-s2-w1）。
 *
 * 覆盖 8 个 TC（plan.json TC1-TC8）：
 *  - TC1: onopen 远程模式发 auth payload 且不带 lastSeq
 *  - TC2: auth.ok 前不 connected，auth.ok 后翻 connected
 *  - TC3: 4001 → failed(auth) 不重连
 *  - TC4: 4002 → failed(replaced) 不重连
 *  - TC5: 10s auth 超时 → failed(auth)
 *  - TC6: 重连复用 auth opts
 *  - TC7: 本地模式零回归（无 auth opts 时 onopen 即 connected、failReason null、isRemote false）
 *  - TC8: intercept 在 auth 完成前消化其他消息（丢弃+warn，不进 messageHandler）
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
  buildAuthMessage: (opts: { token: string; clientId: string; deviceName?: string }) => ({
    type: 'auth' as const,
    id: FIXED_AUTH_ID,
    payload: {
      token: opts.token,
      clientId: opts.clientId,
      ...(opts.deviceName !== undefined ? { deviceName: opts.deviceName } : {}),
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
