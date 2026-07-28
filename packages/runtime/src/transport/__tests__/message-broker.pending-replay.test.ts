/**
 * 审批挂起重连唤醒 mock e2e 测试（P3 s2 AC7）。
 *
 * 覆盖：
 * - TC-AC7: mgr.cachePendingRequest 挂起审批 → 真实 ServerMessageBroker.sendInitialState 第 14 段
 *           推送 extension.pendingRequestsBatch 含 pending → 模拟响应 removePendingRequest →
 *           再次 sendInitialState 推送空数组（已响应不再补发）
 *
 * 这是契约级 e2e：真实 broker + 真实 ExtensionTimeoutManager（不 mock 被测逻辑），
 * 仅 mock 外围 ws + BrokerServices。固化 spec §三表「审批挂起重连唤醒」契约。
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/__tests__/message-broker.pending-replay.test.ts
 *
 * 复用 message-broker.seq.test.ts 的 makeMockWs / poolOf / mockServices 范式（已成熟）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WebSocket } from 'ws'
import type { ClientPool, BrokerServices } from '../message-broker.js'
import type { ConnectionCtx } from '../connection-manager.js'
import { ExtensionTimeoutManager } from '../../services/extension-timeout-manager.js'

// ── Mock ws / pool（复用 message-broker.seq.test.ts 范式）────────

function makeMockWs(): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
  } as unknown as WebSocket
}

function singlePool(ws: WebSocket): ClientPool {
  const clients = new Map<string, ConnectionCtx>()
  clients.set('client-1', { ws, clientId: 'client-1', deviceName: '', connectedAt: 0 })
  return { clients }
}

// ── Mock BrokerServices（getAllPendingRequests 由真实 mgr 注入）──

function makeBaseServices(mgr: ExtensionTimeoutManager): BrokerServices {
  return {
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
    extensionTimeoutMgr: mgr,
    projectRoot: '/mock',
    appInfo: { appVersion: '0.0.0', piVersion: '0.0.0' },
  } as unknown as BrokerServices
}

function sentMessages(ws: WebSocket): Record<string, unknown>[] {
  return vi.mocked(ws.send).mock.calls.map((c) => JSON.parse(c[0] as string))
}

// ── Tests ─────────────────────────────────────────────────────────

describe('P3 s2 AC7: 审批挂起重连唤醒（mock e2e）', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('TC-AC7: 挂起审批 → 新客户端 sendInitialState 收 extension.pendingRequestsBatch → 响应后清空', async () => {
    const { ServerMessageBroker } = await import('../message-broker.js')
    const mgr = new ExtensionTimeoutManager()
    const broker = new ServerMessageBroker(singlePool(makeMockWs()), makeBaseServices(mgr))

    // ① 模拟 pi 挂起 extension 审批请求（onExtensionUIRequest → cachePendingRequest 链路）
    mgr.cachePendingRequest('s1', 'r1', 'select', { title: '选择执行分支', options: ['main', 'dev'] })

    // ② 冷启动新客户端（新 ws）：sendInitialState 应推送第 14 段含 r1
    const newWs = makeMockWs()
    broker.sendInitialState(newWs)

    const initMsgs = sentMessages(newWs)
    const batchBefore = initMsgs.find((m) => m.type === 'extension.pendingRequestsBatch')
    expect(batchBefore).toBeDefined()
    // 点对点不打 seq（与 s1 w2 TC-W2.1 一致）
    expect('seq' in batchBefore!).toBe(false)
    const payloadBefore = batchBefore!.payload as { requests: Array<Record<string, unknown>> }
    expect(payloadBefore.requests).toHaveLength(1)
    const req = payloadBefore.requests[0]
    expect(req.requestId).toBe('r1')
    expect(req.sessionId).toBe('s1')
    expect(req.method).toBe('select')

    // ③ 模拟用户在客户端响应审批（extension.ui_response → removePendingRequest 链路）
    mgr.removePendingRequest('s1', 'r1')

    // ④ 第二个客户端冷启动：sendInitialState 第 14 段应为空数组（已响应不再补发）
    const anotherWs = makeMockWs()
    broker.sendInitialState(anotherWs)

    const afterMsgs = sentMessages(anotherWs)
    const batchAfter = afterMsgs.find((m) => m.type === 'extension.pendingRequestsBatch')
    expect(batchAfter).toBeDefined()
    const payloadAfter = batchAfter!.payload as { requests: unknown[] }
    expect(payloadAfter.requests).toEqual([])
  })

  it('TC-AC7b: 跨 session 多条挂起审批 → getAllPendingRequests 聚合全量补发', async () => {
    const { ServerMessageBroker } = await import('../message-broker.js')
    const mgr = new ExtensionTimeoutManager()
    const broker = new ServerMessageBroker(singlePool(makeMockWs()), makeBaseServices(mgr))

    // 两个 session 各挂起一条审批（跨 session 全局聚合）
    mgr.cachePendingRequest('s1', 'r1', 'select', { title: 'A' })
    mgr.cachePendingRequest('s2', 'r2', 'confirm', { message: '继续?' })

    const ws = makeMockWs()
    broker.sendInitialState(ws)

    const msgs = sentMessages(ws)
    const batch = msgs.find((m) => m.type === 'extension.pendingRequestsBatch')
    const payload = batch!.payload as { requests: Array<Record<string, unknown>> }
    expect(payload.requests).toHaveLength(2)
    const sessionIds = payload.requests.map((r) => r.sessionId).sort()
    expect(sessionIds).toEqual(['s1', 's2'])
  })

  it('TC-AC7c: session 销毁（clearForSession）→ 孤儿请求不随 initial state 反复推送', async () => {
    const { ServerMessageBroker } = await import('../message-broker.js')
    const mgr = new ExtensionTimeoutManager()
    const broker = new ServerMessageBroker(singlePool(makeMockWs()), makeBaseServices(mgr))

    mgr.cachePendingRequest('s1', 'r1', 'select', { title: 'A' })
    // session 删除路径触发 clearForSession（session-service.onSessionExit → removeSessionEntry
    // 并未直连 clearForSession，但 session 删除时 extension 链路清理经此入口——此处固化清缓存契约）
    mgr.clearForSession('s1')

    const ws = makeMockWs()
    broker.sendInitialState(ws)

    const msgs = sentMessages(ws)
    const batch = msgs.find((m) => m.type === 'extension.pendingRequestsBatch')
    const payload = batch!.payload as { requests: unknown[] }
    // clearForSession 后无孤儿请求
    expect(payload.requests).toEqual([])
  })
})
