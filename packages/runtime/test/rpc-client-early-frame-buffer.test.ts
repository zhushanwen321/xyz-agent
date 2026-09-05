/**
 * RpcClient 早期帧缓冲单元测试（early-frame-buffer 设计 D1-D6 / 实施计划 u-r1-frame-buffer）。
 *
 * 覆盖（验收 7 项）：
 * - R1-1 空窗帧入缓冲；首 listener 注册同步按序重放（顺序与 pi 输出序一致）；新帧随后直通
 * - R1-2 pending 命中的 response 帧不入缓冲（D2：与 listener 无关）
 * - R1-3 上限 256 drop-oldest + warn 恰好一次（不刷屏）
 * - R1-4 重放期间某帧 listener throw 单帧隔离，后续帧继续重放（D5）
 * - R1-5 缓冲一次性：关闭后 listeners 再空集（detach 形态），新帧直通丢弃、再注册不重放（r2 复审 S3）
 * - R1-6 第二个及后续 listener 注册不触发重放（现状 Set 语义）
 * - R1-7 既有直通行为回归：listeners 非空时多播 / response 优先 / timedOutIds 迟到帧丢弃，
 *   行为与改动前完全一致
 *
 * 测试策略与 rpc-client.test.ts / rpc-client-kill-sigcont.test.ts 一致：mock node:child_process
 * 的 spawn + readline，emitPiLine 入口把伪造的 pi stdout JSONL 行投递给 RpcClient 的 line
 * handler。不依赖真实 pi 进程。
 *
 * 运行：npx vitest run test/rpc-client-early-frame-buffer.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RpcClient, RpcTimeoutError, type PiMessage } from '../src/infra/pi/rpc-client.js'

// ── Mocks（骨架复制自 rpc-client-kill-sigcont.test.ts）─────────────────

let stdoutLineHandler: ((line: string) => void) | null = null
let procExitHandlers: Array<(code: number | null) => void> = []

/** 捕获的 stdin 写入行（sendCommand 驱动用）。 */
const stdinWrites: string[] = []

const fakeProc = {
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (event === 'exit') procExitHandlers.push(handler as (code: number | null) => void)
    return fakeProc
  }),
  off: vi.fn(),
  removeListener: vi.fn(),
  stdout: { on: vi.fn(), resume: vi.fn(), destroy: vi.fn() },
  stderr: { on: vi.fn() },
  stdin: {
    write: vi.fn((chunk: string) => {
      stdinWrites.push(chunk)
      return true
    }),
    once: vi.fn(),
  },
  kill: vi.fn(),
  pid: 12345,
}

vi.mock('node:child_process', () => ({
  spawn: () => fakeProc,
}))

vi.mock('node:readline', () => ({
  createInterface: () => ({
    on: (event: string, handler: (line: string) => void) => {
      if (event === 'line') stdoutLineHandler = handler
    },
    close: vi.fn(),
  }),
}))

// importOriginal spread 而非完全替换：rpc-client.start 经 ../spawn-env.js re-export 消费
// shared 的 buildOutboundChildEnv（纯函数、env 全 DI），完全替换式 mock 会随 shared 新增
// 导出静默断联（b5d3e6329 事故根因）；此处仅覆盖测试需要隔离的常量。
vi.mock('@xyz-agent/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xyz-agent/shared')>()),
  ENV_WHITELIST_PREFIXES: ['PATH', 'HOME', 'USER', 'LANG', 'TERM'],
}))

vi.mock('@xyz-agent/shared/paths', () => ({
  getDataDir: () => '/mock/home/.xyz-agent',
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => '/mock/home' }
})

vi.mock('../src/infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-paths.js')>()
  return {
    ...actual,
    getSessionsDir: () => '/mock/home/.xyz-agent/sessions',
    getPiAgentDir: () => '/mock/home/.xyz-agent/pi/agent',
  }
})

vi.mock('../src/infra/pi/pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-provider-store.js')>()
  return { ...actual, getDefaultModel: () => null }
})

vi.mock('../src/infra/logger.js', () => ({
  createPiSessionLog: () => ({ write: vi.fn(), end: vi.fn() }),
}))

