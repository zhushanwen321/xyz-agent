/**
 * ServerMessageBroker 定向投递测试（P5 lease/presence：sendToClient / broadcastExcept）。
 *
 * 覆盖：
 * - TC1: sendToClient 命中目标 clientId（只发目标，其余 client 不收）
 * - TC2: sendToClient 未命中 clientId 不抛错（no-op）
 * - TC3: broadcastExcept 排除指定 clientId（发给其余 client，跳过 exclude）
 * - 边界：sendToClient 目标 ws 已关闭（readyState 检查跳过）；broadcastExcept 单 client 失败不中断
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/__tests__/message-broker.lease-direct.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WebSocket } from 'ws'
import type { ClientPool, BrokerServices, ServerMessageBroker as BrokerType } from '../message-broker.js'
import type { ConnectionCtx } from '../connection-manager.js'
import type { ServerMessage } from '@xyz-agent/shared'

void ({} as BrokerType) // 仅用于类型导入校验，不直接引用

function makeMockWs(open = true): WebSocket {
  return {
    readyState: open ? WebSocket.OPEN : WebSocket.CLOSED,
    send: vi.fn(),
  } as unknown as WebSocket
}

/** 由 [clientId, ws] 对构造 ClientPool。 */
function poolOf(...entries: Array<[string, WebSocket]>): ClientPool {
  const clients = new Map<string, ConnectionCtx>()
  for (const [clientId, ws] of entries) {
    clients.set(clientId, { ws, clientId, deviceName: '', connectedAt: 0 })
  }
  return { clients }
}

const mockServices = {
  sessionService: { listPersistedSessions: () => [] },
  configService: {
    listProviders: () => [], getDefaultModel: () => null, loadSkills: () => [], loadAgents: () => [],
    getSkillDirs: () => [], getAgentDirs: () => [], getExtensionDirs: () => [],
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

function sentTypes(ws: WebSocket): string[] {
  return vi.mocked(ws.send).mock.calls.map((c) => JSON.parse(c[0] as string).type)
}

describe('ServerMessageBroker 定向投递（P5 sendToClient / broadcastExcept）', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  // TC1: sendToClient 命中目标 clientId
  it('TC1: sendToClient 命中目标 clientId，只发给目标，其余 client 不收，且不打 seq', async () => {
    const { ServerMessageBroker } = await import('../message-broker.js')
    const wsA = makeMockWs()
    const wsB = makeMockWs()
    const broker = new ServerMessageBroker(poolOf(['a', wsA], ['b', wsB]), mockServices)

    broker.sendToClient('b', { type: 'session.idle', payload: { sessionId: 's1', reason: 'turn_end' } } as ServerMessage)

    expect(sentTypes(wsB)).toEqual(['session.idle'])
    expect(vi.mocked(wsA.send)).not.toHaveBeenCalled()
    // 点对点不打 seq（与 reply 同语义，非广播）
    const sent = JSON.parse(vi.mocked(wsB.send).mock.calls[0][0] as string)
    expect(sent.seq).toBeUndefined()
  })

  // TC2: sendToClient 未命中 clientId 不抛错
  it('TC2: sendToClient 未命中 clientId 时 no-op，无 ws.send 调用、无异常', async () => {
    const { ServerMessageBroker } = await import('../message-broker.js')
    const wsA = makeMockWs()
    const broker = new ServerMessageBroker(poolOf(['a', wsA]), mockServices)

    expect(() => broker.sendToClient('nonexistent', { type: 'session.idle', payload: { sessionId: 's1', reason: 'turn_end' } } as ServerMessage)).not.toThrow()
    expect(vi.mocked(wsA.send)).not.toHaveBeenCalled()
  })

  // TC2b: sendToClient 目标 ws 已关闭时跳过
  it('TC2b: sendToClient 目标 ws 已关闭（readyState!==OPEN）时不调 send', async () => {
    const { ServerMessageBroker } = await import('../message-broker.js')
    const wsClosed = makeMockWs(false)
    const broker = new ServerMessageBroker(poolOf(['a', wsClosed]), mockServices)

    broker.sendToClient('a', { type: 'session.idle', payload: { sessionId: 's1', reason: 'turn_end' } } as ServerMessage)
    expect(vi.mocked(wsClosed.send)).not.toHaveBeenCalled()
  })

  // TC3: broadcastExcept 排除指定 clientId
  it('TC3: broadcastExcept 排除指定 clientId，发给其余 client，跳过 exclude，不打 seq', async () => {
    const { ServerMessageBroker } = await import('../message-broker.js')
    const wsA = makeMockWs()
    const wsB = makeMockWs()
    const wsC = makeMockWs()
    const broker = new ServerMessageBroker(poolOf(['a', wsA], ['b', wsB], ['c', wsC]), mockServices)

    broker.broadcastExcept('b', { type: 'session.busy', payload: { sessionId: 's1', clientId: 'x', deviceName: 'Mac', expiresAt: 0 } } as ServerMessage)

    expect(sentTypes(wsA)).toEqual(['session.busy'])
    expect(sentTypes(wsC)).toEqual(['session.busy'])
    expect(vi.mocked(wsB.send)).not.toHaveBeenCalled()
    // 定向广播不打 seq
    const sentA = JSON.parse(vi.mocked(wsA.send).mock.calls[0][0] as string)
    expect(sentA.seq).toBeUndefined()
  })

  // TC3b: broadcastExcept 单 client send 失败不中断其余
  it('TC3b: broadcastExcept 遇到 send 抛错的 client 不中断其余 client 广播', async () => {
    const { ServerMessageBroker } = await import('../message-broker.js')
    const wsOk = makeMockWs()
    const wsThrow = { readyState: WebSocket.OPEN, send: vi.fn(() => { throw new Error('boom') }) } as unknown as WebSocket
    const wsOk2 = makeMockWs()
    const broker = new ServerMessageBroker(poolOf(['ok', wsOk], ['throw', wsThrow], ['ok2', wsOk2]), mockServices)

    expect(() => broker.broadcastExcept('none', { type: 'session.busy', payload: { sessionId: 's1', clientId: 'x', deviceName: 'Mac', expiresAt: 0 } } as ServerMessage)).not.toThrow()
    expect(sentTypes(wsOk)).toEqual(['session.busy'])
    expect(sentTypes(wsOk2)).toEqual(['session.busy'])
  })
})
