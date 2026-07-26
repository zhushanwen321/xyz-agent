/**
 * RpcClient bash/abortBash 透传测试（composer-bash-execute W1）。
 *
 * 锁定：
 * - bash(command, excludeFromContext) → sendCommand('bash', {command[, excludeFromContext]})，
 *   excludeFromContext undefined 时不传该键（走 pi 默认），显式 true/false 时透传。
 * - 返回值归一为 PiBashResult（sendCommand 已归一 data ?? payload）。
 * - abortBash() → sendCommand('abort_bash')，无参数。
 *
 * 策略：RpcClient.sendCommand 是 protected，无法直接 spy。沿用 test/rpc-client.test.ts 的
 * mock node:child_process + readline 模式——捕获 stdin 写入的命令结构 + 投递伪造 pi response
 * 驱动 pending resolve。这样测的是真实 bash/abortBash 方法（不绕过实现）。
 *
 * 运行：npx vitest run src/__tests__/rpc-client-bash.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RpcClient } from '../infra/pi/rpc-client.js'

// ── Mocks（与 test/rpc-client.test.ts 同构）──────────────────────

const stdinWrites: string[] = []
let stdoutLineHandler: ((line: string) => void) | null = null
let procExitHandlers: Array<(code: number | null) => void> = []

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

vi.mock('node:child_process', () => ({ spawn: () => fakeProc }))

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

vi.mock('@xyz-agent/shared/paths', () => ({ getDataDir: () => '/mock/home/.xyz-agent' }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => '/mock/home' }
})

vi.mock('../infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/pi/pi-paths.js')>()
  return {
    ...actual,
    getSessionsDir: () => '/mock/home/.xyz-agent/sessions',
    getPiAgentDir: () => '/mock/home/.xyz-agent/pi/agent',
  }
})

vi.mock('../infra/pi/pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/pi/pi-provider-store.js')>()
  return { ...actual, getDefaultModel: () => null }
})

vi.mock('../infra/logger.js', () => ({
  createPiSessionLog: () => ({ write: vi.fn(), end: vi.fn() }),
}))

// ── Helpers ──────────────────────────────────────────────────────

function emitPiLine(obj: Record<string, unknown>): void {
  if (!stdoutLineHandler) throw new Error('stdout line handler not registered yet')
  stdoutLineHandler(JSON.stringify(obj))
}

function lastWrittenJson(): Record<string, unknown> {
  const last = stdinWrites[stdinWrites.length - 1]
  return JSON.parse(last)
}

// ── Tests ────────────────────────────────────────────────────────

describe('RpcClient bash/abortBash 透传', () => {
  let client: RpcClient

  beforeEach(async () => {
    stdinWrites.length = 0
    stdoutLineHandler = null
    procExitHandlers = []
    fakeProc.on.mockClear()
    fakeProc.stdin.write.mockClear()

    const { RpcClient } = await import('../infra/pi/rpc-client.js')
    client = new RpcClient({ cwd: '/project' })
    await client.start()
  })

  afterEach(async () => {
    try { await client.kill() } catch { /* noop */ }
    procExitHandlers = []
  })

  // T1: bash(command, false) → sendCommand('bash', {command, excludeFromContext:false})
  it('T1: bash("git status", false) → 写入 {type:"bash", command, excludeFromContext:false} + 返回值归一为 PiBashResult', async () => {
    const resultPromise = client.bash('git status', false)
    await Promise.resolve()

    const sent = lastWrittenJson()
    expect(sent.type).toBe('bash')
    expect(sent.command).toBe('git status')
    expect(sent.excludeFromContext).toBe(false)

    // pi 回 success + data（PiBashResult 结构），归一后应原样返回
    emitPiLine({
      type: 'response',
      id: sent.id,
      success: true,
      data: { output: 'nothing to commit', exitCode: 0, cancelled: false, truncated: false },
    })

    const result = await resultPromise
    expect(result).toEqual({
      output: 'nothing to commit',
      exitCode: 0,
      cancelled: false,
      truncated: false,
    })
  })

  // T2: bash(command) 不传第二参 → params 不含 excludeFromContext 键
  it('T2: bash("pwd") 不传 excludeFromContext → 写入的 params 不含 excludeFromContext 键', async () => {
    const resultPromise = client.bash('pwd')
    await Promise.resolve()

    const sent = lastWrittenJson()
    expect(sent.type).toBe('bash')
    expect(sent.command).toBe('pwd')
    // 关键：键不存在，走 pi 默认
    expect(sent).not.toHaveProperty('excludeFromContext')

    // 让 pending resolve
    emitPiLine({
      type: 'response',
      id: sent.id,
      success: true,
      data: { output: '/project', exitCode: 0, cancelled: false, truncated: false },
    })
    const result = await resultPromise
    expect(result.output).toBe('/project')
  })

  // T3: abortBash() → sendCommand('abort_bash')，无业务参数
  it('T3: abortBash() → 写入 {type:"abort_bash"}（无 command 等业务参数）', async () => {
    const resultPromise = client.abortBash()
    await Promise.resolve()

    const sent = lastWrittenJson()
    expect(sent.type).toBe('abort_bash')
    // abort_bash 无业务参数（不传 command）
    expect(sent).not.toHaveProperty('command')

    // 让 pending resolve
    emitPiLine({ type: 'response', id: sent.id, success: true, data: {} })
    await resultPromise
  })

  // T3b: bash(command, true) → excludeFromContext 透传 true（覆盖显式 true 分支）
  it('T3b: bash("ls", true) → 写入 excludeFromContext:true（显式 true 透传）', async () => {
    const resultPromise = client.bash('ls', true)
    await Promise.resolve()

    const sent = lastWrittenJson()
    expect(sent.excludeFromContext).toBe(true)

    emitPiLine({
      type: 'response',
      id: sent.id,
      success: true,
      data: { output: 'a\n', exitCode: 0, cancelled: false, truncated: false },
    })
    await resultPromise
  })
})
