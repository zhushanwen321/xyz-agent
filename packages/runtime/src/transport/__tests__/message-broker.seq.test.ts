/**
 * ServerMessageBroker seq 打点专项测试（P2-s1-w1）。
 *
 * 覆盖：
 * - TC-W1.1: seq 单调递增（连续 broadcast 不同 type 共享同一计数器）
 * - TC-W1.2: 同步连发顺序（Node 单线程原子性，seq 与调用顺序一致）
 * - TC-W1.3: reply 无 seq / sendInitialState 无 seq（只有 broadcast 携带）
 * - TC-W1.5: stringify 失败留 seq 空洞（seq 已自增，本次广播丢弃）
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/__tests__/message-broker.seq.test.ts
 *
 * 测试策略：直接构造 broker，注入 mock ClientPool（mock ws）和 BrokerServices，
 * 不依赖真实 WebSocket / ConnectionManager。MockPool 捕获 ws.send 入参字符串。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WebSocket } from 'ws'
import type { ClientPool, BrokerServices, ServerMessageBroker as BrokerType } from '../message-broker.js'
import type { ConnectionCtx } from '../connection-manager.js'
import type { ServerMessage } from '@xyz-agent/shared'

// ── Mock ws / pool ────────────────────────────────────────────────

/** mock ws：readyState=OPEN，send 为 vi.fn 捕获入参。 */
function makeMockWs(): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
  } as unknown as WebSocket
}

/** 由一组 ws 构造 ClientPool（Map<clientId, ConnectionCtx>）。 */
function poolOf(...wss: WebSocket[]): ClientPool {
  const clients = new Map<string, ConnectionCtx>()
  wss.forEach((ws, i) => {
    clients.set(`client-${i}`, { ws, clientId: `client-${i}`, deviceName: '', connectedAt: 0 })
  })
  return { clients }
}

/** 单 ws 的 pool（最简：仅一个 client，便于断言 send 入参顺序）。 */
function singlePool(ws: WebSocket): ClientPool {
  return poolOf(ws)
}

// ── Mock BrokerServices（reply/sendInitialState 读部分字段） ────────

const mockServices = {
  sessionService: { listPersistedSessions: () => [] },
  configService: {
    listProviders: () => [],
    getDefaultModel: () => null,
    loadSkills: () => [],
    loadAgents: () => [],
    getSkillDirs: () => [],
    getAgentDirs: () => [],
    getExtensionDirs: () => [],
    getSystemPromptConfig: () => ({ config: {}, corrupted: false }),
    getTerminalConfig: () => ({ config: {}, corrupted: false }),
  },
  modelService: { aggregateModels: () => [] },
  pluginService: undefined,
  extensionService: undefined,
  extensionTimeoutMgr: { getAllPendingRequests: () => [] },
  projectRoot: '/mock',
  appInfo: { appVersion: '0.0.0', piVersion: '0.0.0' },
} as unknown as BrokerServices

/** 提取 ws.send 收到的所有消息（JSON.parse）。 */
function sentMessages(ws: WebSocket): Record<string, unknown>[] {
  return vi.mocked(ws.send).mock.calls.map((c) => JSON.parse(c[0] as string))
}

// ── Tests ─────────────────────────────────────────────────────────

