/**
 * RpcClient.prompt streamingBehavior 透传测试（U1: session-delivery）。
 *
 * 锁定：prompt 调用链对 streamingBehavior 参数的透传契约——
 * - 带 streamingBehavior 时 JSONL 命令含该字段
 * - 不带时字段缺省（不出现 undefined 字符串）
 * - images 与 streamingBehavior 可独立组合
 *
 * mock 策略：mock spawn + readline，断言 stdin.write 收到的 JSON 命令内容。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/rpc-client-streaming-behavior.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

// ── stdin.write 捕获 ──
const writeCalls: unknown[][] = []
const fakeStdin = {
  write: vi.fn((...args: unknown[]) => {
    writeCalls.push(args)
    return true
  }),
  once: vi.fn(),
  end: vi.fn(),
}

// ── readline 接口 mock ──
const rlEmitter = new EventEmitter()
const fakeRl = Object.assign(rlEmitter, {
  close: vi.fn(),
  [Symbol.iterator]: vi.fn(),
})

// ── Mock modules ──
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({
    stdin: fakeStdin,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
    pid: 12345,
    on: vi.fn(),
    removeListener: vi.fn(),
  })),
}))

vi.mock('node:readline', () => ({
  createInterface: vi.fn(() => fakeRl),
}))

vi.mock('../src/infra/pi/pi-paths.js', () => ({
  getSessionsDir: () => '/tmp/fake-sessions',
  getPiAgentDir: () => '/tmp/fake-pi-agent',
}))

vi.mock('../src/infra/pi/pi-provider-store.js', () => ({
  getDefaultModel: () => ({ provider: 'test', modelId: 'test-model' }),
}))

vi.mock('../src/infra/logger.js', () => ({
  createPiSessionLog: () => ({ write: vi.fn(), end: vi.fn() }),
}))

vi.mock('../src/utils/errors.js', () => ({
  RpcTimeoutError: class extends Error {
    constructor(public commandType: string, public timeoutMs: number) {
      super(`RPC timeout: ${commandType}`)
      this.name = 'RpcTimeoutError'
    }
  },
}))

// ── Tests ──
describe('RpcClient.prompt streamingBehavior 透传（U1: session-delivery）', () => {
  let RpcClient: typeof import('../src/infra/pi/rpc-client.js').RpcClient

  beforeEach(async () => {
    vi.clearAllMocks()
    writeCalls.length = 0
    rlEmitter.removeAllListeners()
    const mod = await import('../src/infra/pi/rpc-client.js')
    RpcClient = mod.RpcClient
  })

  /** 从 stdin.write 调用中解析最近一条 JSON 命令 */
  function lastWrittenCommand(): Record<string, unknown> {
    expect(writeCalls.length).toBeGreaterThan(0)
    const raw = writeCalls[writeCalls.length - 1]![0] as string
    return JSON.parse(raw.trim())
  }

  /** 启动 client（跳过 STARTUP_DELAY_MS 等待） */
  async function startClient(): Promise<InstanceType<typeof RpcClient>> {
    const client = new RpcClient({ cwd: '/tmp', sessionId: 'test-sid' })
    const startPromise = client.start()
    await new Promise(r => setTimeout(r, 600))
    await startPromise
    return client
  }

  /** 发 prompt 并返回 stdin.write 捕获的命令 JSON，同时自动发 RPC 响应 */
  async function promptAndCapture(
    client: InstanceType<typeof RpcClient>,
    content: string,
    images?: Array<{ data: string; mimeType: string }>,
    streamingBehavior?: 'steer' | 'followUp',
  ): Promise<Record<string, unknown>> {
    writeCalls.length = 0

    const promptPromise = client.prompt(content, images, streamingBehavior)

    const cmd = lastWrittenCommand()

    // 模拟 pi RPC 响应（通过 readline 接口触发 handleMessage）
    rlEmitter.emit('line', JSON.stringify({ type: 'response', id: cmd.id, success: true }))

    await promptPromise
    return cmd
  }

  it('U1: 不带 streamingBehavior 时字段不出现（非 undefined 字符串）', async () => {
    const client = await startClient()
    const cmd = await promptAndCapture(client, 'hello')

    expect(cmd.type).toBe('prompt')
    expect(cmd.message).toBe('hello')
    expect(cmd).not.toHaveProperty('streamingBehavior')
    expect(cmd).not.toHaveProperty('images')
  })

  it('U1: 带 streamingBehavior="steer" 时字段正确透传', async () => {
    const client = await startClient()
    const cmd = await promptAndCapture(client, 'steer me', undefined, 'steer')

    expect(cmd.type).toBe('prompt')
    expect(cmd.message).toBe('steer me')
    expect(cmd.streamingBehavior).toBe('steer')
    expect(cmd).not.toHaveProperty('images')
  })

  it('U1: 带 streamingBehavior="followUp" 时字段正确透传', async () => {
    const client = await startClient()
    const cmd = await promptAndCapture(client, 'follow up', undefined, 'followUp')

    expect(cmd.type).toBe('prompt')
    expect(cmd.message).toBe('follow up')
    expect(cmd.streamingBehavior).toBe('followUp')
  })

  it('U1: images + streamingBehavior 可独立组合', async () => {
    const client = await startClient()
    const images = [{ data: 'base64data', mimeType: 'image/png' }]
    const cmd = await promptAndCapture(client, 'with image', images, 'steer')

    expect(cmd.type).toBe('prompt')
    expect(cmd.message).toBe('with image')
    expect(cmd.images).toEqual([{ type: 'image', data: 'base64data', mimeType: 'image/png' }])
    expect(cmd.streamingBehavior).toBe('steer')
  })

  it('U1: 空 images 数组不传 images 字段 + streamingBehavior 仍透传', async () => {
    const client = await startClient()
    const cmd = await promptAndCapture(client, 'no images', [], 'followUp')

    expect(cmd.type).toBe('prompt')
    expect(cmd.message).toBe('no images')
    expect(cmd).not.toHaveProperty('images')
    expect(cmd.streamingBehavior).toBe('followUp')
  })

  it('U2: 端口签名 arity——prompt 接受 3 个参数（content, images?, streamingBehavior?）', () => {
    // 编译期类型测试：IPiEngine.prompt 的参数数量由 TypeScript 保证，
    // 运行期断言 RpcClient.prompt 的 length（3 = content + images + streamingBehavior）
    const client = new RpcClient({ cwd: '/tmp', sessionId: 'arity-check' })
    // prompt.length 是声明参数数（不含有默认值的参数），3 个参数 = arity 3
    expect(client.prompt.length).toBe(3)
  })

  it('U2: 端口签名 arity——只传 images 不传 streamingBehavior 时，images 透传但 streamingBehavior 不出现', async () => {
    const client = await startClient()
    const images = [{ data: 'img', mimeType: 'image/jpeg' }]
    const cmd = await promptAndCapture(client, 'image only', images)

    expect(cmd.type).toBe('prompt')
    expect(cmd.message).toBe('image only')
    expect(cmd.images).toEqual([{ type: 'image', data: 'img', mimeType: 'image/jpeg' }])
    expect(cmd).not.toHaveProperty('streamingBehavior')
  })
})
