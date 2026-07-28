/**
 * SessionService destroyAll 关停契约测试（P3 s2 AC8）。
 *
 * 覆盖：
 * - TC-AC8: 含 2 个活跃 session 的 SessionService → destroyAll() → pm.destroyAll 调用 +
 *           各 session adapter.detach 调用 + sessions Map 清空（runtime 关停杀全部 pi）
 *
 * spec §三表「runtime 关停杀 pi」契约（D4）：server.stop → sessionService.destroyAll →
 * pm.destroyAll 杀全部 pi 进程（server.ts:360-364 接线）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/session-service.shutdown.test.ts
 *
 * 测试策略：真实 SessionService 实例 + mock 外围依赖（pm/broker/configStore/sessionStore 等），
 * 经 public initializeManagedSession 注入 session（避开 lifecycle.create 完整 spawn 链），
 * 直接调 destroyAll 验真实编排逻辑（不 mock 被测方法）。
 */
import { describe, it, expect, vi, beforeEach, type Mocked } from 'vitest'
import { SessionService } from '../session-service.js'
import type { IPiEngine, IProcessManager } from '../../ports/pi-engine.js'
import type { IMessageBroker, IEventAdapter, IExtensionService } from '../../../interfaces.js'
import type { IConfigStore } from '../../ports/config.js'
import type { ISessionStore } from '../../ports/session.js'
import type { IGitInfoReader } from '../../ports/git-info.js'
import type { WorkspaceService } from '../../workspace/workspace-service.js'
import type { IManagedSessionView } from '../types.js'
import type { ServerMessage } from '@xyz-agent/shared'

// ── mock 依赖工厂 ────────────────────────────────────────────────

function makeMockAdapter(): Mocked<IEventAdapter> {
  return {
    attach: vi.fn(),
    detach: vi.fn(),
  }
}

function makeMockClient(): IPiEngine {
  // onEvent 用于 adapter.attach；getCommands 返回空避免 fetchAndBroadcastCommands 噪声
  return { onEvent: () => () => {}, getCommands: async () => [] } as unknown as IPiEngine
}

function makeMockPm(): Mocked<IProcessManager> {
  const clients = new Map<string, IPiEngine>()
  return {
    createSession: vi.fn(async (id: string) => {
      const c = makeMockClient()
      clients.set(id, c)
      return c
    }),
    destroySession: vi.fn(async () => {}),
    getClient: vi.fn((id: string) => clients.get(id)),
    hasClient: vi.fn(() => true),
    rekey: vi.fn(),
    onSessionExit: vi.fn(() => () => {}),
    destroyAll: vi.fn(async () => { clients.clear() }),
    getSessionIdByClient: vi.fn(() => undefined),
    getPiVersion: vi.fn(async () => 'unknown'),
  }
}

function makeMockBroker(): IMessageBroker {
  return {
    broadcast: vi.fn(),
    send: vi.fn(),
    sendError: vi.fn(),
    // P5 lease/presence 定向投递（shutdown 测试不涉及，给 no-op stub 满足接口）。
    sendToClient: vi.fn(),
    broadcastExcept: vi.fn(),
  }
}

function makeMockConfigStore(): IConfigStore {
  return {
    getDefaultModel: () => null,
    getSkillPaths: () => [],
  } as unknown as IConfigStore
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

/** 构造真实 SessionService + 注入 mock 依赖。adapterFactory 返回带 spy 的 adapter。 */
async function makeSessionServiceWithSessions(
  count: number,
): Promise<{ service: SessionService; adapters: Array<ReturnType<typeof makeMockAdapter>>; pm: ReturnType<typeof makeMockPm> }> {
  const pm = makeMockPm()
  const adapters: Array<ReturnType<typeof makeMockAdapter>> = []
  const adapterFactory = (_sid: string, _send: (msg: ServerMessage) => void) => {
    const a = makeMockAdapter()
    adapters.push(a)
    return a
  }
  const service = new SessionService(
    pm,
    makeMockBroker(),
    adapterFactory,
    '/mock-root',
    makeMockExtensionService(),
    makeMockConfigStore(),
    makeMockSessionStore(),
    makeMockGitInfoReader(),
    makeMockWorkspaceService(),
  )
  // 注入 N 个活跃 session（经 public initializeManagedSession，避开 lifecycle.create spawn 链）
  for (let i = 0; i < count; i++) {
    const id = `s${i + 1}`
    // pm.createSession 注册 client 到 pm 的 clients map，使 fetchAndBroadcastCommands 的
    // getCommands 能拿到 client（否则报 "not active" 噪声，虽不阻断测试但污染输出）
    const client = await pm.createSession(id, `/mock/cwd${i + 1}`)
    await service.initializeManagedSession(
      id,
      client,
      `/mock/cwd${i + 1}`,
      `label-${i + 1}`,
    )
  }
  return { service, adapters, pm }
}

// ── Tests ─────────────────────────────────────────────────────────

describe('P3 s2 AC8: runtime 关停 destroyAll 杀全部 pi', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('TC-AC8: destroyAll 调 pm.destroyAll + 各 session adapter.detach + sessions Map 清空', async () => {
    const { service, adapters, pm } = await makeSessionServiceWithSessions(2)

    // 注入 2 个 session 后活跃列表含两者
    expect(service.getActiveSessionIds().sort()).toEqual(['s1', 's2'])

    await service.destroyAll()

    // pm.destroyAll 调用 1 次（杀全部 pi 进程）
    expect(pm.destroyAll).toHaveBeenCalledTimes(1)
    // 各 session 的 adapter.detach 各调用 1 次（断开事件监听）
    expect(adapters).toHaveLength(2)
    for (const a of adapters) {
      expect(a.detach).toHaveBeenCalledTimes(1)
    }
    // sessions Map 清空（runtime 关停后无残留 session）
    expect(service.getActiveSessionIds()).toEqual([])
    expect(service.hasSession('s1')).toBe(false)
    expect(service.hasSession('s2')).toBe(false)
  })

  it('TC-AC8b: 零活跃 session destroyAll 不抛错（空 Map 幂等）', async () => {
    const { service, pm } = await makeSessionServiceWithSessions(0)
    await expect(service.destroyAll()).resolves.toBeUndefined()
    expect(pm.destroyAll).toHaveBeenCalledTimes(1)
  })
})