describe('ServerMessageBroker seq 打点（P2-s1-w1）', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  // TC-W1.1: seq 单调递增
  it('TC-W1.1: 连续 broadcast 同 type 消息，envelope.seq 依次 1,2,3', async () => {
    const { ServerMessageBroker } = await import('../message-broker.js')
    const ws = makeMockWs()
    const broker = new ServerMessageBroker(singlePool(ws), mockServices)

    broker.broadcast({ type: 'config.sessions', payload: { groups: [] } } as ServerMessage)
    broker.broadcast({ type: 'config.sessions', payload: { groups: [] } } as ServerMessage)
    broker.broadcast({ type: 'config.sessions', payload: { groups: [] } } as ServerMessage)

    const seqs = sentMessages(ws).map((m) => m.seq)
    expect(seqs).toEqual([1, 2, 3])
  })

  it('TC-W1.1b: 不同 type 的 broadcast 共享同一计数器（config.sessions → message.text_delta → session.exited 仍单调）', async () => {
    const { ServerMessageBroker } = await import('../message-broker.js')
    const ws = makeMockWs()
    const broker = new ServerMessageBroker(singlePool(ws), mockServices)

    broker.broadcast({ type: 'config.sessions', payload: { groups: [] } } as ServerMessage)
    broker.broadcast({ type: 'message.text_delta', payload: {} } as unknown as ServerMessage)
    broker.broadcast({ type: 'session.exited', payload: {} } as unknown as ServerMessage)

    const msgs = sentMessages(ws)
    expect(msgs.map((m) => m.seq)).toEqual([1, 2, 3])
    // 各消息仍保留原 type
    expect(msgs.map((m) => m.type)).toEqual(['config.sessions', 'message.text_delta', 'session.exited'])
  })

  // TC-W1.2: 同步连发顺序（Node 单线程原子性）
  it('TC-W1.2: 同步连发 A/B/C，seq 与调用顺序一致，ws.send 调用顺序与 seq 升序一致', async () => {
    const { ServerMessageBroker } = await import('../message-broker.js')
    const ws = makeMockWs()
    const broker = new ServerMessageBroker(singlePool(ws), mockServices)

    broker.broadcast({ type: 'config.providers', payload: { providers: [] }, id: 'A' } as unknown as ServerMessage)
    broker.broadcast({ type: 'config.skills', payload: { skills: [] }, id: 'B' } as unknown as ServerMessage)
    broker.broadcast({ type: 'config.agents', payload: { agents: [] }, id: 'C' } as unknown as ServerMessage)

    const msgs = sentMessages(ws)
    expect(msgs.map((m) => m.seq)).toEqual([1, 2, 3])
    expect(msgs.map((m) => m.id)).toEqual(['A', 'B', 'C']) // 调用顺序保持
  })

  // TC-W1.3: reply 无 seq / sendInitialState 无 seq
  it('TC-W1.3a: reply 发出的消息 JSON 无 seq 字段', async () => {
    const { ServerMessageBroker } = await import('../message-broker.js')
    const ws = makeMockWs()
    const broker = new ServerMessageBroker(singlePool(ws), mockServices)

    broker.reply(ws, 'req-1', 'config.defaults', { defaultModel: 'x/y' } as never)

    const msgs = sentMessages(ws)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].seq).toBeUndefined()
    expect('seq' in msgs[0]).toBe(false) // 不在 envelope 中（undefined 键 stringify 不输出）
  })

  it('TC-W1.3b: sendInitialState 各段 JSON 均无 seq 字段', async () => {
    const { ServerMessageBroker } = await import('../message-broker.js')
    const ws = makeMockWs()
    const broker = new ServerMessageBroker(singlePool(ws), mockServices)

    broker.sendInitialState(ws)

    const msgs = sentMessages(ws)
    expect(msgs.length).toBeGreaterThan(0)
    // 每段都不应携带 seq
    for (const m of msgs) {
      expect(m.seq).toBeUndefined()
      expect('seq' in m).toBe(false)
    }
  })

  it('TC-W1.3c: 先 broadcast（打 seq）再 reply（无 seq），reply 不受 seqCounter 影响', async () => {
    const { ServerMessageBroker } = await import('../message-broker.js')
    const ws = makeMockWs()
    const broker = new ServerMessageBroker(singlePool(ws), mockServices)

    broker.broadcast({ type: 'config.sessions', payload: { groups: [] } } as ServerMessage) // seq=1
    broker.reply(ws, 'req-1', 'config.defaults', { defaultModel: 'x/y' } as never) // 无 seq
    broker.broadcast({ type: 'config.sessions', payload: { groups: [] } } as ServerMessage) // seq=2

    const msgs = sentMessages(ws)
    expect(msgs).toHaveLength(3)
    expect(msgs[0].seq).toBe(1)
    expect(msgs[1].seq).toBeUndefined() // reply 无
    expect(msgs[2].seq).toBe(2) // broadcast 继续递增（reply 没消耗 seq）
  })

  // TC-W1.5: stringify 失败留 seq 空洞
  it('TC-W1.5: cyclic payload 触发 stringify throw，console.error 告警 + 本次无 client 收到 + 下次 broadcast seq 已推进（空洞）', async () => {
    const { ServerMessageBroker } = await import('../message-broker.js')
    const ws = makeMockWs()
    const broker = new ServerMessageBroker(singlePool(ws), mockServices)

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // cyclic payload：JSON.stringify 抛 TypeError
    const cyclic: unknown = {}
    ;(cyclic as Record<string, unknown>).self = cyclic

    // 不应抛出（broadcast 内 catch）
    expect(() =>
      broker.broadcast({ type: 'config.sessions', payload: cyclic } as unknown as ServerMessage),
    ).not.toThrow()

    // 显眼告警
    expect(errSpy).toHaveBeenCalledTimes(1)
    expect(errSpy.mock.calls[0][0]).toContain('[broadcast]')

    // 本次广播丢弃：ws.send 未被调用（seq=1 的消息永不出现在任何客户端）
    expect(vi.mocked(ws.send)).not.toHaveBeenCalled()

    // 下次正常 broadcast 的 seq 是 2（seq=1 已被 cyclic 消耗，形成空洞）
    broker.broadcast({ type: 'config.sessions', payload: { groups: [] } } as ServerMessage)
    const msgs = sentMessages(ws)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].seq).toBe(2) // 空洞 seq=1 永不出现在客户端
  })
})

