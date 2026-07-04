import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { IGitInfoReader } from '../src/services/ports/git-info.js'

/**
 * 动态装配真实的 EventAdapter + EventInterpreter（绕过本文件顶部的 vi.mock(event-adapter.js)）。
 * 返回的 adapter 与生产装配等价：translate 纯翻译 → interpreter 业务编排。
 */
async function buildRealAdapter(
  sessionId: string,
  send: (msg: unknown) => void,
  options: Record<string, unknown>,
): Promise<{ attach(c: unknown): void; detach(): void }> {
  const [{ EventAdapter }, { EventInterpreter }] = await Promise.all([
    vi.importActual<typeof import('../src/infra/pi/event-adapter.js')>('../src/infra/pi/event-adapter.js'),
    vi.importActual<typeof import('../src/services/session/event-interpreter.js')>('../src/services/session/event-interpreter.js'),
  ])
  const interpreter = new EventInterpreter(sessionId, { send: send as never, ...options } as never)
  return new EventAdapter(sessionId, (events) => interpreter.interpret(events))
}

// IGitInfoReader 桩：SessionService 被 vi.mock 整体替换（构造参数不被使用），仅满足构造签名。
const noopGitInfoReader: IGitInfoReader = { readGitInfo: () => undefined, pruneStaleCache: () => {} }

/**
 * Bridge extension message format tests.
 *
 * Test strategy:
 * - EventAdapter bridge detection: unit test the translate method for bridge: methods
 * - Server bridge routing: test handleBridgeRequest directly with mock IPiEngine
 * - Extension timeout bridge tracking: test registerExtensionTimeout for bridge: methods
 */

// ── Mocks ────────────────────────────────────────────────────────

const mockSendCommand = vi.fn().mockResolvedValue({ success: true })

vi.mock('../src/services/session/session-service.js', () => {
  return {
    SessionService: class MockSessionService {
      sendMessage = vi.fn().mockResolvedValue(undefined)
      sendSubagentMessage = vi.fn().mockResolvedValue(undefined)
      listPersistedSessions = vi.fn().mockReturnValue([])
      getSummary = vi.fn().mockReturnValue(undefined)
      getHistory = vi.fn().mockResolvedValue([])
      create = vi.fn().mockResolvedValue({ id: 'bridge-test-session', cwd: '/tmp', status: 'active' })
      delete = vi.fn().mockResolvedValue(undefined)
      destroyAll = vi.fn().mockResolvedValue(undefined)
      clear = vi.fn().mockResolvedValue(undefined)
      renameSession = vi.fn().mockResolvedValue(undefined)
      restoreSession = vi.fn().mockResolvedValue({ id: 'bridge-test-session', cwd: '/tmp', status: 'active' })
      hasActiveSession = vi.fn().mockReturnValue(true)
      compact = vi.fn().mockResolvedValue(undefined)
      abort = vi.fn().mockResolvedValue(undefined)
      switchModel = vi.fn().mockResolvedValue(undefined)
      getRpcClient = vi.fn().mockReturnValue({
        sendCommand: mockSendCommand,
        onEvent: vi.fn().mockReturnValue(() => {}),
        onExit: vi.fn(),
        exited: false,
        kill: vi.fn(),
        start: vi.fn(),
      })
    },
  }
})

vi.mock('../src/services/config-service.js', () => ({
  ConfigService: class MockConfigService {
    listProviders = vi.fn().mockReturnValue([])
    setProvider = vi.fn()
    deleteProvider = vi.fn().mockReturnValue({ removed: true })
    getProvider = vi.fn().mockReturnValue(undefined)
    updateToolPermissions = vi.fn()
    loadSkills = vi.fn().mockReturnValue([])
    saveSkills = vi.fn()
    loadAgents = vi.fn().mockReturnValue([])
    saveAgents = vi.fn()
    scanSkills = vi.fn().mockReturnValue([])
    scanAgents = vi.fn().mockReturnValue([])
  },
}))

