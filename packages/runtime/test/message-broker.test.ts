/**
 * ServerMessageBroker W3 单元测试（U9）。
 *
 * 覆盖 M6：broadcast 单 ws.send 抛错中断其余 client。
 *
 * 场景：
 * - broker 池中有 3 个 ws：ws1（send 抛 Error）、ws2/ws3（send 正常）
 * - 所有 ws.readyState = WebSocket.OPEN
 * - 调 broker.broadcast(msg)
 * - 修复前：ws1.send 抛错，for 循环中断，ws2/ws3 收不到消息
 * - 修复后：ws1 抛错被 try-catch 吞掉，ws2/ws3 正常收到
 *
 * 测试策略：直接构造 broker，注入 mock 的 ClientPool（含 mock ws）和 BrokerServices，
 * 不依赖真实 WebSocket / ConnectionManager。
 */
import { describe, it, expect, vi } from 'vitest'
import { WebSocket } from 'ws'
import type { ClientPool, BrokerServices, ServerMessageBroker as BrokerType } from '../src/transport/message-broker.js'

// ── Mock ws 工厂 ───────────────────────────────────────────────────

/** 构造一个 mock ws：readyState=OPEN，send 为 vi.fn（可配置抛错）。 */
function makeMockWs(opts: { throws?: boolean } = {}): WebSocket {
  const sendFn = opts.throws
    ? vi.fn(() => { throw new Error('connection closed (TOCTOU)') })
    : vi.fn()
  return {
    readyState: WebSocket.OPEN,
    send: sendFn,
  } as unknown as WebSocket
}

// ── Mock BrokerServices（broadcast 不读 services，但构造需要满足类型） ──

const mockServices = {
  sessionService: { listPersistedSessions: () => [] },
  configService: {
    listProviders: () => [],
    getDefaultModel: () => null,
    loadSkills: () => [],
    loadAgents: () => [],
    getSkillDirs: () => [],
    getAgentDirs: () => [],
  },
  modelService: { aggregateModels: () => [] },
  pluginService: undefined,
  extensionService: undefined,
  projectRoot: '/mock',
  appInfo: { appVersion: '0.0.0', piVersion: '0.0.0' },
} as unknown as BrokerServices

// ── Tests ──────────────────────────────────────────────────────────

describe('ServerMessageBroker W3 M6 (broadcast try-catch)', () => {
  it('U9: single ws.send throw does not interrupt broadcast to other clients', async () => {
    const { ServerMessageBroker } = await import('../src/transport/message-broker.js')

    const ws1 = makeMockWs({ throws: true })
    const ws2 = makeMockWs()
    const ws3 = makeMockWs()
    const pool: ClientPool = { clients: new Set([ws1, ws2, ws3]) }

    const broker = new ServerMessageBroker(pool, mockServices)
    const msg = { type: 'session.list', id: 'push_1', payload: { groups: [] } } as unknown as Parameters<BrokerType['broadcast']>[0]

    // broadcast 不应抛错（即使 ws1.send 抛）
    expect(() => broker.broadcast(msg)).not.toThrow()

    // ws2/ws3 的 send 应被调用（未被 ws1 抛错中断）
    expect(vi.mocked(ws2.send)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(ws3.send)).toHaveBeenCalledTimes(1)

    // ws1 也尝试调用了（只是抛错被吞）
    expect(vi.mocked(ws1.send)).toHaveBeenCalledTimes(1)

    // 验证传给 ws2 的 payload 是序列化后的 msg
    const sent2 = vi.mocked(ws2.send).mock.calls[0][0]
    expect(JSON.parse(sent2 as string)).toEqual(msg)
  })

  it('U9b: broadcast with all clients throwing completes without throwing', async () => {
    const { ServerMessageBroker } = await import('../src/transport/message-broker.js')

    const ws1 = makeMockWs({ throws: true })
    const ws2 = makeMockWs({ throws: true })
    const pool: ClientPool = { clients: new Set([ws1, ws2]) }

    const broker = new ServerMessageBroker(pool, mockServices)
    const msg = { type: 'session.list', id: 'push_1', payload: { groups: [] } } as unknown as Parameters<BrokerType['broadcast']>[0]

    // 所有 client 都抛错，broadcast 自身不抛
    expect(() => broker.broadcast(msg)).not.toThrow()
  })
})
