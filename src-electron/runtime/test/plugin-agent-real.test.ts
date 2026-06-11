/**
 * Plugin Agent API — 真实 handler 测试
 *
 * 验证 setModel→switchModel、getModel→activeSession.modelId、
 * getActiveTools→toolRegistry schemas、getThinkingLevel 默认值。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PluginService } from '../src/services/plugin-service/plugin-service.js'
import { PluginRegistry } from '../src/services/plugin-service/plugin-registry.js'
import type { IMessageBroker, ISessionService } from '../src/interfaces.js'
import type { IPluginServiceDeps } from '../src/services/plugin-service/plugin-types.js'
import type { SessionSummary, SessionGroup } from '@xyz-agent/shared'

// ── Fixtures ──────────────────────────────────────────────────

function createMockBroker(): IMessageBroker {
  return {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
  }
}

function createMockSessionService(sessions: SessionSummary[] = []): ISessionService {
  const sessionMap = new Map(sessions.map(s => [s.id, s]))
  const groups: SessionGroup[] = sessions.length > 0
    ? [{ cwd: sessions[0].cwd, sessions }]
    : []

  return {
    listPersistedSessions: vi.fn().mockReturnValue(groups),
    getSummary: vi.fn((id: string) => sessionMap.get(id)),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    switchModel: vi.fn().mockResolvedValue('provider/model-b'),
    create: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    renameSession: vi.fn().mockResolvedValue(undefined),
    sendSubagentMessage: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    compact: vi.fn().mockResolvedValue(undefined),
    getHistory: vi.fn().mockResolvedValue([]),
    restoreSession: vi.fn().mockResolvedValue(undefined),
    rebindAfterFork: vi.fn().mockResolvedValue(undefined),
    hasActiveSession: vi.fn().mockReturnValue(true),
    getRpcClient: vi.fn().mockReturnValue(undefined),
    destroyAll: vi.fn().mockResolvedValue(undefined),
  } as unknown as ISessionService
}

function createService(sessionService?: ISessionService): PluginService {
  const broker = createMockBroker()
  const registry = new PluginRegistry('/tmp/fake-project')
  const deps: IPluginServiceDeps = {
    sessionService,
  }
  return new PluginService(registry, broker, deps)
}

async function callMethod(service: PluginService, method: string, params: Record<string, unknown>): Promise<unknown> {
  const svc = service as unknown as {
    registerRpcMethods(): void
    rpcServer: { methods: Map<string, (params: Record<string, unknown>) => Promise<unknown>> }
  }
  svc.registerRpcMethods()
  const handler = svc.rpcServer.methods.get(method)
  if (!handler) throw new Error(`Method not registered: ${method}`)
  return handler(params)
}

// ══════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════

describe('Agent RPC Handlers — real implementation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('getModel returns active session modelId', async () => {
    const session: SessionSummary = {
      id: 's1', label: 'S1', cwd: '/work', status: 'active',
      lastActiveAt: Date.now(), modelId: 'openai/gpt-4', tokenCount: 0,
    }
    const sessionService = createMockSessionService([session])
    const service = createService(sessionService)

    const model = await callMethod(service, 'plugin.agent.getModel', {})
    expect(model).toBe('openai/gpt-4')
  })

  it('getModel returns empty string when no active session', async () => {
    const session: SessionSummary = {
      id: 's1', label: 'S1', cwd: '/work', status: 'idle',
      lastActiveAt: Date.now(), modelId: 'provider/x', tokenCount: 0,
    }
    const sessionService = createMockSessionService([session])
    const service = createService(sessionService)

    const model = await callMethod(service, 'plugin.agent.getModel', {})
    expect(model).toBe('')
  })

  it('setModel calls switchModel on active session', async () => {
    const session: SessionSummary = {
      id: 's1', label: 'S1', cwd: '/work', status: 'active',
      lastActiveAt: Date.now(), modelId: 'provider/old', tokenCount: 0,
    }
    const sessionService = createMockSessionService([session])
    const service = createService(sessionService)

    await callMethod(service, 'plugin.agent.setModel', { model: 'openai/gpt-4' })
    expect(sessionService.switchModel).toHaveBeenCalledWith('s1', 'openai', 'gpt-4')
  })

  it('setModel is silently ignored when no active session', async () => {
    const sessionService = createMockSessionService([])
    const service = createService(sessionService)

    await callMethod(service, 'plugin.agent.setModel', { model: 'openai/gpt-4' })
    expect(sessionService.switchModel).not.toHaveBeenCalled()
  })

  it('getThinkingLevel returns "off" when no active session', async () => {
    const service = createService(createMockSessionService())

    const level = await callMethod(service, 'plugin.agent.getThinkingLevel', {})
    expect(level).toBe('off')
  })

  it('getThinkingLevel returns active session thinkingLevel', async () => {
    const session: SessionSummary = {
      id: 's1', label: 'S1', cwd: '/work', status: 'active',
      lastActiveAt: Date.now(), modelId: 'provider/x', tokenCount: 0,
      thinkingLevel: 'high',
    }
    const sessionService = createMockSessionService([session])
    const service = createService(sessionService)

    const level = await callMethod(service, 'plugin.agent.getThinkingLevel', {})
    expect(level).toBe('high')
  })

  it('setThinkingLevel is silently accepted', async () => {
    const service = createService(createMockSessionService())

    // Should not throw
    await callMethod(service, 'plugin.agent.setThinkingLevel', { level: 'max' })
  })

  it('getActiveTools returns tool schema names from toolRegistry', async () => {
    const service = createService(createMockSessionService())
    const svc = service as unknown as {
      registerRpcMethods(): void
      rpcServer: { methods: Map<string, (params: Record<string, unknown>) => Promise<unknown>> }
      toolRegistry: Map<string, { schema: { name: string } }>
    }

    // Inject tool entries into registry
    svc.toolRegistry.set('p1:toolA', { schema: { name: 'toolA' } })
    svc.toolRegistry.set('p1:toolB', { schema: { name: 'toolB' } })

    const tools = await callMethod(service, 'plugin.agent.getActiveTools', {})
    expect(tools).toEqual(['toolA', 'toolB'])
  })

  it('getActiveTools returns empty array when no tools', async () => {
    const service = createService(createMockSessionService())

    const tools = await callMethod(service, 'plugin.agent.getActiveTools', {})
    expect(tools).toEqual([])
  })

  it('falls back to stub when sessionService is undefined', async () => {
    const broker = createMockBroker()
    const registry = new PluginRegistry('/tmp/fake-project')
    const service = new PluginService(registry, broker)

    const model = await callMethod(service, 'plugin.agent.getModel', {})
    expect(model).toBe('')

    const tools = await callMethod(service, 'plugin.agent.getActiveTools', {})
    expect(tools).toEqual([])
  })
})
