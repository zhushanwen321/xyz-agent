/**
 * ServerMessageBroker 分桶 + 回放专项测试（P2-s1-w2 / TK-W2.4）。
 *
 * 覆盖 12 个 testCases（plan.json）：
 * - TC-W2.1: per-session 分桶路由（payload.sessionId 动态判定 + 全局消息不入桶）
 * - TC-W2.2: 入桶 data 是 stringify 一次的产物（零再序列化，与 ws.send 入参 ===）
 * - TC-W2.3: 条数双限 LRU 驱逐（env 注入小 maxCount，删头推进 watermark）
 * - TC-W2.4: 字节双限 LRU 驱逐（env 注入小 maxBytes，删头扣减 bytes）
 * - TC-W2.5: 巨消息豁免（单条 > maxBytes 不入桶不推进 watermark）
 * - TC-W2.6: terminal.data 打 seq 但不入 session 桶
 * - TC-W2.7: 无 sessionId 全局消息不入桶
 * - TC-W2.8: getReplayPlan bootId 不匹配 → reset
 * - TC-W2.9: getReplayPlan lastSeq < watermark → reset；边界 = watermark → resume
 * - TC-W2.10: subscribedSessions 过滤 + 多桶按全局 seq 升序合并
 * - TC-W2.11: 无缺失返回 resume 空数组（三态区分）
 * - TC-W2.12: clearSessionBuffer 整桶移除不推进 watermark
 * - TC-W1.4 补强：多客户端 fan-out 收到相同 seq + 相同字符串
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/__tests__/message-broker.replay.test.ts
 *
 * 测试策略：直接构造 broker，注入 mock ClientPool + BrokerServices（复用 w1 seq.test.ts 模式）。
 * env 注入用 vi.stubEnv（vitest 原生，beforeEach/afterEach 自动管理）。
 * MockPool 捕获 ws.send 入参字符串，断言与 getReplayPlan 返回 === 严格相等（零再序列化）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import type { ClientPool, BrokerServices, ServerMessageBroker as BrokerType } from '../message-broker.js'
import type { ConnectionCtx } from '../connection-manager.js'
import type { ServerMessage } from '@xyz-agent/shared'

// ── Mock ws / pool（与 message-broker.seq.test.ts 同款） ────────────

function makeMockWs(): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
  } as unknown as WebSocket
}

function poolOf(...wss: WebSocket[]): ClientPool {
  const clients = new Map<string, ConnectionCtx>()
  wss.forEach((ws, i) => {
    clients.set(`client-${i}`, { ws, clientId: `client-${i}`, deviceName: '', connectedAt: 0 })
  })
  return { clients }
}

function singlePool(ws: WebSocket): ClientPool {
  return poolOf(ws)
}

// ── Mock BrokerServices（reply/sendInitialState 不在本测试用，最小集即可） ──

const mockServices = {
  sessionService: { listPersistedSessions: () => [] },
  configService: {
    listProviders: () => [], getConfigVersion: () => 0,
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

/** 构造一条带 sessionId 的 session 级 ServerMessage。 */
function sessionMsg(type: string, sessionId: string, extra: Record<string, unknown> = {}): ServerMessage {
  return { type, payload: { sessionId, ...extra } } as unknown as ServerMessage
}

// ── Tests ─────────────────────────────────────────────────────────