vi.mock('../src/services/model-service.js', () => ({
  ModelService: class MockModelService {
    aggregateModels = vi.fn().mockReturnValue([])
    discoverModelsFromApi = vi.fn().mockResolvedValue([])
  },
}))

vi.mock('../src/services/plugin-service/plugin-service.js', () => ({
  PluginService: class MockPluginService {
    getDiscoveredPlugins = vi.fn().mockReturnValue([])
    togglePlugin = vi.fn().mockResolvedValue([])
    initialize = vi.fn().mockResolvedValue(undefined)
    shutdown = vi.fn().mockResolvedValue(undefined)
  },
}))

vi.mock('../src/infra/pi/process-manager.js', () => ({
  ProcessManager: class MockProcessManager {
    createSession = vi.fn()
    destroySession = vi.fn().mockResolvedValue(undefined)
    getClient = vi.fn()
    hasClient = vi.fn().mockReturnValue(false)
    destroyAll = vi.fn().mockResolvedValue(undefined)
    onSessionExit = vi.fn()
    rekey = vi.fn()
    getSessionIdByClient = vi.fn()
  },
}))

vi.mock('../src/infra/pi/event-adapter.js', () => ({
  EventAdapter: class MockEventAdapter {
    attach = vi.fn()
    detach = vi.fn()
  },
}))

vi.mock('../src/services/scanners/skill-scanner.js', () => ({
  scanSkills: vi.fn().mockReturnValue([]),
}))

vi.mock('../src/services/scanners/agent-scanner.js', () => ({
  scanAgents: vi.fn().mockReturnValue([]),
}))

// pi-config-bridge 已拆分：model/settings → pi-provider-store，session 扫描 → session-file-utils，
// 路径 → pi-paths。按实际 import 来源 mock 各符号（其余实现保留原模块）。
vi.mock('../src/infra/pi/pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-provider-store.js')>()
  return {
    ...actual,
    getDefaultModel: () => ({ provider: 'test', modelId: 'provider-model' }),
    getSkillPaths: () => [],
    readModels: () => ({ providers: {} }),
    readSettings: () => ({}),
    refreshAll: () => {},
  }
})
vi.mock('../src/infra/pi/session-file-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/session-file-utils.js')>()
  return { ...actual, scanPiSessions: () => [] }
})
vi.mock('../src/infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-paths.js')>()
  return { ...actual, getSessionsDir: () => '/mock/sessions' }
})

vi.mock('../src/services/extension-service.js', () => {
  return {
    ExtensionService: class MockExtensionService {
      scanExtensions = vi.fn().mockResolvedValue([])
      getEnabledExtensions = vi.fn().mockResolvedValue([])
      toggleExtension = vi.fn().mockResolvedValue(undefined)
      getExtensionPaths = vi.fn().mockResolvedValue([])
    },
  }
})

vi.mock('../src/infra/system/trash.js', () => ({
  trash: vi.fn(),
}))

import { RuntimeServer } from '../src/transport/server.js'
import { SessionService } from '../src/services/session/session-service.js'
import { PluginService } from '../src/services/plugin-service/plugin-service.js'

// ── EventAdapter unit tests (using vi.importActual to bypass mock) ──

// Helper to create a mock client compatible with EventAdapter.attach
function makeMockClient() {
  return {
    onEvent: vi.fn((listener: (event: Record<string, unknown>) => void) => {
      // store the listener for test invocation
      return () => {}
    }),
  }
}

function attachAndEmit(adapter: any, mockClient: { onEvent: ReturnType<typeof vi.fn> }, event: Record<string, unknown>): void {
  mockClient.onEvent.mockImplementationOnce((listener: (event: Record<string, unknown>) => void) => {
    listener(event)
    return () => {}
  })
  adapter.attach(mockClient as never)
}

