/**
 * RpcClient W3 单元测试（U8）。
 *
 * 覆盖 S6：rpc-client 超时后迟到响应被误当事件广播。
 *
 * 场景：
 * - sendCommand('getState', timeout=100) 因超时 reject
 * - pi 随后发回带同一 id 的迟到响应
 * - 修复前：迟到响应的 id 已不在 pending，handleMessage 走 else 分支当 event 广播 → 幽灵 UI 副作用
 * - 修复后：timedOutIds 命中，迟到响应被丢弃，listener 不收到
 *
 * 测试策略与 rpc-client.test.ts 一致：mock node:child_process 的 spawn + readline，
 * 用 fakeTimer 驱动超时，用 emitPiLine 投递迟到响应。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mocks ──────────────────────────────────────────────────────────

/** 捕获的 stdin 写入行（每条 JSON 字符串）。 */
const stdinWrites: string[] = []

/** stdout line handler——start() 内 rl.on('line') 注册，这里桥接进来。 */
let stdoutLineHandler: ((line: string) => void) | null = null

/** proc.exit handler，start() startup check 用。 */
let procExitHandlers: Array<(code: number | null) => void> = []

const fakeProc = {
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (event === 'exit') procExitHandlers.push(handler as (code: number | null) => void)
    return fakeProc
  }),
  off: vi.fn(),
  removeListener: vi.fn(),
  stdout: {
    on: vi.fn(),
    resume: vi.fn(),
    destroy: vi.fn(),
  },
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

// mock node:readline——createInterface 在真实 stream 上调 resume()，测试用 fake proc 的
// stdout 不是 stream，故桥接 rl.on('line', handler) 把 line handler 抓出来供 emitPiLine 驱动。
vi.mock('node:readline', () => ({
  createInterface: () => ({
    on: (event: string, handler: (line: string) => void) => {
      if (event === 'line') stdoutLineHandler = handler
    },
    close: vi.fn(),
  }),
}))

vi.mock('@xyz-agent/shared', () => ({
  ENV_WHITELIST_PREFIXES: ['PATH', 'HOME', 'USER', 'LANG', 'TERM'],
}))

vi.mock('@xyz-agent/shared/paths', () => ({
  getDataDir: () => '/mock/home/.xyz-agent',
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => '/mock/home' }
})

// pi-paths 被 rpc-client import，mock 掉避免触碰真实 fs
vi.mock('../src/infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-paths.js')>()
  return {
    ...actual,
    getSessionsDir: () => '/mock/home/.xyz-agent/sessions',
    getPiAgentDir: () => '/mock/home/.xyz-agent/pi/agent',
  }
})

// pi-provider-store.getDefaultModel——避免读真实配置
vi.mock('../src/infra/pi/pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-provider-store.js')>()
  return { ...actual, getDefaultModel: () => null }
})

// logger.createPiSessionLog——避免真实文件 IO
vi.mock('../src/infra/logger.js', () => ({
  createPiSessionLog: () => ({ write: vi.fn(), end: vi.fn() }),
}))

// ── Helpers ────────────────────────────────────────────────────────

/** 把伪造的 pi 响应行投递给 RpcClient 的 stdout line handler。 */
function emitPiLine(obj: Record<string, unknown>): void {
  if (!stdoutLineHandler) throw new Error('stdout line handler not registered yet')
  stdoutLineHandler(JSON.stringify(obj))
}

/** 从 stdin 写入里解析出最后一条 JSON 对象。 */
function lastWrittenJson(): Record<string, unknown> {
  const last = stdinWrites[stdinWrites.length - 1]
  return JSON.parse(last)
}

// ── Tests ──────────────────────────────────────────────────────────

describe('RpcClient W3 S6 (timedOutIds)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any

  beforeEach(async () => {
    stdinWrites.length = 0
    stdoutLineHandler = null
    procExitHandlers = []
    fakeProc.on.mockClear()
    fakeProc.stdout.on.mockClear()
    fakeProc.stdin.write.mockClear()

    const { RpcClient } = await import('../src/infra/pi/rpc-client.js')
    client = new RpcClient({ cwd: '/project' })
    await client.start()
  })

  afterEach(async () => {
    // 恢复真实 timer，避免影响后续测试
    vi.useRealTimers()
    // kill 走 SIGTERM + 等待 exit；触发 exit handlers 清 pending
    try { await client.kill() } catch { /* noop */ }
    procExitHandlers = []
  })

  // ── U8: 超时后迟到响应被丢弃，不当 event 广播 ─────────────────────
  it('U8: late reply with same id after timeout is discarded (not broadcast as event)', async () => {
    // 注册一个 event listener，捕获所有 event 广播
    const events: Array<Record<string, unknown>> = []
    client.onEvent((msg: { id?: string; type: string }) => {
      events.push({ id: msg.id, type: msg.type })
    })

    vi.useFakeTimers()
    // 发起命令，短超时 100ms
    const commandPromise = client.sendCommand('get_state', {}, 100)
    await Promise.resolve()
    const sent = lastWrittenJson()
    const cmdId = sent.id as string

    // 推进时间超过超时 → sendCommand 应 reject
    vi.advanceTimersByTime(200)
    await expect(commandPromise).rejects.toThrow(/timed out/)

    // 此时 pending 已清空，id 不再匹配 pending
    expect((client as unknown as { pending: Map<string, unknown> }).pending.has(cmdId)).toBe(false)

    // 模拟 pi 发回带同一 id 的迟到响应
    emitPiLine({ type: 'response', id: cmdId, success: true, data: { late: true } })

    // 修复后：迟到响应被 timedOutIds 命中丢弃，listener 不应收到
    expect(events).toEqual([])
  })

  // ── U8b: timedOutIds 在 5s TTL 后自动清理（避免 Set 无限增长） ──────
  it('U8b: timedOutIds entry expires after 5s TTL', async () => {
    vi.useFakeTimers()
    const commandPromise = client.sendCommand('get_state', {}, 100)
    await Promise.resolve()
    const sent = lastWrittenJson()
    const cmdId = sent.id as string

    // 触发超时
    vi.advanceTimersByTime(200)
    await expect(commandPromise).rejects.toThrow(/timed out/)

    // 超时后 id 在 timedOutIds 中
    const timedOutIds = (client as unknown as { timedOutIds: Set<string> }).timedOutIds
    expect(timedOutIds.has(cmdId)).toBe(true)

    // 5s TTL 后自动清理
    vi.advanceTimersByTime(5_000)
    expect(timedOutIds.has(cmdId)).toBe(false)
  })
})
