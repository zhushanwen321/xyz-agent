/**
 * RpcClient systemPrompt CLI 参数单测（TDD 红灯）。
 *
 * mock node:child_process spawn，捕获传给 pi 的 args，断言：
 * - systemPrompt 有值 → args 包含 '--system-prompt' 且后紧跟该值
 * - systemPrompt 空白 → 不包含 '--system-prompt'
 * - systemPrompt 未传 → 不包含 '--system-prompt'
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RpcClientOptions } from '../src/infra/pi/rpc-client.js'

let spawnArgs: string[] = []

const fakeProc = {
  on: vi.fn((_event: string, _handler: (...args: unknown[]) => void) => fakeProc),
  off: vi.fn(),
  removeListener: vi.fn(),
  stdout: {
    on: vi.fn(),
    resume: vi.fn(),
    destroy: vi.fn(),
  },
  stderr: { on: vi.fn() },
  stdin: {
    write: vi.fn(),
    once: vi.fn(),
  },
  kill: vi.fn(),
  pid: 12345,
}

vi.mock('node:child_process', () => ({
  spawn: vi.fn((_cmd: string, args: readonly string[]) => {
    spawnArgs = [...args]
    return fakeProc
  }),
}))

vi.mock('node:readline', () => ({
  createInterface: () => ({
    on: vi.fn(),
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

describe('RpcClient systemPrompt CLI arg', () => {
  let RpcClientCtor: typeof import('../src/infra/pi/rpc-client.js').RpcClient

  beforeEach(async () => {
    spawnArgs = []
    fakeProc.on.mockClear()
    fakeProc.stdin.write.mockClear()
    fakeProc.kill.mockClear()

    const mod = await import('../src/infra/pi/rpc-client.js')
    RpcClientCtor = mod.RpcClient
  })

  afterEach(async () => {
    // 不 kill 也可以；如 kill 被调用，触发 exit 让清理逻辑走通
    try {
      const exitHandlers = fakeProc.on.mock.calls
        .filter(([event]) => event === 'exit')
        .map(([, handler]) => handler as (code: number | null) => void)
      for (const h of exitHandlers) {
        h(0)
      }
    } catch {
      // ignore cleanup errors
    }
  })

  it('options.systemPrompt 有值 → args 包含 --system-prompt 和该值', async () => {
    const options = { cwd: '/project', systemPrompt: 'custom core prompt' } as unknown as RpcClientOptions
    const client = new RpcClientCtor(options)
    await client.start()

    expect(spawnArgs).toContain('--system-prompt')
    const idx = spawnArgs.indexOf('--system-prompt')
    expect(spawnArgs[idx + 1]).toBe('custom core prompt')
  })

  it('options.systemPrompt 仅空白 → args 不包含 --system-prompt', async () => {
    const options = { cwd: '/project', systemPrompt: '   \t\n  ' } as unknown as RpcClientOptions
    const client = new RpcClientCtor(options)
    await client.start()

    expect(spawnArgs).not.toContain('--system-prompt')
  })

  it('options.systemPrompt 未传 → args 不包含 --system-prompt', async () => {
    const options = { cwd: '/project' } as unknown as RpcClientOptions
    const client = new RpcClientCtor(options)
    await client.start()

    expect(spawnArgs).not.toContain('--system-prompt')
  })
})
