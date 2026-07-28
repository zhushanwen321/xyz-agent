/**
 * ConnectionManager P5 presence 测试（activeSessions + broadcastPresence + buildPresenceList）。
 *
 * 覆盖：
 * - TC1: onConnect/onDisconnect 触发 presence.update 全量广播
 * - TC2: setActiveSession 触发 presence.update（activeSessionId 变化）+ getActiveSession
 * - TC3: buildPresenceList 算 isOperating（busyOwnerId===clientId）
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/__tests__/connection-manager.presence.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PresenceConnection } from '@xyz-agent/shared'
import type { ISessionServiceInternal } from '../../services/session/session-internal.js'

/** 直接测 ConnectionManager 的 presence 方法（不经真实 WS，用 mock 回调捕获 onPresenceUpdate）。 */
async function makeCm(sessionService?: Partial<ISessionServiceInternal>) {
  const { ConnectionManager } = await import('../connection-manager.js')
  const presenceUpdates: PresenceConnection[][] = []
  const cm = new ConnectionManager(0, {
    onConnect: vi.fn(),
    onMessage: vi.fn().mockResolvedValue(undefined),
    onDisconnect: vi.fn(),
    sendError: vi.fn(),
    onPresenceUpdate: (connections: PresenceConnection[]) => presenceUpdates.push(connections),
  // port 0 仅供构造（不 start），测试只调方法。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any, {})
  if (sessionService) cm.setSessionService(sessionService as unknown as ISessionServiceInternal)
  return { cm, presenceUpdates }
}

describe('ConnectionManager P5 presence（activeSessions + broadcastPresence + buildPresenceList）', () => {
  beforeEach(() => vi.clearAllMocks())

  it('TC3: buildPresenceList 算 isOperating（busyOwnerId===clientId）', async () => {
    const sessions = [
      { id: 's1', busyOwnerId: 'A', cwd: '/p', label: 's', modelId: 'm', createdAt: 0, lastActiveAt: 0, tokenCount: 0, inputTokens: 0, isGenerating: false, isCompacting: false, labelPersisted: false },
    ]
    const { cm } = await makeCm({ allSessions: () => sessions[Symbol.iterator]() })
    // 手动塞 clients
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(cm as any).clients.set('A', { ws: {}, clientId: 'A', deviceName: 'Mac', connectedAt: 0 })
    ;(cm as any).clients.set('B', { ws: {}, clientId: 'B', deviceName: 'Phone', connectedAt: 0 })

    const list = cm.buildPresenceList()
    const a = list.find((c) => c.clientId === 'A')
    const b = list.find((c) => c.clientId === 'B')
    expect(a?.isOperating).toBe(true)
    expect(b?.isOperating).toBe(false)
  })

  it('TC2: setActiveSession 触发 onPresenceUpdate + activeSessionId 变化 + getActiveSession', async () => {
    const { cm, presenceUpdates } = await makeCm()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(cm as any).clients.set('A', { ws: {}, clientId: 'A', deviceName: 'Mac', connectedAt: 0 })

    cm.setActiveSession('A', 's1')

    expect(cm.getActiveSession('A')).toBe('s1')
    expect(presenceUpdates).toHaveLength(1)
    expect(presenceUpdates[0].find((c) => c.clientId === 'A')?.activeSessionId).toBe('s1')
  })

  it('TC2b: setActiveSession clientId 不在 clients 时 no-op（不触发 presence）', async () => {
    const { cm, presenceUpdates } = await makeCm()
    cm.setActiveSession('nonexistent', 's1')
    expect(presenceUpdates).toHaveLength(0)
  })

  it('TC1: broadcastPresence 触发 onPresenceUpdate 含全量客户端', async () => {
    const { cm, presenceUpdates } = await makeCm()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(cm as any).clients.set('A', { ws: {}, clientId: 'A', deviceName: 'Mac', connectedAt: 0 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(cm as any).clients.set('B', { ws: {}, clientId: 'B', deviceName: 'Phone', connectedAt: 0 })

    cm.broadcastPresence()

    expect(presenceUpdates).toHaveLength(1)
    expect(presenceUpdates[0]).toHaveLength(2)
    expect(presenceUpdates[0].map((c) => c.clientId).sort()).toEqual(['A', 'B'])
  })

  it('TC1b: sessionService 未注入时 buildPresenceList isOperating 全 false（降级）', async () => {
    const { cm } = await makeCm()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(cm as any).clients.set('A', { ws: {}, clientId: 'A', deviceName: 'Mac', connectedAt: 0 })

    const list = cm.buildPresenceList()
    expect(list[0].isOperating).toBe(false)
  })
})
