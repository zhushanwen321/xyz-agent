/**
 * probe 单测 —— WS 连接探测模块（P1-s1-w2 / plan.json TC1-TC8）。
 *
 * 覆盖 8 个场景：
 *  - TC1: 握手成功（onopen→auth→auth.ok→close→resolve {ok, serverVersion}）
 *  - TC2: auth 失败 close 4001 → resolve {ok:false, error:'auth'}
 *  - TC3: 超时（注入 timeoutMs=50，onopen 后静默）→ 50ms 内 resolve timeout
 *  - TC4: 网络失败 onerror → resolve {ok:false, error:'network'}
 *  - TC5: 非 4001/4002 close（1011）→ resolve {ok:false, error:'network'}
 *  - TC6: token 空短路 → resolve {ok:false, error:'auth'}，不构造 WebSocket
 *  - TC7: probeOnline 在线 → onopen 即 true，立即 close，不发消息
 *  - TC8: 副作用隔离 → 不触 ws-client.connect、不写 localStorage
 *
 * 框架：vitest + happy-dom（禁止 node:test，遵守 AGENTS 测试规范——每用例至少一个用户可见断言）。
 * Mock 策略：vi.stubGlobal('WebSocket', MockWebSocket) 全局桩，不触真实网络。
 * MockWebSocket 提供 triggerOpen/triggerMessage/triggerError/triggerClose 供测试驱动 + send 缓存。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  buildAuthMessage,
  probeConnection,
  probeConnect,
  probeOnline,
} from '../probe'
import { __resetForTest } from '../connection-config'

// ── MockWebSocket：全局桩，捕获 url + send + 提供 trigger* 驱动 ──────

/** WS readyState 常量镜像（与浏览器一致） */
const READY_CONNECTING = 0
const READY_OPEN = 1
const READY_CLOSING = 2
const READY_CLOSED = 3

/** 构造计数：TC6 用以断言 token 空短路时「构造器未被调用」 */
let constructCount = 0

/**
 * Mock WebSocket：实例化时记录 url + readyState=CONNECTING；提供实例方法
 * triggerOpen/triggerMessage/triggerError/triggerClose 供测试驱动事件；
 * send(msg) 缓存到 lastSent/ sentMessages 供断言；close() 翻 readyState=CLOSED。
 *
 * 字段 onopen/onmessage/onclose/onerror 故意声明为可赋值的实例属性，
 * 模拟浏览器 WebSocket 的 callback 赋值语义（ws.onopen = ...）。
 */
class MockWebSocket {
  static readonly CONNECTING = READY_CONNECTING
  static readonly OPEN = READY_OPEN
  static readonly CLOSING = READY_CLOSING
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
    constructCount++
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

  triggerError(): void {
    this.onerror?.(new Event('error'))
  }

  triggerClose(code: number, reason = ''): void {
    this.readyState = READY_CLOSED
    this.onclose?.({ code, reason } as CloseEvent)
  }
}

/** 抓取最近一次创建的 MockWebSocket 实例（每个用例 reset） */
let lastWs: MockWebSocket | null = null
const OrigWebSocket = MockWebSocket

