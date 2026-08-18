import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rpc } from '../ws-client.js'

vi.mock('../port-discovery.js', () => ({
  discoverPort: vi.fn(() => 3210),
}))

/** S1-W1：rpc 现在要求 <dataDir>/runtime-token 存在（token 分发通道②），测试注入临时数据目录 */
const TEST_TOKEN = 'cli-test-token-0123456789abcdef'
let testDataDir = ''

beforeAll(() => {
  testDataDir = mkdtempSync(join(tmpdir(), 'xyz-cli-ws-test.'))
  mkdirSync(testDataDir, { recursive: true })
  writeFileSync(join(testDataDir, 'runtime-token'), TEST_TOKEN)
  process.env.XYZ_AGENT_DATA_DIR = testDataDir
})

afterAll(() => {
  delete process.env.XYZ_AGENT_DATA_DIR
  if (testDataDir) rmSync(testDataDir, { recursive: true, force: true })
})

/** mock WebSocket：EventEmitter 桩（手动 emit open/message 驱动 rpc 状态机） */
let lastMockWs: InstanceType<typeof import('ws').WebSocket> & { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }

vi.mock('ws', () => {
  const EventEmitter = require('events')
  return {
    WebSocket: class extends EventEmitter {
      send = vi.fn()
      close = vi.fn()
      constructor(..._args: unknown[]) {
        super()
        lastMockWs = this as never
      }
    },
  }
})

describe('rpc', () => {
  it('sends message with correct type and payload', async () => {
    // W1: verify WS message format matches runtime expectations
    const promise = rpc('config.getProviders', {})
    // test will fail until ws-client implementation exists (red light)
    expect(promise).toBeInstanceOf(Promise)
  })

  it('S1-W1: open 后首条消息是 auth（携带 token 文件内容），auth ok 后才发实际命令', async () => {
    const promise = rpc('config.getProviders', { extra: 1 })
    // open 触发首条消息
    lastMockWs.emit('open')
    // 首条消息必须是 auth + token 文件内容
    expect(lastMockWs.send).toHaveBeenCalledTimes(1)
    const firstMsg = JSON.parse(String((lastMockWs.send as ReturnType<typeof vi.fn>).mock.calls[0][0]))
    expect(firstMsg).toEqual({ type: 'auth', payload: { token: TEST_TOKEN } })
    // auth.result ok 之前不发实际命令
    lastMockWs.emit('message', Buffer.from(JSON.stringify({ type: 'auth.result', payload: { ok: true } })))
    expect(lastMockWs.send).toHaveBeenCalledTimes(2)
    const secondMsg = JSON.parse(String((lastMockWs.send as ReturnType<typeof vi.fn>).mock.calls[1][0]))
    expect(secondMsg.type).toBe('config.getProviders')
    expect(secondMsg.payload).toEqual({ extra: 1 })
    // reply 到达 → resolve + close
    const replyId = secondMsg.id
    lastMockWs.emit('message', Buffer.from(JSON.stringify({ id: replyId, payload: { providers: [] } })))
    await expect(promise).resolves.toMatchObject({ id: replyId })
    expect(lastMockWs.close).toHaveBeenCalled()
  })

  it('S1-W1: auth 失败（ok=false）时 reject 且不发实际命令', async () => {
    const promise = rpc('config.getProviders', {})
    lastMockWs.emit('open')
    lastMockWs.emit('message', Buffer.from(JSON.stringify({ type: 'auth.result', payload: { ok: false, reason: 'bad_token' } })))
    await expect(promise).rejects.toThrow(/auth failed/)
    // 只发过 auth 一条，业务命令未发出
    expect(lastMockWs.send).toHaveBeenCalledTimes(1)
  })

  it('rejects on timeout', async () => {
    // verify 5s timeout behavior
    await expect(
      rpc('config.getProviders', {}, { timeoutMs: 100 })
    ).rejects.toThrow(/timeout/)
  })
})