// ── Helpers ────────────────────────────────────────────────────────

/** 把伪造的 pi stdout JSONL 行投递给 RpcClient 的 line handler（驱动 handleMessage）。 */
function emitPiLine(obj: Record<string, unknown>): void {
  if (!stdoutLineHandler) throw new Error('stdout line handler not registered yet')
  stdoutLineHandler(JSON.stringify(obj))
}

/** 从 stdin 写入里解析出最后一条 JSON 对象（取 sendCommand 注册的 pending id 用）。 */
function lastWrittenJson(): Record<string, unknown> {
  return JSON.parse(stdinWrites[stdinWrites.length - 1])
}

/** 收集型 listener：把收到的帧推入数组（记录到达序）。 */
function collector(received: PiMessage[]): (msg: PiMessage) => void {
  return (msg) => { received.push(msg) }
}

/** 反射读早期帧缓冲（仅测试观测用，先例：rpc-client.test.ts pendingSize；private 字段须经 unknown 中转——runtime/test 惯例）。 */
function earlyFrameBufferOf(client: RpcClient): PiMessage[] {
  return (client as unknown as { earlyFrameBuffer: PiMessage[] }).earlyFrameBuffer
}

/**
 * 构造贴近真实形态的非 response 帧：pi 原生事件帧 / 带 id 的 extension_ui_request。
 * 返回 Record（emitPiLine 入参类型）；JSONL 线上形态本就无类型，语义由 handleMessage 端标注。
 */
function earlyFrame(i: number, withId = false): Record<string, unknown> {
  const frame: Record<string, unknown> = { type: `evt_${i}`, payload: { sessionId: 's1', seq: i } }
  // D2：非 pending 的带 id 帧（如 extension_ui_request / bash_execution_update）同属
  // listener 分支帧集，也应进缓冲——上限压测用带 id 形态顺带覆盖。
  if (withId) frame.id = `req_${i}`
  return frame
}

// ── Tests ──────────────────────────────────────────────────────────

