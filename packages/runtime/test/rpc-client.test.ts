/**
 * RpcClient W1 单元测试（U1-U5）。
 *
 * 覆盖 plan.json：
 * - U1: sendCommand 归一 payload→data
 * - U2: sendCommand 归一正常路径（data 优先，无副作用）
 * - U3: switchSession 写入 switch_session + sessionPath
 * - U4: sendExtensionUiResponse 走 sendRaw，pending 不增长
 * - U5: sendExtensionUiResponse 三种 payload 格式（cancelled/confirmed/value）
 *
 * 测试策略：mock node:child_process 的 spawn，捕获 stdin 写入，并提供一个
 * emitLine 入口把伪造的 pi stdout JSONL 行投递给 RpcClient 的 line handler，
 * 从而驱动 pending resolve。这样不依赖真实 pi 进程。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RpcClient } from '../src/infra/pi/rpc-client.js'

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

/** 读取 RpcClient 内部 pending Map 的 size（反射，仅测试用）。 */
function pendingSize(client: { pending?: Map<unknown, unknown> }): number {
  return (client as unknown as { pending: Map<unknown, unknown> }).pending.size
}

// ── Tests ──────────────────────────────────────────────────────────

describe('RpcClient W1', () => {
  let client: RpcClient

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
    // kill 走 SIGTERM + 等待 exit；触发 exit handlers 清 pending
    try { await client.kill() } catch { /* noop */ }
    procExitHandlers = []
  })

  // ── U1: sendCommand 归一 payload→data ────────────────────────────
  it('U1: sendCommand resolves with data normalized from payload when data absent', async () => {
    // 通过 public getState 间接驱动 sendCommand('get_state')，捕获 nextId
    const statePromise = client.getState()
    // 等一拍让 sendCommand 写完 stdin 并注册 pending
    await Promise.resolve()

    // pi 回 {type:'response', id, success:true, payload:{foo:1}}（无 data）
    const sent = lastWrittenJson()
    emitPiLine({ type: 'response', id: sent.id, success: true, payload: { foo: 1 } })

    const state = await statePromise
    // 归一后 data === payload
    expect(state).toEqual({ foo: 1 })
  })

  // ── U2: sendCommand 归一正常路径（data 优先，无副作用）────────────
  it('U2: sendCommand resolves with data when both data present (data wins, no payload leak)', async () => {
    const statePromise = client.getState()
    await Promise.resolve()

    const sent = lastWrittenJson()
    // pi 回 data + payload 同时存在 → data 优先
    emitPiLine({
      type: 'response',
      id: sent.id,
      success: true,
      data: { bar: 2 },
      payload: { shouldNotWin: true },
    })

    const state = await statePromise
    expect(state).toEqual({ bar: 2 })
  })

  // ── U3: switchSession 写入 switch_session + sessionPath ───────────
  it('U3: switchSession writes {type:"switch_session", sessionPath} to stdin', async () => {
    const switchPromise = client.switchSession('/path/to/session')
    await Promise.resolve()

    const sent = lastWrittenJson()
    expect(sent.type).toBe('switch_session')
    expect(sent.sessionPath).toBe('/path/to/session')

    // 让 pi 回一个 success 让 promise resolve（switch_session 在 W1 仍走 sendCommand）
    emitPiLine({ type: 'response', id: sent.id, success: true, data: {} })
    await switchPromise
  })

  // ── U4: sendExtensionUiResponse 走 sendRaw，pending 不增长 ─────────
  it('U4: sendExtensionUiResponse writes via sendRaw (no pending entry created)', () => {
    const sizeBefore = pendingSize(client)

    client.sendExtensionUiResponse('req-1', true, 'confirm')

    const sent = lastWrittenJson()
    expect(sent.type).toBe('extension_ui_response')
    expect(sent.id).toBe('req-1')
    expect(sent.confirmed).toBe(true)

    expect(pendingSize(client)).toBe(sizeBefore)
  })

  // ── U5: sendExtensionUiResponse 三种 payload 格式 ─────────────────
  it('U5a: sendExtensionUiResponse(result=null, method=select) → {cancelled:true}', () => {
    client.sendExtensionUiResponse('r1', null, 'select')
    const sent = lastWrittenJson()
    expect(sent.id).toBe('r1')
    expect(sent.cancelled).toBe(true)
    expect(sent.confirmed).toBeUndefined()
    expect(sent.value).toBeUndefined()
  })

  it('U5b: sendExtensionUiResponse(result=true, method=confirm) → {confirmed:true}', () => {
    client.sendExtensionUiResponse('r2', true, 'confirm')
    const sent = lastWrittenJson()
    expect(sent.id).toBe('r2')
    expect(sent.confirmed).toBe(true)
    expect(sent.cancelled).toBeUndefined()
    expect(sent.value).toBeUndefined()
  })

  it('U5c: sendExtensionUiResponse(result="hello", method=input) → {value:"hello"}', () => {
    client.sendExtensionUiResponse('r3', 'hello', 'input')
    const sent = lastWrittenJson()
    expect(sent.id).toBe('r3')
    expect(sent.value).toBe('hello')
    expect(sent.confirmed).toBeUndefined()
    expect(sent.cancelled).toBeUndefined()
  })

  // ── U5d: bridge 场景——response 是对象且无 method → {id, response} ──
  it('U5d: sendExtensionUiResponse(response=object, no method) → bridge {id, response} format', () => {
    const payload = { content: 'tool result', isError: false }
    client.sendExtensionUiResponse('rb-1', payload)
    const sent = lastWrittenJson()
    expect(sent.id).toBe('rb-1')
    expect(sent.response).toEqual(payload)
    expect(sent.confirmed).toBeUndefined()
    expect(sent.cancelled).toBeUndefined()
    expect(sent.value).toBeUndefined()
  })

  // ── U6: compact/getCommands/getSessionStats 用归一后的 data（删 readRpcData 后仍工作） ──
  it('U6a: compact returns normalized data (works without readRpcData)', async () => {
    const p = client.compact()
    await Promise.resolve()
    const sent = lastWrittenJson()
    emitPiLine({
      type: 'response',
      id: sent.id,
      success: true,
      data: { summary: 's', firstKeptEntryId: 'e1', tokensBefore: 100 },
    })
    const result = await p
    expect(result.summary).toBe('s')
    expect(result.firstKeptEntryId).toBe('e1')
    expect(result.tokensBefore).toBe(100)
  })

  it('U6b: compact returns data normalized from payload (data absent)', async () => {
    const p = client.compact()
    await Promise.resolve()
    const sent = lastWrittenJson()
    emitPiLine({
      type: 'response',
      id: sent.id,
      success: true,
      payload: { summary: 's2', firstKeptEntryId: 'e2', tokensBefore: 200 },
    })
    const result = await p
    expect(result.summary).toBe('s2')
  })

  it('U6c: getCommands returns normalized data.commands (含 sourceInfo 透传)', async () => {
    const p = client.getCommands()
    await Promise.resolve()
    const sent = lastWrittenJson()
    emitPiLine({
      type: 'response',
      id: sent.id,
      success: true,
      payload: {
        commands: [
          {
            name: 'cmd1',
            source: 'skill',
            sourceInfo: { path: '/proj/skills/cmd1/SKILL.md', source: 'skill', scope: 'project' },
          },
          { name: 'cmd2', source: 'builtin' },
        ],
      },
    })
    const result = await p
    expect(result).toEqual([
      {
        name: 'cmd1',
        source: 'skill',
        sourceInfo: { path: '/proj/skills/cmd1/SKILL.md', source: 'skill', scope: 'project' },
      },
      { name: 'cmd2', source: 'builtin' },
    ])
  })

  it('U6d: getSessionStats returns normalized data', async () => {
    const p = client.getSessionStats()
    await Promise.resolve()
    const sent = lastWrittenJson()
    emitPiLine({
      type: 'response',
      id: sent.id,
      success: true,
      data: { contextUsage: { tokens: 50, contextWindow: 1000, percent: 5 } },
    })
    const result = await p
    expect(result.contextUsage?.tokens).toBe(50)
  })
})