describe('EventAdapter: bridge method detection', () => {
  it('detects bridge: prefix in extension_ui_request and calls callback', async () => {
    const bridgeCallback = vi.fn()
    const wsSender = vi.fn()
    const adapter = await buildRealAdapter('test-session', wsSender, {
      onBridgeUIRequest: bridgeCallback,
    })

    const mockClient = makeMockClient()
    const event = {
      type: 'extension_ui_request' as const,
      method: 'bridge:sync',
      id: 'bridge-req-1',
    }

    attachAndEmit(adapter, mockClient, event)
    await new Promise((r) => setTimeout(r, 50))

    expect(bridgeCallback).toHaveBeenCalledTimes(1)
    expect(bridgeCallback).toHaveBeenCalledWith(
      'bridge-req-1',
      'test-session',
      'bridge:sync',
      expect.any(Object),
    )

    // Bridge message should NOT be forwarded to the frontend (WsSender)
    expect(wsSender).not.toHaveBeenCalled()
  })

  it('routes multiple bridge methods without frontend timeout registration', async () => {
    const bridgeCallback = vi.fn()
    const extensionCallback = vi.fn()
    const wsSender = vi.fn()
    const adapter = await buildRealAdapter('test-session', wsSender, {
      onExtensionUIRequest: extensionCallback,
      onBridgeUIRequest: bridgeCallback,
    })

    const methods = ['bridge:sync', 'bridge:tool_execute', 'bridge:event', 'bridge:intercept', 'bridge:append_entry']

    for (const method of methods) {
      bridgeCallback.mockClear()
      extensionCallback.mockClear()
      wsSender.mockClear()

      const event = { type: 'extension_ui_request' as const, method, id: `req-${method}` }
      const mockClient = makeMockClient()
      attachAndEmit(adapter, mockClient, event)
      await new Promise((r) => setTimeout(r, 50))
      adapter.detach()

      expect(bridgeCallback).toHaveBeenCalledTimes(1)
      expect(extensionCallback).not.toHaveBeenCalled()
      expect(wsSender).not.toHaveBeenCalled()
    }
  })

  it('does not interfere with non-bridge extension_ui_request methods', async () => {
    const extensionCallback = vi.fn()
    const bridgeCallback = vi.fn()
    const wsSender = vi.fn()
    const adapter = await buildRealAdapter('test-session', wsSender, {
      onExtensionUIRequest: extensionCallback,
      onBridgeUIRequest: bridgeCallback,
    })

    const event = {
      type: 'extension_ui_request' as const,
      method: 'confirm',
      id: 'confirm-req-1',
      title: 'Test confirm',
      message: 'Are you sure?',
    }

    const mockClient = makeMockClient()
    attachAndEmit(adapter, mockClient, event)
    await new Promise((r) => setTimeout(r, 50))

    expect(bridgeCallback).not.toHaveBeenCalled()
    expect(extensionCallback).toHaveBeenCalledTimes(1)
  })
})

// ── Server bridge routing tests ──────────────────────────────────

