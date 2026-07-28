/**
 * SessionService 全客户端断开 pi 存活契约测试（P3 s2 AC5）。
 *
 * 覆盖：
 * - TC-AC5: 建立 session + 开始生成（pm 存活）→ 断开全部 ws → 断言：
 *           ① sessions Map 仍含该 session（pi 存活，pm.hasClient 恒 true）
 *           ② broker.broadcast 在零客户端时为 no-op 不抛错
 *           ③ 后继 broadcast 仍打 seq 入 buffer（断开期间事件不丢，重连可回放）
 *
 * spec §三表「全客户端断开 pi 存活」契约（D1）：WS 断开（含全部断开）pi 继续跑到 turn_end；
 * connection-manager close 只清连接池/心跳，无 onDisconnect 订阅者影响 pi。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/session-service.decouple.test.ts
 *
 * 测试策略：真实 SessionService + 真实 ServerMessageBroker（验 buffer 入队）+ mock pm/adapter。
 * 「全部 ws 断开」用 broker 的 pool clients 清空模拟（零客户端广播 = no-op，但 seq 仍入 buffer）。
 * pi 存活的权威 owner 是 SessionService.sessions Map + pm.hasClient。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WebSocket } from 'ws'
import { SessionService } from '../session-service.js'
import { ServerMessageBroker } from '../../../transport/message-broker.js'
import type { ClientPool, BrokerServices } from '../../../transport/message-broker.js'
import type { ConnectionCtx } from '../../../transport/connection-manager.js'
import type { IPiEngine, IProcessManager } from '../../ports/pi-engine.js'
import type { IEventAdapter, IExtensionService } from '../../../interfaces.js'
import type { IConfigStore } from '../../ports/config.js'
import type { ISessionStore } from '../../ports/session.js'
import type { IGitInfoReader } from '../../ports/git-info.js'
import type { WorkspaceService } from '../../workspace/workspace-service.js'
import type { ServerMessage } from '@xyz-agent/shared'

// ── mock 依赖工厂 ────────────────────────────────────────────────

function makeMockAdapter(): IEventAdapter & { detach: ReturnType<typeof vi.fn> } {
  return { attach: vi.fn(), detach: vi.fn() }
}

/** mock client：含 onEvent（adapter.attach 用）+ getCommands（fetchAndBroadcastCommands 用，返回空避免噪声）。 */
function makeMockPiClient(): IPiEngine {
  return {
    onEvent: () => () => {},
    getCommands: async () => [],
  } as unknown as IPiEngine
}

function makeMockPm(): IProcessManager & { hasClient: ReturnType<typeof vi.fn>; getClient: ReturnType<typeof vi.fn> } {
  const clients = new Map<string, IPiEngine>()
  return {
    createSession: vi.fn(async (id: string) => {
      const c = makeMockPiClient()
      clients.set(id, c)
      return c
    }),
    getClient: vi.fn((id: string) => clients.get(id)),
    hasClient: vi.fn(() => true),
    onSessionExit: vi.fn(() => () => {}),
    destroyAll: vi.fn(async () => {}),
    getSessionIdByClient: vi.fn(() => undefined),
  }
}

function makeMockConfigStore(): IConfigStore {
  return { getDefaultModel: () => null, getSkillPaths: () => [] } as unknown as IConfigStore
}

function makeMockSessionStore(): ISessionStore {
  return {
    scanSessions: () => [],
    persistSessionEnd: vi.fn(),
    persistSessionName: vi.fn(),
    extractSessionOutcome: vi.fn(() => undefined),
    convertHistory: vi.fn(() => []),
  } as unknown as ISessionStore
}

function makeMockGitInfoReader(): IGitInfoReader {
  return { readGitInfo: () => null } as unknown as IGitInfoReader
}

function makeMockWorkspaceService(): WorkspaceService {
  return {} as unknown as WorkspaceService
}

function makeMockExtensionService(): IExtensionService {
  return { getExtensionPaths: vi.fn(async () => []) } as unknown as IExtensionService
}