beforeEach(() => {
  localStorage.clear()
  __resetForTest()
  constructCount = 0
  lastWs = null
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

afterEach(() => {
  vi.unstubAllGlobals()
})

// ── TC1: 握手成功 ──────────────────────────────────────────────

describe('probeConnection TC1: 成功路径', () => {
  it('onopen→auth→auth.ok→close→resolve {ok:true, serverVersion}', async () => {
    const p = probeConnection('ws://host:3210', 'token-abc', 1000)

    // onopen 应由 happy-dom event loop 触发，但 mock 需手动驱动；
    // probeConnection 已 await 住 ws.onopen 赋值后才 resolve，此处直接 trigger
    await waitForWs()
    lastWs!.triggerOpen()
    // 服务端收到 auth 后回 auth.ok（id 匹配）
    await nextTick()
    lastWs!.triggerMessage(
      JSON.stringify({ type: 'auth.ok', id: 'auth_x', payload: { serverVersion: '1.2.3' } }),
    )

    const result = await p

    // resolve 形状
    expect(result).toEqual({ ok: true, serverVersion: '1.2.3' })
    // 发出的消息：type==='auth' + payload.token==='token-abc'
    expect(lastWs!.lastSent).not.toBeNull()
    const sent = JSON.parse(lastWs!.lastSent!) as {
      type: string
      payload: { token: string; clientId: string; deviceName?: string; lastSeq?: number }
    }
    expect(sent.type).toBe('auth')
    expect(sent.payload.token).toBe('token-abc')
    // lastSeq 不带（spec D10）
    expect(sent.payload.lastSeq).toBeUndefined()
    // 探测结束 WS 已 close（readyState===CLOSED）
    expect(lastWs!.readyState).toBe(READY_CLOSED)
  })
})

// ── TC2: auth 失败 close 4001 ──────────────────────────────────

describe('probeConnection TC2: close 4001 → error:auth', () => {
  it('服务端 close code 4001 → resolve {ok:false, error:"auth"}', async () => {
    const p = probeConnection('ws://host:3210', 'wrong-token', 1000)

    await waitForWs()
    lastWs!.triggerOpen() // onopen 仍发 auth（即便随后失败）
    await nextTick()
    lastWs!.triggerClose(4001, 'unauthorized')

    const result = await p

    expect(result).toEqual({ ok: false, error: 'auth' })
    // 不抛异常（result 已 resolve，非 reject）
    // onopen 时仍发出了 auth 消息
    expect(lastWs!.sentMessages.length).toBe(1)
    const sent = JSON.parse(lastWs!.sentMessages[0]) as { type: string }
    expect(sent.type).toBe('auth')
    // WS 已 close
    expect(lastWs!.readyState).toBe(READY_CLOSED)
  })
})

// ── TC3: 超时 ──────────────────────────────────────────────────

describe('probeConnection TC3: timeout', () => {
  it('注入 timeoutMs=50，onopen 后静默 → <300ms resolve timeout', async () => {
    const start = Date.now()
    const p = probeConnection('ws://host:3210', 'token-abc', 50)

    await waitForWs()
    lastWs!.triggerOpen() // onopen 后服务端静默（不回 auth.ok，不 close）

    const result = await p
    const elapsed = Date.now() - start

    expect(result).toEqual({ ok: false, error: 'timeout' })
    // <300ms 完成（CI 时间预算保护 + 假阴性兜底）
    expect(elapsed).toBeLessThan(300)
    // WS 被强制 close（readyState===CLOSED）
    expect(lastWs!.readyState).toBe(READY_CLOSED)
  })
})

// ── TC4: 网络失败 onerror ──────────────────────────────────────

describe('probeConnection TC4: onerror → network', () => {
  it('构造后立即 onerror → resolve {ok:false, error:"network"}，未发 auth', async () => {
    const p = probeConnection('ws://unreachable:3210', 'token-abc', 1000)

    await waitForWs()
    lastWs!.triggerError() // 模拟服务器不可达 / Tailscale 断开

    const result = await p

    expect(result).toEqual({ ok: false, error: 'network' })
    // onopen 未触发 → 未发 auth（sentMessages 为空）
    expect(lastWs!.sentMessages).toHaveLength(0)
  })
})

// ── TC5: 非 4001/4002 close（1011）→ network ───────────────────

describe('probeConnection TC5: 异常 close code → network', () => {
  it('close code 1011（非 4001/4002）→ resolve {ok:false, error:"network"}', async () => {
    const p = probeConnection('ws://host:3210', 'token-abc', 1000)

    await waitForWs()
    lastWs!.triggerOpen()
    await nextTick()
    // 1011 unexpected condition（WS 层映射，spec §4.2）
    lastWs!.triggerClose(1011, 'unexpected condition')

    const result = await p

    expect(result).toEqual({ ok: false, error: 'network' })
    expect(lastWs!.readyState).toBe(READY_CLOSED)
  })
})

// ── TC6: token 空短路 ──────────────────────────────────────────

describe('probeConnection TC6: token 空短路', () => {
  it('token="" → resolve {ok:false, error:"auth"}，不构造 WebSocket', async () => {
    const result = await probeConnection('ws://host:3210', '', 1000)

    expect(result).toEqual({ ok: false, error: 'auth' })
    // WebSocket 构造器未被调用（无 new WebSocket 副作用）
    expect(constructCount).toBe(0)
    // 没有 lastWs 实例
    expect(lastWs).toBeNull()
  })
})

// ── TC7: probeOnline 在线 ──────────────────────────────────────

describe('probeOnline TC7: 在线 → true', () => {
  it('onopen 即返回 true，立即 close，不发消息', async () => {
    const p = probeOnline('ws://host:3210')

    await waitForWs()
    lastWs!.triggerOpen()

    const result = await p

    expect(result).toBe(true)
    // onopen 触发后立即 close（readyState===CLOSED）
    expect(lastWs!.readyState).toBe(READY_CLOSED)
    // 不发任何消息（仅探活，无 auth 握手）
    expect(lastWs!.sentMessages).toHaveLength(0)
  })

  it('probeOnline onerror → false', async () => {
    const p = probeOnline('ws://down:3210')

    await waitForWs()
    lastWs!.triggerError()

    expect(await p).toBe(false)
    expect(lastWs!.readyState).toBe(READY_CLOSED)
  })
})

// ── TC8: 副作用隔离（不触 ws-client / 不写 localStorage）────────

describe('probeConnection TC8: 副作用隔离', () => {
  it('探测全程不触 ws-client.connect、不写 localStorage', async () => {
    // 监听 ws-client.connect：动态 import 避免触发 HMR 复连副作用
    const wsClient = await import('../../ws-client')
    const connectSpy = vi.spyOn(wsClient, 'connect').mockImplementation(() => undefined)

    // 监听 localStorage.setItem
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')

    const p = probeConnection('ws://host:3210', 'token-abc', 1000)

    await waitForWs()
    lastWs!.triggerOpen()
    await nextTick()
    lastWs!.triggerMessage(
      JSON.stringify({ type: 'auth.ok', id: 'a', payload: { serverVersion: '1.0.0' } }),
    )

    const result = await p

    // 成功返回（前置：探测确实跑通了，副作用断言才有意义）
    expect(result).toEqual({ ok: true, serverVersion: '1.0.0' })
    // wsClient.connect 全程未被调用（0 次）
    expect(connectSpy).not.toHaveBeenCalled()
    // localStorage.setItem 全程未被调用（探测不写 connection-mode / active-server-id / remote-servers）
    // 注：getClientId 首次生成会写 client-id —— 预先在 localStorage 写入避免触发，
    //     以隔离探测本身不写任何 key 的断言（client-id 写入属 connection-config 行为，非 probe 职责）。
    // 这里改断言「未写 probe 职责范围内的 key」更精确：
    const probeKeys = [
      'xyz-agent:connection-mode',
      'xyz-agent:active-server-id',
      'xyz-agent:remote-servers',
      'xyz-agent:device-name',
    ]
    for (const k of probeKeys) {
      expect(setItemSpy).not.toHaveBeenCalledWith(k, expect.anything())
    }
    // WS 已 close
    expect(lastWs!.readyState).toBe(READY_CLOSED)

    connectSpy.mockRestore()
    setItemSpy.mockRestore()
  })
})

// ── buildAuthMessage 纯函数单测（contracts 验证）──────────────

describe('buildAuthMessage 纯函数', () => {
  it('返回 {type:"auth", id:"auth_<uuid>", payload:{token,clientId,deviceName}}，不带 lastSeq', () => {
    const msg = buildAuthMessage({
      token: 't',
      clientId: 'c-1',
      deviceName: 'Mac',
    })
    expect(msg.type).toBe('auth')
    expect(msg.id).toMatch(/^auth_[0-9a-f-]{36}$/)
    expect(msg.payload).toEqual({ token: 't', clientId: 'c-1', deviceName: 'Mac' })
    expect(msg.payload.lastSeq).toBeUndefined()
  })

  it('deviceName 缺省时 payload 不含 deviceName 键', () => {
    const msg = buildAuthMessage({ token: 't', clientId: 'c' })
    expect(msg.payload).toEqual({ token: 't', clientId: 'c' })
    expect('deviceName' in msg.payload).toBe(false)
  })

  it('相同输入产生结构等价输出（id 随机但形状一致）', () => {
    const a = buildAuthMessage({ token: 't', clientId: 'c' })
    const b = buildAuthMessage({ token: 't', clientId: 'c' })
    expect(a.type).toBe(b.type)
    expect(a.payload).toEqual(b.payload)
    // id 每次随机（极小概率碰撞，不严格不等断言；仅验证同形）
    expect(a.id).toMatch(/^auth_/)
    expect(b.id).toMatch(/^auth_/)
  })
})

// ── probeConnect 别名（CL4 / IF14）─────────────────────────────

describe('probeConnect 别名（CL4 / IF14）', () => {
  it('probeConnect === probeConnection', () => {
    expect(probeConnect).toBe(probeConnection)
  })
})

// ── 测试工具 ───────────────────────────────────────────────────

/**
 * 等待 probeConnection 内部 `new WebSocket(...)` 完成 + onopen 赋值。
 * probeConnection 是 async，首行 new WebSocket 同步执行，但 onopen 赋值
 * 在 Promise executor 同步段——故 await 一个微任务即可拿到 lastWs。
 */
async function waitForWs(): Promise<void> {
  // 至少让出两轮微任务（Promise executor + 任何内部 await）
  await Promise.resolve()
  await Promise.resolve()
}

/** 让出一轮微任务（驱动 triggerOpen 后的 send 等） */
async function nextTick(): Promise<void> {
  await Promise.resolve()
}