// ── P3 D3：sendInitialState 第 14 段 extension.pendingRequestsBatch ──

describe('ServerMessageBroker sendInitialState 第 14 段（P3 pending 补发）', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  /** 构造带自定义 extensionTimeoutMgr 的 services（其余字段沿用 mockServices）。 */
  function servicesWithPending(pending: unknown[]): BrokerServices {
    return {
      ...mockServices,
      extensionTimeoutMgr: { getAllPendingRequests: () => pending },
    } as unknown as BrokerServices
  }

  it('TC-W2.1: 第 14 段推送 extension.pendingRequestsBatch（含 pending，点对点无 seq）', async () => {
    const { ServerMessageBroker } = await import('../message-broker.js')
    const ws = makeMockWs()
    const pending = [
      { requestId: 'r1', sessionId: 's1', method: 'select', payload: { title: 'A' }, receivedAt: 1 },
    ]
    const broker = new ServerMessageBroker(singlePool(ws), servicesWithPending(pending))

    broker.sendInitialState(ws)

    const msgs = sentMessages(ws)
    const batch = msgs.find((m) => m.type === 'extension.pendingRequestsBatch')
    expect(batch).toBeDefined()
    expect(batch!.seq).toBeUndefined() // 点对点不打 seq
    expect('seq' in batch!).toBe(false)
    const payload = batch!.payload as { requests: unknown[] }
    expect(payload.requests).toHaveLength(1)
    const req = payload.requests[0] as Record<string, unknown>
    expect(req.requestId).toBe('r1')
    expect(req.sessionId).toBe('s1')
    expect(req.method).toBe('select')
  })

  it('TC-W2.2: 第 14 段 requests 为空时仍推送空数组（非省略段落）', async () => {
    const { ServerMessageBroker } = await import('../message-broker.js')
    const ws = makeMockWs()
    const broker = new ServerMessageBroker(singlePool(ws), servicesWithPending([]))

    broker.sendInitialState(ws)

    const msgs = sentMessages(ws)
    const batch = msgs.find((m) => m.type === 'extension.pendingRequestsBatch')
    expect(batch).toBeDefined()
    const payload = batch!.payload as { requests: unknown[] }
    expect(payload.requests).toEqual([])
  })

  it('TC-W2.3: 第 14 段 getAllPendingRequests 抛错时不阻塞其余段（ES2 容错）', async () => {
    const { ServerMessageBroker } = await import('../message-broker.js')
    const ws = makeMockWs()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const services: BrokerServices = {
      ...mockServices,
      extensionTimeoutMgr: { getAllPendingRequests: () => { throw new Error('boom') } },
    } as unknown as BrokerServices
    const broker = new ServerMessageBroker(singlePool(ws), services)

    // 不应抛错（外层 try/catch 兜底）
    expect(() => broker.sendInitialState(ws)).not.toThrow()

    const msgs = sentMessages(ws)
    // 其余段仍推送（app.info 等同步段）
    expect(msgs.some((m) => m.type === 'app.info')).toBe(true)
    expect(msgs.some((m) => m.type === 'config.sessions')).toBe(true)
    // 第 14 段失败 → 不含 extension.pendingRequestsBatch
    expect(msgs.some((m) => m.type === 'extension.pendingRequestsBatch')).toBe(false)
    // 失败记日志
    expect(errSpy).toHaveBeenCalled()
    const logged = errSpy.mock.calls.map((c) => String(c[0])).join(' ')
    expect(logged).toContain('extension.pendingRequestsBatch')
  })
})