describe('RuntimeServer: bridge request routing', () => {
  let server: RuntimeServer

  beforeEach(() => {
    vi.useFakeTimers()
    mockSendCommand.mockClear()
    server = new RuntimeServer(0, '/tmp/test-project')
    const sessionService = new SessionService({} as never, {} as never, {} as never, '/tmp', {} as never, {} as never, {} as never, noopGitInfoReader, {} as never)
    const pluginService = new PluginService({} as never, server)
    server.setServices(
      sessionService,
      {} as never,
      {} as never,
      {} as never,
      pluginService,
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('bridge:sync', () => {
    it('sends tools and commands response via extension_ui_response', async () => {
      await server.handleBridgeRequest('sess-1', 'bridge-req-1', 'bridge:sync', {})

      expect(mockSendCommand).toHaveBeenCalledWith(
        'extension_ui_response',
        expect.objectContaining({
          id: 'bridge-req-1',
          response: expect.objectContaining({
            tools: expect.any(Array),
            commands: expect.any(Array),
            success: true,
          }),
        }),
      )
    })

    it('aggregates tools from plugin contributions', async () => {
      const pluginService = new PluginService({} as never, server)
      // Override getDiscoveredPlugins to return a plugin (PluginInfo[]; tools
      // are now surfaced via getBridgeSyncPayload, not descriptor contributes)
      vi.mocked(pluginService.getDiscoveredPlugins).mockReturnValue([
        {
          pluginId: 'test-plugin',
          version: '1.0.0',
          displayName: 'Test Plugin',
          description: 'A test plugin',
          status: 'active',
          trustLevel: 'sandbox',
          enabled: true,
        },
      ])

      // Re-set services to use the overridden mock
      const sessionService = new SessionService({} as never, {} as never, {} as never, '/tmp', {} as never, {} as never, {} as never, noopGitInfoReader, {} as never)
      server.setServices(sessionService, {} as never, {} as never, {} as never, pluginService)
      mockSendCommand.mockClear()

      await server.handleBridgeRequest('sess-1', 'bridge-req-2', 'bridge:sync', {})

      const callArgs = mockSendCommand.mock.calls[0]
      const response = callArgs[1].response as Record<string, unknown>

      expect(response.tools).toHaveLength(0)
      expect(response.commands).toHaveLength(0)
      expect(response.success).toBe(true)
    })
  })

  describe('bridge:tool_execute', () => {
    it('sends tool execution response', async () => {
      await server.handleBridgeRequest('sess-1', 'bridge-req-exec', 'bridge:tool_execute', {
        toolName: 'hello',
        params: { name: 'world' },
      })

      expect(mockSendCommand).toHaveBeenCalledWith(
        'extension_ui_response',
        expect.objectContaining({
          id: 'bridge-req-exec',
        }),
      )
    })
  })

  describe('bridge:event', () => {
    it('sends null response for fire-and-forget events', async () => {
      await server.handleBridgeRequest('sess-1', 'bridge-req-ev', 'bridge:event', {
        eventName: 'agent_start',
        eventData: { sessionId: 'sess-1' },
      })

      expect(mockSendCommand).toHaveBeenCalledWith(
        'extension_ui_response',
        expect.objectContaining({
          id: 'bridge-req-ev',
          response: null,
        }),
      )
    })
  })

  describe('bridge:intercept', () => {
    it('sends empty response for interception', async () => {
      await server.handleBridgeRequest('sess-1', 'bridge-req-int', 'bridge:intercept', {
        eventName: 'before_agent_start',
        data: { sessionId: 'sess-1', query: 'hello' },
      })

      expect(mockSendCommand).toHaveBeenCalledWith(
        'extension_ui_response',
        expect.objectContaining({
          id: 'bridge-req-int',
          response: expect.any(Object),
        }),
      )
    })
  })

  describe('unknown bridge method', () => {
    it('sends error response for unknown method', async () => {
      await server.handleBridgeRequest('sess-1', 'bridge-req-unk', 'bridge:unknown_method', {})

      expect(mockSendCommand).toHaveBeenCalledWith(
        'extension_ui_response',
        expect.objectContaining({
          id: 'bridge-req-unk',
          response: expect.objectContaining({
            error: expect.stringContaining('Unknown bridge method'),
          }),
        }),
      )
    })
  })
})

// ── Extension timeout: bridge message exclusion ──────────────────

describe('RuntimeServer: bridge timeout exclusion', () => {
  let server: RuntimeServer

  beforeEach(() => {
    vi.useFakeTimers()
    mockSendCommand.mockClear()
    server = new RuntimeServer(0, '/tmp/test-project')
    server.setServices(
      new SessionService({} as never, {} as never, {} as never, '/tmp', {} as never, {} as never, {} as never, noopGitInfoReader, {} as never),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does NOT register frontend timeout for bridge: methods', () => {
    server.registerExtensionTimeout('sess-1', 'req-bridge-sync', 'bridge:sync')
    server.registerExtensionTimeout('sess-1', 'req-bridge-exec', 'bridge:tool_execute')
    server.registerExtensionTimeout('sess-1', 'req-bridge-ev', 'bridge:event')
    server.registerExtensionTimeout('sess-1', 'req-bridge-int', 'bridge:intercept')

    // Advance time past the normal timeout duration
    vi.advanceTimersByTime(300_000)

    // No timeout responses should be sent for bridge methods
    expect(mockSendCommand).not.toHaveBeenCalled()
  })

  it('tracks bridge requestIds in bridgeRequestIds set', () => {
    server.registerExtensionTimeout('sess-1', 'req-bridge-track', 'bridge:sync')

    // Bridge requestIds should be tracked
    const mgr = (server as unknown as { extensionTimeoutMgr: { isBridgeRequest(id: string): boolean } }).extensionTimeoutMgr
    expect(mgr.isBridgeRequest('req-bridge-track')).toBe(true)
  })

  it('still registers normal timeout for non-bridge methods', () => {
    server.registerExtensionTimeout('sess-1', 'req-confirm', 'confirm')

    vi.advanceTimersByTime(300_000)

    // Normal confirm should timeout after 5 minutes
    expect(mockSendCommand).toHaveBeenCalledWith(
      'extension_ui_response',
      expect.objectContaining({
        id: 'req-confirm',
        response: false,
      }),
    )
  })
})

// ── Bridge extension message format validation ───────────────────

describe('Bridge extension message format', () => {
  it('bridge:sync request format has method and optional data', () => {
    const msg = { method: 'bridge:sync' }
    expect(msg).toHaveProperty('method')
    expect(msg.method).toBe('bridge:sync')
  })

  it('bridge:sync response format has tools array', () => {
    const response = { tools: [], commands: [], success: true }
    expect(response).toHaveProperty('tools')
    expect(Array.isArray(response.tools)).toBe(true)
    expect(response).toHaveProperty('commands')
    expect(Array.isArray(response.commands)).toBe(true)
    expect(response).toHaveProperty('success')
  })

  it('bridge:tool_execute request format has toolName and params', () => {
    const msg = { method: 'bridge:tool_execute', toolName: 'hello', params: { arg1: 'value1' }, toolCallId: 'tc-1', sessionId: 'sess-1' }
    expect(msg).toHaveProperty('method', 'bridge:tool_execute')
    expect(msg).toHaveProperty('toolName')
    expect(msg).toHaveProperty('params')
    expect(msg).toHaveProperty('toolCallId')
    expect(msg).toHaveProperty('sessionId')
  })

  it('bridge:event request format has eventName and data', () => {
    const msg = { method: 'bridge:event', eventName: 'agent_start', data: { sessionId: 'sess-1', query: 'hello' }, sessionId: 'sess-1' }
    expect(msg).toHaveProperty('method', 'bridge:event')
    expect(msg).toHaveProperty('eventName')
    expect(msg).toHaveProperty('data')
    expect(msg).toHaveProperty('sessionId')
  })

  it('bridge:intercept request format has eventName, data, sessionId', () => {
    const msg = { method: 'bridge:intercept', eventName: 'before_agent_start', data: { sessionId: 'sess-1' }, sessionId: 'sess-1' }
    expect(msg).toHaveProperty('method', 'bridge:intercept')
    expect(msg).toHaveProperty('eventName')
    expect(msg).toHaveProperty('data')
    expect(msg).toHaveProperty('sessionId')
  })

  it('bridge:intercept response can contain injectedMessages', () => {
    const resp = {
      injectedMessages: [
        { role: 'user', content: 'system message from plugin' },
        { role: 'assistant', content: 'plugin response' },
      ],
    }
    expect(resp).toHaveProperty('injectedMessages')
    expect(resp.injectedMessages).toHaveLength(2)
    expect(resp.injectedMessages[0]).toHaveProperty('role', 'user')
    expect(resp.injectedMessages[0]).toHaveProperty('content')
  })

  it('tool entry in bridge:sync response has name, description, parameters', () => {
    const tool = {
      name: 'hello',
      description: 'Says hello',
      parameters: { type: 'object', properties: { name: { type: 'string' } } },
    }
    expect(tool).toHaveProperty('name')
    expect(tool).toHaveProperty('description')
    expect(tool).toHaveProperty('parameters')
  })
})