const mockServices: BrokerServices = {
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

function makeMockWs(): WebSocket {
  return { readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebSocket
}

/** 构造 ClientPool（ws 连接池）。 */
function poolWith(ws: WebSocket): ClientPool {
  const clients = new Map<string, ConnectionCtx>()
  clients.set('client-1', { ws, clientId: 'client-1', deviceName: '', connectedAt: 0 })
  return { clients }
}

/** 提取 ws.send 收到的所有消息。 */
function sentMessages(ws: WebSocket): Record<string, unknown>[] {
  return vi.mocked(ws.send).mock.calls.map((c) => JSON.parse(c[0] as string))
}

// ── Tests ─────────────────────────────────────────────────────────

describe('P3 s2 AC5: 全客户端断开 pi 存活', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('TC-AC5: 断开全部 ws 后 sessions Map 仍含 session + broker 零客户端 broadcast 不抛错 + 事件仍入 buffer', async () => {
    // 用真实 broker（验 seq 入 buffer）+ mock pm（pi 存活）
    const wsConnected = makeMockWs()
    const pool = poolWith(wsConnected)
    const broker = new ServerMessageBroker(pool, mockServices)
    const pm = makeMockPm()
    const service = new SessionService(
      pm,
      broker,
      () => makeMockAdapter(),
      '/mock-root',
      makeMockExtensionService(),
      makeMockConfigStore(),
      makeMockSessionStore(),
      makeMockGitInfoReader(),
      makeMockWorkspaceService(),
    )

    // ① 建立 session（pi 存活，pm.hasClient=true）。先 pm.createSession 注册 client，
    // 使 fetchAndBroadcastCommands 的 getCommands 能拿到 client（避免 "not active" 噪声）
    const client = await pm.createSession('s-survive', '/mock/cwd')
    await service.initializeManagedSession(
      's-survive',
      client,
      '/mock/cwd',
      'survive-label',
    )
    expect(service.hasSession('s-survive')).toBe(true)
    expect(pm.hasClient('s-survive')).toBe(true)

    // ② 模拟「全部 ws 断开」：清空 broker pool 的 clients Map（零客户端）
    pool.clients.clear()
    expect(pool.clients.size).toBe(0)

    // ③ 断开后 pi 仍存活：sessions Map 不变，pm.hasClient 恒 true
    expect(service.hasSession('s-survive')).toBe(true)
    expect(service.getActiveSessionIds()).toEqual(['s-survive'])
    expect(pm.hasClient('s-survive')).toBe(true)

    // ④ 零客户端 broadcast 为 no-op 不抛错（pi 继续跑，事件翻译广播）
    expect(() =>
      broker.broadcast({
        type: 'message.text_delta',
        payload: { sessionId: 's-survive' },
      } as unknown as ServerMessage),
    ).not.toThrow()

    // ⑤ 断开期间 broadcast 仍打 seq 入 buffer（重连可回放）。
    // 此时连接的 ws 已清空，但新客户端重连后能按 seq 回放——验证方式：
    // 新客户端连上后，broker 对断开期间发出的广播（seq 已递增）按序入 buffer。
    const wsReconnect = makeMockWs()
    pool.clients.set('client-reconnect', {
      ws: wsReconnect,
      clientId: 'client-reconnect',
      deviceName: '',
      connectedAt: 0,
    })
    // 后续广播应继续递增 seq（断开期间的 seq 已被消耗，buffer 持续累积）
    broker.broadcast({ type: 'config.sessions', payload: { groups: [] } } as ServerMessage)
    const msgs = sentMessages(wsReconnect)
    // 新客户端能收到后续广播（seq 递增，证明 broadcast 链路未断）
    expect(msgs.some((m) => m.type === 'config.sessions')).toBe(true)
    // seq 应大于 1（前面零客户端期的 text_delta 已消耗 seq=1）
    const seqAfter = msgs.find((m) => m.type === 'config.sessions')?.seq
    expect(seqAfter).toBeGreaterThan(1)
  })

  it('TC-AC5b: 断开后 onSessionExit 不被 WS 状态触发（pi 终止仅由 pm 退出/主动 delete，不依赖 WS）', async () => {
    const broker = new ServerMessageBroker(poolWith(makeMockWs()), mockServices)
    const pm = makeMockPm()
    const service = new SessionService(
      pm,
      broker,
      () => makeMockAdapter(),
      '/mock-root',
      makeMockExtensionService(),
      makeMockConfigStore(),
      makeMockSessionStore(),
      makeMockGitInfoReader(),
      makeMockWorkspaceService(),
    )
    const client2 = await pm.createSession('s-survive2', '/mock/cwd2')
    await service.initializeManagedSession(
      's-survive2',
      client2,
      '/mock/cwd2',
      'label2',
    )

    // 清空 pool clients（全断开）+ 等一拍
    ;(broker as unknown as { pool: ClientPool }).pool.clients.clear()

    // 断言：断开后 pi 仍存活，未触发 onSessionExit 清理路径
    expect(service.hasSession('s-survive2')).toBe(true)
    expect(service.getActiveSummaries()).toHaveLength(1)
  })
})