describe('ServerMessageBroker 分桶 + 回放（P2-s1-w2）', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  // ── TC-W2.1: per-session 分桶路由 ───────────────────────────────

  it('TC-W2.1: 不同 sessionId 各入对应桶、互不干扰；无 sessionId 全局消息不入桶；广播不受影响', async () => {
    const { ServerMessageBroker } = await import('../message-broker.js')
    const ws = makeMockWs()
    const broker = new ServerMessageBroker(singlePool(ws), mockServices)

    broker.broadcast(sessionMsg('message.text_delta', 'A'))
    broker.broadcast(sessionMsg('message.text_delta', 'B'))
    broker.broadcast(sessionMsg('message.text_delta', 'A'))
    broker.broadcast({ type: 'config.sessions', payload: { groups: [] } } as ServerMessage) // 无 sessionId

    // A 桶 2 条，seq 升序
    const bufA = broker.getSessionBuffer('A')!
    expect(bufA).toBeDefined()
    expect(bufA.entries.map((e) => e.seq)).toEqual([1, 3])

    // B 桶 1 条
    const bufB = broker.getSessionBuffer('B')!
    expect(bufB).toBeDefined()
    expect(bufB.entries.map((e) => e.seq)).toEqual([2])

    // A/B 互不干扰
    expect(bufA.size).toBe(2)
    expect(bufB.size).toBe(1)

    // config.sessions 无 sessionId，不为它建桶
    expect(broker.getSessionBuffer('config.sessions')).toBeUndefined()

    // ws.send 仍发出全部 4 条（入桶不影响广播）
    expect(sentMessages(ws)).toHaveLength(4)
  })

  // ── TC-W2.2: 零再序列化（data 与 ws.send 入参 ===） ──────────────

  it('TC-W2.2: getReplayPlan 返回的 messages[0] 是字符串，与 ws.send 入参 === 严格相等（零再序列化）', async () => {
    const { ServerMessageBroker } = await import('../message-broker.js')
    const ws = makeMockWs()
    const broker = new ServerMessageBroker(singlePool(ws), mockServices)

    broker.broadcast(sessionMsg('message.start', 'A'))

    const plan = broker.getReplayPlan(0, broker.getBootId(), ['A'])
    expect(plan.kind).toBe('resume')
    if (plan.kind !== 'resume') return

    expect(plan.messages).toHaveLength(1)
    expect(typeof plan.messages[0]).toBe('string')
    // JSON.parse 出来 seq === 1
    expect(JSON.parse(plan.messages[0]).seq).toBe(1)
    // 与 ws.send 收到的入参字符串严格相等（证实复用同一 stringify 产物）
    const wsSentPayload = vi.mocked(ws.send).mock.calls[0][0] as string
    expect(plan.messages[0]).toBe(wsSentPayload)
  })

  // ── TC-W2.3: 条数双限 LRU 驱逐 ──────────────────────────────────

  it('TC-W2.3: env maxCount=3，连发 4 条，头部 seq=1 被驱逐，evictedWatermark 推进到 1，bytes 同步扣减', async () => {
    vi.stubEnv('XYZ_AGENT_REPLAY_MAX_MESSAGES_PER_SESSION', '3')
    // 动态 import 确保读到 stubbed env（broker 构造期读 env）
    const { ServerMessageBroker } = await import('../message-broker.js')
    const ws = makeMockWs()
    const broker = new ServerMessageBroker(singlePool(ws), mockServices)

    broker.broadcast(sessionMsg('message.text_delta', 'A', { d: 1 }))
    broker.broadcast(sessionMsg('message.text_delta', 'A', { d: 2 }))
    broker.broadcast(sessionMsg('message.text_delta', 'A', { d: 3 }))
    broker.broadcast(sessionMsg('message.text_delta', 'A', { d: 4 }))

    const bufA = broker.getSessionBuffer('A')!
    expect(bufA.entries.map((e) => e.seq)).toEqual([2, 3, 4]) // seq=1 被驱逐
    expect(bufA.size).toBe(3)
    // watermark 推进到被驱逐的 seq=1
    expect(broker.getEvictedWatermark()).toBe(1)
    // bytes 已扣减驱逐条（= 剩 3 条长度之和）
    const expectedBytes = bufA.entries.reduce((sum, e) => sum + e.data.length, 0)
    expect(bufA.bytes).toBe(expectedBytes)
  })

  // ── TC-W2.4: 字节双限 LRU 驱逐 ──────────────────────────────────

  it('TC-W2.4: env maxBytes=100，连发 5 条累计超限，从头部删到 bytes<=100，watermark 推进', async () => {
    vi.stubEnv('XYZ_AGENT_REPLAY_MAX_BYTES_PER_SESSION', '100')
    const { ServerMessageBroker } = await import('../message-broker.js')
    const ws = makeMockWs()
    const broker = new ServerMessageBroker(singlePool(ws), mockServices)

    // 每条 ~40+B（message.text_delta envelope），5 条累计超 100B 触发驱逐
    for (let i = 1; i <= 5; i++) {
      broker.broadcast(sessionMsg('message.text_delta', 'A', { chunk: `payload-${i}-data` }))
    }

    const bufA = broker.getSessionBuffer('A')!
    expect(bufA.bytes).toBeLessThanOrEqual(100)
    // 尾部最新条一定保留（驱逐只删头部）
    expect(bufA.entries[bufA.entries.length - 1].seq).toBe(5)
    // 头部若干条被驱逐 → watermark 推进到首个被驱逐的 seq
    expect(broker.getEvictedWatermark()).toBeGreaterThan(0)
  })

  // ── TC-W2.5: 巨消息豁免 ─────────────────────────────────────────

  it('TC-W2.5: 单条 > maxBytes 不入桶、不推进 watermark，仍正常广播，后续小消息仍能入桶', async () => {
    // 选 maxBytes=120：message.text_delta envelope 框架（type+payload.sessionId+seq）约 77B，
    // 正常小消息 <= 120 能入桶；下面构造的巨消息（200+ 字节）> 120 被豁免。
    vi.stubEnv('XYZ_AGENT_REPLAY_MAX_BYTES_PER_SESSION', '120')
    const { ServerMessageBroker } = await import('../message-broker.js')
    const ws = makeMockWs()
    const broker = new ServerMessageBroker(singlePool(ws), mockServices)

    // 构造一条 stringify 后 data.length > 120 的巨消息
    const huge = sessionMsg('message.text_delta', 'A', { big: 'x'.repeat(200) })
    broker.broadcast(huge)
    expect(JSON.stringify({ ...huge, seq: 1 }).length).toBeGreaterThan(120) // 确认确实是巨消息

    // 巨消息不入桶：A 桶不存在或为空
    const bufA = broker.getSessionBuffer('A')
    expect(bufA).toBeUndefined() // 第一条就是巨消息，桶从未建立

    // ws.send 仍发出（广播不受影响）
    expect(sentMessages(ws)).toHaveLength(1)

    // 不推进 watermark（巨消息豁免不算驱逐，ES4）
    expect(broker.getEvictedWatermark()).toBe(0)

    // 后续正常小消息仍能入 A 桶（envelope ~77B <= 120）
    broker.broadcast(sessionMsg('message.text_delta', 'A', { small: 'y' }))
    const bufA2 = broker.getSessionBuffer('A')!
    expect(bufA2).toBeDefined()
    expect(bufA2.size).toBe(1)
  })

  // ── TC-W2.6: terminal.data 打 seq 但不入 session 桶 ──────────────

  it('TC-W2.6: terminal.data 打 seq 正常递增 + ws.send 发出，但不入 session 桶（D3 排除）', async () => {
    const { ServerMessageBroker } = await import('../message-broker.js')
    const ws = makeMockWs()
    const broker = new ServerMessageBroker(singlePool(ws), mockServices)

    broker.broadcast(sessionMsg('terminal.data', 'A', { data: 'hello' }))
    broker.broadcast(sessionMsg('message.text_delta', 'A', { text: 'world' }))

    // 两条 ws.send 都收到，seq 依次 1,2（terminal.data 也打 seq）
    const msgs = sentMessages(ws)
    expect(msgs.map((m) => m.seq)).toEqual([1, 2])
    expect(msgs.map((m) => m.type)).toEqual(['terminal.data', 'message.text_delta'])

    // A 桶只有 message.text_delta 一条（terminal.data 被排除）
    const bufA = broker.getSessionBuffer('A')!
    expect(bufA.size).toBe(1)
    expect(bufA.entries[0].seq).toBe(2)

    // getReplayPlan 查 A 桶只返回 message.text_delta
    const plan = broker.getReplayPlan(0, broker.getBootId(), ['A'])
    expect(plan.kind).toBe('resume')
    if (plan.kind === 'resume') {
      expect(plan.messages).toHaveLength(1)
      expect(JSON.parse(plan.messages[0]).type).toBe('message.text_delta')
    }
  })

  // ── TC-W2.7: 无 sessionId 全局消息不入桶 ────────────────────────

  it('TC-W2.7: config.sessions/providers、model.list 等全局消息不入桶，仍正常广播，seq 单调', async () => {
    const { ServerMessageBroker } = await import('../message-broker.js')
    const ws = makeMockWs()
    const broker = new ServerMessageBroker(singlePool(ws), mockServices)

    broker.broadcast({ type: 'config.sessions', payload: { groups: [] } } as ServerMessage)
    broker.broadcast({ type: 'config.providers', payload: { providers: [] } } as ServerMessage)
    broker.broadcast({ type: 'model.list', payload: { models: [] } } as ServerMessage)

    // 三条 ws.send 都收到，seq 单调递增
    const msgs = sentMessages(ws)
    expect(msgs).toHaveLength(3)
    expect(msgs.map((m) => m.seq)).toEqual([1, 2, 3])

    // 无任何桶被创建（全局消息不入桶，ES1）
    expect(broker.getSessionBuffer('config.sessions')).toBeUndefined()
    expect(broker.getSessionBuffer('config.providers')).toBeUndefined()
    expect(broker.getSessionBuffer('model.list')).toBeUndefined()

    // getReplayPlan 任意 subscribedSessions 返回 resume + 空（不抛异常）
    const plan = broker.getReplayPlan(0, broker.getBootId(), ['any-session'])
    expect(plan).toEqual({ kind: 'resume', messages: [] })
  })

  // ── TC-W2.8: getReplayPlan bootId 不匹配 → reset ─────────────────

  it('TC-W2.8: bootId 不匹配 → reset（短路返回，不遍历桶）', async () => {
    const { ServerMessageBroker } = await import('../message-broker.js')
    const ws = makeMockWs()
    const broker = new ServerMessageBroker(singlePool(ws), mockServices)

    broker.broadcast(sessionMsg('message.text_delta', 'A'))

    const plan = broker.getReplayPlan(0, 'wrong-boot-id', ['A'])
    expect(plan).toEqual({ kind: 'reset' })
  })

  // ── TC-W2.9: lastSeq < watermark → reset；边界 = watermark → resume ─

  it('TC-W2.9: maxCount=3 连发 5 条（watermark=2），lastSeq<2 reset / =2 resume / >2 resume', async () => {
    vi.stubEnv('XYZ_AGENT_REPLAY_MAX_MESSAGES_PER_SESSION', '3')
    const { ServerMessageBroker } = await import('../message-broker.js')
    const ws = makeMockWs()
    const broker = new ServerMessageBroker(singlePool(ws), mockServices)

    for (let i = 1; i <= 5; i++) broker.broadcast(sessionMsg('message.text_delta', 'A', { i }))

    // 桶内 seq 3,4,5；驱逐 seq 1,2 → watermark=2
    expect(broker.getEvictedWatermark()).toBe(2)
    const bootId = broker.getBootId()

    // lastSeq=1 < watermark=2 → reset
    expect(broker.getReplayPlan(1, bootId, ['A'])).toEqual({ kind: 'reset' })

    // lastSeq=2 === watermark=2 → resume（边界：watermark 是被驱逐 seq，等于意味着 lastSeq 指向最后被驱逐的，之后的都在桶内）
    const plan2 = broker.getReplayPlan(2, bootId, ['A'])
    expect(plan2.kind).toBe('resume')

    // lastSeq=3 > watermark=2 → resume
    const plan3 = broker.getReplayPlan(3, bootId, ['A'])
    expect(plan3.kind).toBe('resume')
  })

  // ── TC-W2.10: subscribedSessions 过滤 + 多桶合并 ─────────────────

  it('TC-W2.10: A/B/C 各有消息（seq 交错），订阅 A+B 只回放 A/B 桶按全局 seq 升序合并，C 不被波及', async () => {
    const { ServerMessageBroker } = await import('../message-broker.js')
    const ws = makeMockWs()
    const broker = new ServerMessageBroker(singlePool(ws), mockServices)

    broker.broadcast(sessionMsg('message.text_delta', 'A')) // seq=1
    broker.broadcast(sessionMsg('message.text_delta', 'B')) // seq=2
    broker.broadcast(sessionMsg('message.text_delta', 'C')) // seq=3
    broker.broadcast(sessionMsg('message.text_delta', 'A')) // seq=4
    broker.broadcast(sessionMsg('message.text_delta', 'B')) // seq=5

    // C 桶存在（getSessionBuffer 非空）
    expect(broker.getSessionBuffer('C')!.size).toBe(1)

    // 只订阅 A+B
    const plan = broker.getReplayPlan(0, broker.getBootId(), ['A', 'B'])
    expect(plan.kind).toBe('resume')
    if (plan.kind !== 'resume') return

    // messages.length === 4（A 两条 seq=1,4 + B 两条 seq=2,5；C 的 seq=3 被订阅过滤排除）
    expect(plan.messages).toHaveLength(4)

    // 各条 seq 升序为 [1,2,4,5]（多桶合并按全局 seq 升序，无交错）
    const seqs = plan.messages.map((d) => JSON.parse(d).seq)
    expect(seqs).toEqual([1, 2, 4, 5])
  })

  // ── TC-W2.11: 无缺失返回 resume 空数组 ───────────────────────────

  it('TC-W2.11: lastSeq 已是最大 seq，订阅桶无 seq>lastSeq，返回 resume + 空数组', async () => {
    const { ServerMessageBroker } = await import('../message-broker.js')
    const ws = makeMockWs()
    const broker = new ServerMessageBroker(singlePool(ws), mockServices)

    broker.broadcast(sessionMsg('message.text_delta', 'A')) // seq=1
    broker.broadcast(sessionMsg('message.text_delta', 'A')) // seq=2

    // lastSeq=2 已是最大，无缺失
    const plan = broker.getReplayPlan(2, broker.getBootId(), ['A'])
    expect(plan).toEqual({ kind: 'resume', messages: [] }) // 空数组语义=客户端已最新
  })

  // ── TC-W2.12: clearSessionBuffer 整桶移除不推进 watermark ─────────

  it('TC-W2.12: clearSessionBuffer 删桶 + watermark 不变 + 不存在 sid no-op + 新消息重建空桶', async () => {
    const { ServerMessageBroker } = await import('../message-broker.js')
    const ws = makeMockWs()
    const broker = new ServerMessageBroker(singlePool(ws), mockServices)

    broker.broadcast(sessionMsg('message.text_delta', 'A')) // seq=1
    broker.broadcast(sessionMsg('message.text_delta', 'A')) // seq=2
    broker.broadcast(sessionMsg('message.text_delta', 'A')) // seq=3

    const wmBefore = broker.getEvictedWatermark()

    // clearSessionBuffer('A') 删桶
    broker.clearSessionBuffer('A')
    expect(broker.getSessionBuffer('A')).toBeUndefined()

    // watermark 不变（ES6：session 销毁不推进 watermark）
    expect(broker.getEvictedWatermark()).toBe(wmBefore)

    // clearSessionBuffer('不存在的sid') 不抛异常（no-op）
    expect(() => broker.clearSessionBuffer('nonexistent')).not.toThrow()

    // 再 broadcast A 后新桶建立，entries 只有新 seq 一条（旧条不恢复）
    broker.broadcast(sessionMsg('message.text_delta', 'A')) // seq=4
    const bufA = broker.getSessionBuffer('A')!
    expect(bufA.size).toBe(1)
    expect(bufA.entries[0].seq).toBe(4)
  })

  // ── TC-W1.4 补强：多客户端 fan-out 同 seq + 同字符串 ──────────────

  it('TC-W1.4 补强: poolOf 2 个 ws，broadcast 一次，两 ws.send 入参字符串 === 严格相等且 seq 相同', async () => {
    const { ServerMessageBroker } = await import('../message-broker.js')
    const ws1 = makeMockWs()
    const ws2 = makeMockWs()
    const broker = new ServerMessageBroker(poolOf(ws1, ws2), mockServices)

    broker.broadcast(sessionMsg('message.text_delta', 'A'))

    const sent1 = vi.mocked(ws1.send).mock.calls[0][0] as string
    const sent2 = vi.mocked(ws2.send).mock.calls[0][0] as string

    // 两客户端收到完全相同的字符串（循环外 stringify 一次，fan-out 同一产物）
    expect(sent1).toBe(sent2)
    // seq 相同
    expect(JSON.parse(sent1).seq).toBe(JSON.parse(sent2).seq)
    expect(JSON.parse(sent1).seq).toBe(1)
  })
})
