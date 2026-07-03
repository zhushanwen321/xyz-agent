/**
 * WorkspaceMessageHandler + 写入时机接入测试。
 *
 * 覆盖（execution-plan test-matrix）：
 * - T1.9: RPC 贯穿：handler→service→store reply records
 * - T2.1: SessionLifecycle.create 成功后 record 被调
 * - T2.2: MessageDispatcher.sendPrompt record（line 83 同处）
 * - T2.3: pi create 失败 → record 未被调
 * - T2.4: hook blocked → record 未被调
 * - T2.5: ensureActive 失败 → record 未被调
 *
 * 运行：cd src-electron/runtime && npx vitest run test/workspace-message-handler.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ClientMessage } from '@xyz-agent/shared'

// ── T1.9: WorkspaceMessageHandler RPC 贯穿 ─────────────────────

describe('WorkspaceMessageHandler — T1.9 RPC 贯穿', () => {
  it('workspace.listRecent → reply workspace.recentList with records', async () => {
    const { WorkspaceMessageHandler } = await import('../src/transport/workspace-message-handler.js')
    const mockRecords = [
      { cwd: '/a', lastUsedAt: 1000, label: 'a' },
      { cwd: '/b', lastUsedAt: 2000, label: 'b' },
    ]
    const cap = { replies: [] as Array<{ id: string | undefined; type: string; payload: Record<string, unknown> }> }
    const ctx = {
      send: vi.fn(),
      sendError: vi.fn(),
      reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
        cap.replies.push({ id, type, payload })
      }),
      workspaceService: { list: vi.fn().mockReturnValue(mockRecords), record: vi.fn() },
    }
    const handler = new WorkspaceMessageHandler(ctx as unknown as ConstructorParameters<typeof WorkspaceMessageHandler>[0])
    const msg = { type: 'workspace.listRecent', id: 'req1', payload: {} } as unknown as ClientMessage
    const WS = {} as never

    await handler.handleWorkspaceMessage(msg, WS)

    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0]).toMatchObject({
      id: 'req1',
      type: 'workspace.recentList',
      payload: { records: mockRecords },
    })
  })

  it('workspace.listRecent → empty list returns empty array', async () => {
    const { WorkspaceMessageHandler } = await import('../src/transport/workspace-message-handler.js')
    const cap = { replies: [] as Array<{ id: string | undefined; type: string; payload: Record<string, unknown> }> }
    const ctx = {
      send: vi.fn(),
      sendError: vi.fn(),
      reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
        cap.replies.push({ id, type, payload })
      }),
      workspaceService: { list: vi.fn().mockReturnValue([]), record: vi.fn() },
    }
    const handler = new WorkspaceMessageHandler(ctx as unknown as ConstructorParameters<typeof WorkspaceMessageHandler>[0])
    const msg = { type: 'workspace.listRecent', id: 'req2', payload: {} } as unknown as ClientMessage
    const WS = {} as never

    await handler.handleWorkspaceMessage(msg, WS)

    expect(cap.replies[0].payload).toMatchObject({ records: [] })
  })
})

// ── T2.1-T2.5: 写入时机接入 ────────────────────────────────────

// Mock readPiState — SessionLifecycle 顶层 import 它，必须在 import 前 mock
vi.mock('../src/services/ports/pi-engine.js', () => ({
  readPiState: vi.fn().mockResolvedValue({ sessionId: 's1', sessionFile: '/tmp/s1.jsonl' }),
}))

describe('SessionLifecycle — 写入时机 record', () => {
  it('T2.1: create 成功后 record(sessionCwd) 被调', async () => {
    // 注意：readPiState 已被顶层 vi.mock 拦截，返回 { sessionId: 's1', sessionFile: '/tmp/s1.jsonl' }
    const { SessionLifecycle } = await import('../src/services/session/session-lifecycle.js')
    const workspaceRecord = vi.fn()
    const workspaceService = { record: workspaceRecord, list: vi.fn().mockReturnValue([]) }
    const mockClient = {
      sendCommand: vi.fn().mockResolvedValue({ success: true }),
      onEvent: vi.fn().mockReturnValue(() => {}),
    }
    const svc = {
      getExtensionPaths: vi.fn().mockResolvedValue([]),
      getSkillPaths: vi.fn().mockReturnValue([]),
      initializeManagedSession: vi.fn().mockResolvedValue({ id: 's1', cwd: '/test', label: 'test' }),
      toSummary: vi.fn().mockReturnValue({ id: 's1', cwd: '/test', label: 'test' }),
    }
    const pm = {
      createSession: vi.fn().mockResolvedValue(mockClient),
      destroySession: vi.fn().mockResolvedValue(undefined),
      rekey: vi.fn(),
    }
    const configStore = { getDefaultModel: vi.fn().mockReturnValue({ provider: 'p', modelId: 'm' }) }
    const sessionStore = { ensureSessionFile: vi.fn(), refreshAll: vi.fn() }

    // 当前 SessionLifecycle 只有 4 个构造参数，workspaceService 是本次 W2 新增的第 5 个。
    // 如果测试因"too many arguments"编译失败，说明实现尚未加参数——这是预期的 TDD 失败。
    // 实现后此行应正常编译。
    const lifecycle = new SessionLifecycle(
      svc as unknown as ConstructorParameters<typeof SessionLifecycle>[0],
      pm as unknown as ConstructorParameters<typeof SessionLifecycle>[1],
      configStore as unknown as ConstructorParameters<typeof SessionLifecycle>[2],
      sessionStore as unknown as ConstructorParameters<typeof SessionLifecycle>[3],
      workspaceService as unknown as ConstructorParameters<typeof SessionLifecycle>[4],
    )

    await lifecycle.create('/test', 'test')

    expect(workspaceRecord).toHaveBeenCalledWith('/test')
    expect(workspaceRecord).toHaveBeenCalledTimes(1)
  })

  it('T2.3: pi create 失败 → record 未被调', async () => {
    const { SessionLifecycle } = await import('../src/services/session/session-lifecycle.js')
    const workspaceRecord = vi.fn()
    const workspaceService = { record: workspaceRecord, list: vi.fn().mockReturnValue([]) }
    const svc = {
      getExtensionPaths: vi.fn().mockResolvedValue([]),
      getSkillPaths: vi.fn().mockReturnValue([]),
      initializeManagedSession: vi.fn(),
      toSummary: vi.fn(),
    }
    const pm = {
      createSession: vi.fn().mockRejectedValue(new Error('pi spawn failed')),
      destroySession: vi.fn().mockResolvedValue(undefined),
      rekey: vi.fn(),
    }
    const configStore = { getDefaultModel: vi.fn().mockReturnValue({ provider: 'p', modelId: 'm' }) }
    const sessionStore = { ensureSessionFile: vi.fn(), refreshAll: vi.fn() }

    const lifecycle = new SessionLifecycle(
      svc as unknown as ConstructorParameters<typeof SessionLifecycle>[0],
      pm as unknown as ConstructorParameters<typeof SessionLifecycle>[1],
      configStore as unknown as ConstructorParameters<typeof SessionLifecycle>[2],
      sessionStore as unknown as ConstructorParameters<typeof SessionLifecycle>[3],
      workspaceService as unknown as ConstructorParameters<typeof SessionLifecycle>[4],
    )

    await expect(lifecycle.create('/test')).rejects.toThrow('pi spawn failed')
    expect(workspaceRecord).not.toHaveBeenCalled()
  })
})

describe('MessageDispatcher — 写入时机 record', () => {
  it('T2.2: sendPrompt 成功后 record(activeSession.cwd) 被调', async () => {
    const { MessageDispatcher } = await import('../src/services/session/message-dispatcher.js')
    const workspaceRecord = vi.fn()
    const workspaceService = { record: workspaceRecord, list: vi.fn().mockReturnValue([]) }
    const mockClient = { prompt: vi.fn().mockResolvedValue(undefined), onEvent: vi.fn().mockReturnValue(() => {}) }
    const activeSession = { cwd: '/project', lastActiveAt: 0, isGenerating: false }
    const svc = {
      ensureActive: vi.fn().mockResolvedValue(mockClient),
      getSessionByClient: vi.fn().mockReturnValue(activeSession),
    }
    const pm = {}
    const broker = { broadcast: vi.fn() }

    // 当前 MessageDispatcher 只有 3 个构造参数，workspaceService 是本次 W2 新增的第 4 个。
    const dispatcher = new MessageDispatcher(
      svc as unknown as ConstructorParameters<typeof MessageDispatcher>[0],
      pm as unknown as ConstructorParameters<typeof MessageDispatcher>[1],
      broker as unknown as ConstructorParameters<typeof MessageDispatcher>[2],
      workspaceService as unknown as ConstructorParameters<typeof MessageDispatcher>[3],
    )

    const result = await dispatcher.sendMessage('s1', 'hello')

    expect(result.blocked).toBe(false)
    expect(workspaceRecord).toHaveBeenCalledWith('/project')
    expect(workspaceRecord).toHaveBeenCalledTimes(1)
  })

  it('T2.4: hook blocked → record 未被调', async () => {
    const { MessageDispatcher } = await import('../src/services/session/message-dispatcher.js')
    const workspaceRecord = vi.fn()
    const workspaceService = { record: workspaceRecord, list: vi.fn().mockReturnValue([]) }
    const svc = {
      ensureActive: vi.fn(),
      getSessionByClient: vi.fn(),
    }
    const pm = {}
    const broker = { broadcast: vi.fn() }

    const dispatcher = new MessageDispatcher(
      svc as unknown as ConstructorParameters<typeof MessageDispatcher>[0],
      pm as unknown as ConstructorParameters<typeof MessageDispatcher>[1],
      broker as unknown as ConstructorParameters<typeof MessageDispatcher>[2],
      workspaceService as unknown as ConstructorParameters<typeof MessageDispatcher>[3],
    )

    // 注册一个会 block 的 hook
    dispatcher.setSendMessageHook(vi.fn().mockResolvedValue({ blocked: true, reason: 'blocked by hook' }))

    const result = await dispatcher.sendMessage('s1', 'hello')

    expect(result.blocked).toBe(true)
    expect(workspaceRecord).not.toHaveBeenCalled()
  })

  it('T2.5: ensureActive 失败 → record 未被调', async () => {
    const { MessageDispatcher } = await import('../src/services/session/message-dispatcher.js')
    const workspaceRecord = vi.fn()
    const workspaceService = { record: workspaceRecord, list: vi.fn().mockReturnValue([]) }
    const svc = {
      ensureActive: vi.fn().mockRejectedValue(new Error('restore failed')),
      getSessionByClient: vi.fn(),
    }
    const pm = {}
    const broker = { broadcast: vi.fn() }

    const dispatcher = new MessageDispatcher(
      svc as unknown as ConstructorParameters<typeof MessageDispatcher>[0],
      pm as unknown as ConstructorParameters<typeof MessageDispatcher>[1],
      broker as unknown as ConstructorParameters<typeof MessageDispatcher>[2],
      workspaceService as unknown as ConstructorParameters<typeof MessageDispatcher>[3],
    )

    await expect(dispatcher.sendMessage('s1', 'hello')).rejects.toThrow('restore failed')
    expect(workspaceRecord).not.toHaveBeenCalled()
  })
})