describe('RpcClient 早期帧缓冲（early-frame-buffer D1-D6）', () => {
  let client: RpcClient
  let warnSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    stdinWrites.length = 0
    stdoutLineHandler = null
    procExitHandlers = []
    fakeProc.on.mockClear()
    fakeProc.stdin.write.mockClear()
    // 缓冲溢出 warn / 重放隔离 error 走 console——spy 掉避免测试输出噪音，供次数断言
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    client = new RpcClient({ cwd: '/project' })
    await client.start()
    // start 的 500ms startup 检查已结束，其注册的 exit handlers 已被 cleanup 移除
    procExitHandlers = []
  })

  afterEach(async () => {
    vi.useRealTimers()
    warnSpy.mockRestore()
    errorSpy.mockRestore()
    // kill 后手动驱动 exit handlers 让 kill 立即 resolve（先例：kill-sigcont 测试 emitExit）
    const killPromise = client.kill().catch(() => {})
    procExitHandlers.forEach((h) => h(0))
    procExitHandlers = []
    await killPromise
  })

  // ── R1-1 空窗入缓冲 + 首注册同步按序重放（G3 全序）────────────────
  it('R1-1: 空窗帧入缓冲；首个 listener 注册时同步按序重放，之后新帧直通且不重复', () => {
    // 空窗：无 listener，pi 依次输出 3 帧（session_start → bridge:sync → bridge:event）
    const f1 = { type: 'session_start', payload: { sessionId: 's1' } }
    const f2 = { type: 'extension_ui_request', id: 'req_sync', payload: { method: 'select' } }
    const f3 = { type: 'extension_ui_request', id: 'req_event', payload: { method: 'select' } }
    emitPiLine(f1)
    emitPiLine(f2)
    emitPiLine(f3)
    expect(earlyFrameBufferOf(client).map((m) => m.type)).toEqual(['session_start', 'extension_ui_request', 'extension_ui_request'])

    // 首 listener 注册：重放发生在 onEvent 返回前（同步），顺序 = pi 输出序
    const received: PiMessage[] = []
    client.onEvent(collector(received))
    expect(received).toEqual([f1, f2, f3])

    // attach 后新帧直通（现状分支不变），不重复投递
    const f4 = { type: 'agent_start', payload: { sessionId: 's1' } }
    emitPiLine(f4)
    expect(received).toEqual([f1, f2, f3, f4])
  })

  // ── R1-2 pending 命中的 response 帧不入缓冲（D2）──────────────────
  it('R1-2: pending 命中的 response 帧走 resolve、不进缓冲（后续 listener 不收到它）', async () => {
    const statePromise = client.getState()
    await Promise.resolve()
    const sent = lastWrittenJson()

    emitPiLine({ type: 'response', id: sent.id, success: true, data: { sessionId: 'real-id' } })
    const state = await statePromise
    expect(state).toEqual({ sessionId: 'real-id' })

    // response 帧未入缓冲：首 listener 注册后收到的重放为空
    const received: PiMessage[] = []
    client.onEvent(collector(received))
    expect(received).toHaveLength(0)
    expect(earlyFrameBufferOf(client)).toHaveLength(0)
  })

  // ── R1-3 上限 256 drop-oldest + warn 一次（D3）────────────────────
  it('R1-3: 超过 256 帧丢最旧、重放保留最近 256 帧窗口；warn 恰好一次不刷屏', () => {
    const TOTAL = 300
    for (let i = 1; i <= TOTAL; i++) emitPiLine(earlyFrame(i, true))

    // 超限丢最旧：缓冲保留最近 256 帧（f45..f300）
    expect(earlyFrameBufferOf(client)).toHaveLength(256)
    expect(earlyFrameBufferOf(client)[0]?.type).toBe('evt_45')
    expect(earlyFrameBufferOf(client)[255]?.type).toBe('evt_300')

    // warn 一次（第 257 帧首次超限时），后续 43 次 drop 静默
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('256')

    // 重放 = 最近 256 帧连续窗口，序与 pi 输出序一致
    const received: PiMessage[] = []
    client.onEvent(collector(received))
    expect(received).toHaveLength(256)
    expect(received[0]?.type).toBe('evt_45')
    expect(received[255]?.type).toBe('evt_300')
  })

  // ── R1-4 重放 per-帧 throw 隔离（D5）──────────────────────────────
  it('R1-4: 重放中某帧 listener throw 不中断后续帧，也不炸到 onEvent 调用方', () => {
    emitPiLine({ type: 'session_start' })
    emitPiLine({ type: 'agent_start' })
    emitPiLine({ type: 'agent_end' })

    const received: PiMessage[] = []
    // 第 2 帧 throw：单帧隔离，重放继续、onEvent 正常返回
    expect(() => {
      client.onEvent((msg) => {
        if (msg.type === 'agent_start') throw new Error('interpret boom')
        received.push(msg)
      })
    }).not.toThrow()

    expect(received.map((m) => m.type)).toEqual(['session_start', 'agent_end'])
    expect(errorSpy).toHaveBeenCalledTimes(1)

    // 重放完成后缓冲已关闭，新帧照常直通
    emitPiLine({ type: 'turn_end' })
    expect(received.map((m) => m.type)).toEqual(['session_start', 'agent_end', 'turn_end'])
  })

  // ── R1-5 缓冲一次性：关闭后再空集不重放陈旧帧（r2 复审 S3）────────
  it('R1-5: 缓冲关闭后 listeners 再空集（detach 形态），新帧直通丢弃、再注册不重放', () => {
    emitPiLine({ type: 'session_start' })
    emitPiLine({ type: 'agent_start' })

    // 首注册：重放 2 帧 + 关闭缓冲
    const got1: PiMessage[] = []
    const off1 = client.onEvent(collector(got1))
    expect(got1.map((m) => m.type)).toEqual(['session_start', 'agent_start'])

    // detach：listeners 再空集（event-adapter detachSession 真实形态）
    off1()

    // 此刻新帧 = 直通丢弃（现状语义），不重新入缓冲
    emitPiLine({ type: 'agent_end' })
    expect(earlyFrameBufferOf(client)).toHaveLength(0)

    // 再注册（restore/fork 形态的首注册）：不重放陈旧帧（agent_end 已被丢弃，无帧可重放）
    const got2: PiMessage[] = []
    client.onEvent(collector(got2))
    expect(got2).toHaveLength(0)

    // 新 listener 只收未来帧
    emitPiLine({ type: 'turn_end' })
    expect(got2.map((m) => m.type)).toEqual(['turn_end'])
  })

  // ── R1-6 第二 listener 不重放（现状 Set 语义）─────────────────────
  it('R1-6: 第二个及后续 listener 注册不触发重放，只收注册之后的直通帧', () => {
    emitPiLine({ type: 'session_start' })
    emitPiLine({ type: 'agent_start' })

    const got1: PiMessage[] = []
    client.onEvent(collector(got1))
    // 首注册重放空窗帧
    expect(got1.map((m) => m.type)).toEqual(['session_start', 'agent_start'])

    // 第二注册：无重放（handoff-service ensureActive 到达形态）
    const got2: PiMessage[] = []
    client.onEvent(collector(got2))
    expect(got2).toHaveLength(0)

    // 直通多播：后续帧两个 listener 都收到（现状广播语义不变）
    emitPiLine({ type: 'agent_end' })
    expect(got1.map((m) => m.type)).toEqual(['session_start', 'agent_start', 'agent_end'])
    expect(got2.map((m) => m.type)).toEqual(['agent_end'])
  })

  // ── R1-7 既有直通行为回归（listeners 非空时与改动前一致）──────────
  it('R1-7a: listeners 非空时事件帧多播给全部 listener（现状语义不变）', () => {
    const got1: PiMessage[] = []
    const got2: PiMessage[] = []
    client.onEvent(collector(got1))
    client.onEvent(collector(got2))

    emitPiLine({ type: 'session_start', payload: { sessionId: 's1' } })
    emitPiLine({ type: 'extension_ui_request', id: 'req_sync', payload: { method: 'select' } })

    expect(got1).toHaveLength(2)
    expect(got2).toHaveLength(2)
    expect(got1[0]?.type).toBe('session_start')
    expect(got1[1]?.id).toBe('req_sync')
    expect(got2).toEqual(got1)
  })

  it('R1-7b: listeners 非空时 pending 命中的 response 仍优先 resolve、不广播给 listener', async () => {
    const got1: PiMessage[] = []
    client.onEvent(collector(got1))

    const statePromise = client.getState()
    await Promise.resolve()
    const sent = lastWrittenJson()
    emitPiLine({ type: 'response', id: sent.id, success: true, data: { sessionId: 'real-id' } })

    const state = await statePromise
    expect(state).toEqual({ sessionId: 'real-id' })
    // response 帧未被当作 event 广播（改动前行为）
    expect(got1).toHaveLength(0)
  })

  it('R1-7c: timedOutIds 迟到响应仍被丢弃（S6 现状），且不进缓冲（D2 分支序）', async () => {
    const got1: PiMessage[] = []
    client.onEvent(collector(got1))

    // sendCommand 超时 → id 入 timedOutIds（fake timers 推进 FAST_TIMEOUT_MS）。
    // 先 useFakeTimers 再调 getState：timer 必须在 fake 模式下注册（真实 timer 不受
    // advanceTimersByTime 控制，先例：kill-sigcont 测试同样先 fake 后调用）。
    vi.useFakeTimers()
    const p = client.getState()
    vi.advanceTimersByTime(10_000)
    await expect(p).rejects.toThrow(RpcTimeoutError)

    // 同 id 迟到的 response：丢弃（不广播）
    const sent = lastWrittenJson()
    emitPiLine({ type: 'response', id: sent.id, success: true, data: { sessionId: 'late' } })
    expect(got1).toHaveLength(0)
    expect(earlyFrameBufferOf(client)).toHaveLength(0)

    vi.useRealTimers()

    // 该帧也未入缓冲：后续（假设 detach 后的）首注册不会重放出幽灵 response
    const got2: PiMessage[] = []
    client.onEvent(collector(got2))
    expect(got2).toHaveLength(0)

    // 正常事件帧随后照常直通
    emitPiLine({ type: 'session_start' })
    expect(got1.map((m) => m.type)).toEqual(['session_start'])
    expect(got2.map((m) => m.type)).toEqual(['session_start'])
  })
})
