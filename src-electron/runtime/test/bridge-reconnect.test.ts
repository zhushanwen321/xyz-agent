/**
 * Bridge Reconnect Tests.
 *
 * Tests the bridge connection lifecycle between pi (extension) and sidecar (runtime).
 * The bridge is the pi RPC connection through which extension_ui_request messages
 * with 'bridge:' method prefix are routed.
 *
 * Test strategy:
 * - Mock SessionService.getRpcClient to simulate connected/disconnected states
 * - Mock PluginService.handleBridgeToolExecute/handleBridgeIntercept/getToolSchemas
 * - Test handleBridgeRequest under various reconnection scenarios
 * - Test registerExtensionTimeout for bridge: methods (timeout exclusion)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mocks ────────────────────────────────────────────────────────

const mockSendCommand = vi.fn().mockResolvedValue({ success: true })

/** Mock RPC client that can be set to null to simulate disconnect */
let mockRpcClient: ReturnType<typeof createMockRpcClient> | null = createMockRpcClient()

function createMockRpcClient() {
  return {
    sendCommand: mockSendCommand,
    onEvent: vi.fn().mockReturnValue(() => {}),
    onExit: vi.fn(),
    exited: false,
    kill: vi.fn(),
    start: vi.fn(),
  }
}

const mockGetToolSchemas = vi.fn()
const mockHandleBridgeToolExecute = vi.fn()
const mockHandleBridgeIntercept = vi.fn()

vi.mock('../src/services/session/session-service.js', () => {
  return {
    SessionService: class MockSessionService {
      sendMessage = vi.fn().mockResolvedValue(undefined)
      sendSubagentMessage = vi.fn().mockResolvedValue(undefined)
      listPersistedSessions = vi.fn().mockReturnValue([])
      getSummary = vi.fn().mockReturnValue(undefined)
      getHistory = vi.fn().mockResolvedValue([])
      create = vi.fn().mockResolvedValue({ id: 'reconnect-test-session', cwd: '/tmp', status: 'active' })
      delete = vi.fn().mockResolvedValue(undefined)
      destroyAll = vi.fn().mockResolvedValue(undefined)
      clear = vi.fn().mockResolvedValue(undefined)
      renameSession = vi.fn().mockResolvedValue(undefined)
      restoreSession = vi.fn().mockResolvedValue({ id: 'reconnect-test-session', cwd: '/tmp', status: 'active' })
      hasActiveSession = vi.fn().mockReturnValue(true)
      compact = vi.fn().mockResolvedValue(undefined)
      abort = vi.fn().mockResolvedValue(undefined)
      switchModel = vi.fn().mockResolvedValue(undefined)
      getRpcClient = vi.fn().mockImplementation(() => mockRpcClient)
    }
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
    getToolSchemas = mockGetToolSchemas
    handleBridgeToolExecute = mockHandleBridgeToolExecute
    handleBridgeIntercept = mockHandleBridgeIntercept
  }
}))

vi.mock('../src/infra/process-manager.js', () => ({
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

vi.mock('../src/adapters/event-adapter.js', () => ({
  EventAdapter: class MockEventAdapter {
    attach = vi.fn()
    detach = vi.fn()
  },
}))

vi.mock('../src/infra/skill-scanner.js', () => ({
  scanSkills: vi.fn().mockReturnValue([]),
}))

vi.mock('../src/infra/agent-scanner.js', () => ({
  scanAgents: vi.fn().mockReturnValue([]),
}))

vi.mock('../src/adapters/pi-config-bridge.js', () => ({
  getDefaultModel: () => ({ provider: 'test', modelId: 'provider-model' }),
  getSkillPaths: () => [],
  getSessionsDir: () => '/mock/sessions',
  readModels: () => ({ providers: {} }),
  readSettings: () => ({}),
  scanPiSessions: () => [],
  refreshAll: () => {},
}))

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

vi.mock('../src/infra/trash.js', () => ({
  trash: vi.fn(),
}))

import { RuntimeServer } from '../src/transport/server.js'
import { SessionService } from '../src/services/session/session-service.js'
import { PluginService } from '../src/services/plugin-service/plugin-service.js'

const SESSION_ID = 'reconnect-session'
const SIDECAR_RESTART_TOOLS = [
  { name: 'hello', description: 'Says hello', parameters: { type: 'object', properties: {} } },
]
const NEW_TOOLS_AFTER_RESTART = [
  { name: 'hello', description: 'Says hello', parameters: { type: 'object', properties: {} } },
  { name: 'goodbye', description: 'Says goodbye', parameters: { type: 'object', properties: {} } },
]

// ── Tests ────────────────────────────────────────────────────────

describe('Bridge reconnect lifecycle', () => {
  let server: RuntimeServer

  beforeEach(() => {
    vi.useFakeTimers()
    mockSendCommand.mockClear()
    mockGetToolSchemas.mockClear()
    mockHandleBridgeToolExecute.mockClear()
    mockHandleBridgeIntercept.mockClear()
    mockRpcClient = createMockRpcClient()
    server = new RuntimeServer(0, '/tmp/test-project')
    const sessionService = new SessionService({} as never, {} as never, {} as never, '/tmp', {} as never, {} as never)
    const pluginService = new PluginService({} as never, server)
    server.setServices(
      sessionService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      pluginService,
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ── Scenario 1: Disconnected → Syncing → Ready ────────────────

  describe('Disconnected → Syncing → Ready', () => {
    it('fails silently when RPC client is unavailable (disconnected)', async () => {
      mockRpcClient = null

      await server.handleBridgeRequest(SESSION_ID, 'req-1', 'bridge:sync', {})

      // No sendCommand should be called since there's no RPC client
      expect(mockSendCommand).not.toHaveBeenCalled()
    })

    it('succeeds when RPC client becomes available (reconnected)', async () => {
      mockRpcClient = createMockRpcClient()
      mockGetToolSchemas.mockReturnValue(SIDECAR_RESTART_TOOLS)
      mockSendCommand.mockClear()

      await server.handleBridgeRequest(SESSION_ID, 'req-2', 'bridge:sync', {})

      expect(mockSendCommand).toHaveBeenCalledTimes(1)
      const callArgs = mockSendCommand.mock.calls[0]
      expect(callArgs[0]).toBe('extension_ui_response')
      expect(callArgs[1]).toMatchObject({
        id: 'req-2',
        response: expect.objectContaining({
          success: true,
          tools: SIDECAR_RESTART_TOOLS,
        }),
      })
    })

    it('complete lifecycle: disconnected → syncing → ready with tools', async () => {
      // Phase 1: Disconnected — bridge sync fails silently
      mockRpcClient = null
      await server.handleBridgeRequest(SESSION_ID, 'req-p1', 'bridge:sync', {})
      expect(mockSendCommand).not.toHaveBeenCalled()

      // Phase 2: RPC client appears, bridge sync starts
      mockRpcClient = createMockRpcClient()
      mockGetToolSchemas.mockReturnValue([
        { name: 'goal_manager', description: 'Manages goals', parameters: { type: 'object', properties: {} } },
      ])
      mockSendCommand.mockClear()

      await server.handleBridgeRequest(SESSION_ID, 'req-p2', 'bridge:sync', {})
      expect(mockSendCommand).toHaveBeenCalledTimes(1)

      const response = mockSendCommand.mock.calls[0][1].response
      expect(response.success).toBe(true)
      expect(response.tools).toHaveLength(1)
      expect(response.tools[0].name).toBe('goal_manager')
    })
  })

  // ── Scenario 2: Sidecar restart → auto-reconnect ──────────────

  describe('Sidecar restart → auto-reconnect', () => {
    it('re-registers tools after sidecar restart via bridge:sync', async () => {
      // Initial registration
      mockGetToolSchemas.mockReturnValue(SIDECAR_RESTART_TOOLS)
      await server.handleBridgeRequest(SESSION_ID, 'req-init', 'bridge:sync', {})
      expect(mockSendCommand).toHaveBeenCalledTimes(1)

      // Simulate sidecar restart: clear tool schemas, then re-register
      mockGetToolSchemas.mockReturnValue(NEW_TOOLS_AFTER_RESTART)
      mockSendCommand.mockClear()

      await server.handleBridgeRequest(SESSION_ID, 'req-restart', 'bridge:sync', {})

      expect(mockSendCommand).toHaveBeenCalledTimes(1)
      const response = mockSendCommand.mock.calls[0][1].response
      expect(response.tools).toHaveLength(2)
      expect(response.tools[0].name).toBe('hello')
      expect(response.tools[1].name).toBe('goodbye')
    })

    it('sends empty tool list when no plugins are active after restart', async () => {
      mockGetToolSchemas.mockReturnValue([])

      await server.handleBridgeRequest(SESSION_ID, 'req-empty', 'bridge:sync', {})

      expect(mockSendCommand).toHaveBeenCalledTimes(1)
      const response = mockSendCommand.mock.calls[0][1].response
      expect(response.tools).toHaveLength(0)
      expect(response.commands).toHaveLength(0)
      expect(response.success).toBe(true)
    })
  })

  // ── Scenario 3: Sync timeout handling ─────────────────────────

  describe('Sync timeout (bridge timeout exclusion)', () => {
    it('does NOT register frontend timeout for bridge:sync', () => {
      server.registerExtensionTimeout(SESSION_ID, 'req-bridge-sync', 'bridge:sync')

      vi.advanceTimersByTime(300_000)

      // No timeout response for bridge methods
      expect(mockSendCommand).not.toHaveBeenCalled()
    })

    it('tracks bridge request IDs for session cleanup', () => {
      server.registerExtensionTimeout(SESSION_ID, 'req-bridge', 'bridge:sync')
      server.registerExtensionTimeout(SESSION_ID, 'req-bridge2', 'bridge:tool_execute')

      // Bridge request IDs should be tracked internally
      const mgr = (server as unknown as { extensionTimeoutMgr: { isBridgeRequest(id: string): boolean } }).extensionTimeoutMgr
      expect(mgr.isBridgeRequest('req-bridge')).toBe(true)
      expect(mgr.isBridgeRequest('req-bridge2')).toBe(true)
    })
  })

  // ── Scenario 4: Tool execute during reconnect ─────────────────

  describe('Bridge tool execute during reconnect', () => {
    it('returns error when no tools registered (during reconnect)', async () => {
      mockGetToolSchemas.mockReturnValue([])
      mockHandleBridgeToolExecute.mockResolvedValue({
        content: 'Tool not found: unknown_tool',
        isError: true,
      })

      await server.handleBridgeRequest(SESSION_ID, 'req-exec', 'bridge:tool_execute', {
        toolName: 'unknown_tool',
        params: {},
        toolCallId: 'tc-1',
      })

      expect(mockSendCommand).toHaveBeenCalledTimes(1)
      const response = mockSendCommand.mock.calls[0][1].response
      expect(response.isError).toBe(true)
      expect(response.content).toContain('Tool not found')
    })

    it('executes tool when bridge is ready', async () => {
      mockHandleBridgeToolExecute.mockResolvedValue({
        content: JSON.stringify({ result: 'hello world' }),
        isError: false,
      })

      await server.handleBridgeRequest(SESSION_ID, 'req-exec2', 'bridge:tool_execute', {
        toolName: 'hello',
        params: { name: 'world' },
        toolCallId: 'tc-2',
      })

      expect(mockSendCommand).toHaveBeenCalledTimes(1)
      const response = mockSendCommand.mock.calls[0][1].response
      expect(response.isError).toBeFalsy()
      expect(response.content).toBe(JSON.stringify({ result: 'hello world' }))
    })

    it('returns error when plugin service is not available', async () => {
      const serverWithoutPlugin = new RuntimeServer(0, '/tmp/test-project')
      const sessionService = new SessionService({} as never, {} as never, {} as never, '/tmp', {} as never, {} as never)
      // No plugin service set
      serverWithoutPlugin.setServices(sessionService, {} as never, {} as never, {} as never, {} as never)

      await serverWithoutPlugin.handleBridgeRequest(SESSION_ID, 'req-exec3', 'bridge:tool_execute', {
        toolName: 'hello',
        params: {},
      })

      expect(mockSendCommand).toHaveBeenCalledWith(
        'extension_ui_response',
        expect.objectContaining({
          id: 'req-exec3',
          response: { content: 'Plugin system not available', isError: true },
        }),
      )
    })
  })

  // ── Scenario 5: Event during reconnect ─────────────────────────

  describe('Bridge event during reconnect', () => {
    it('sends null response for fire-and-forget events even during reconnect', async () => {
      // bridge:event always sends null response regardless of state
      await server.handleBridgeRequest(SESSION_ID, 'req-ev', 'bridge:event', {
        eventName: 'agent_start',
        eventData: { sessionId: SESSION_ID },
      })

      expect(mockSendCommand).toHaveBeenCalledTimes(1)
      expect(mockSendCommand).toHaveBeenCalledWith(
        'extension_ui_response',
        expect.objectContaining({
          id: 'req-ev',
          response: null,
        }),
      )
    })

    it('handles multiple events in sequence during reconnect', async () => {
      // Simulate events being fired during reconnection
      for (let i = 0; i < 3; i++) {
        await server.handleBridgeRequest(SESSION_ID, `req-ev-${i}`, 'bridge:event', {
          eventName: 'agent_step',
          eventData: { sessionId: SESSION_ID, step: i },
        })
      }

      expect(mockSendCommand).toHaveBeenCalledTimes(3)
      for (let i = 0; i < 3; i++) {
        expect(mockSendCommand).toHaveBeenNthCalledWith(
          i + 1,
          'extension_ui_response',
          expect.objectContaining({ id: `req-ev-${i}`, response: null }),
        )
      }
    })
  })

  // ── Scenario 6: Bridge reconnect after pi crash ───────────────

  describe('Bridge reconnect after pi crash', () => {
    it('pi crash: bridge request returns nothing when client gone', async () => {
      mockRpcClient = null

      await server.handleBridgeRequest(SESSION_ID, 'req-crash', 'bridge:sync', {})

      expect(mockSendCommand).not.toHaveBeenCalled()
    })

    it('pi restart: new RPC client re-syncs tools', async () => {
      mockRpcClient = createMockRpcClient()
      mockGetToolSchemas.mockReturnValue(SIDECAR_RESTART_TOOLS)
      mockSendCommand.mockClear()

      await server.handleBridgeRequest(SESSION_ID, 'req-restore', 'bridge:sync', {})

      expect(mockSendCommand).toHaveBeenCalledTimes(1)
      const response = mockSendCommand.mock.calls[0][1].response
      expect(response.success).toBe(true)
      expect(response.tools).toHaveLength(1)
    })

    it('pi crash + restart: full lifecycle with tool execute after restart', async () => {
      // 1. pi is running, tools synced
      mockGetToolSchemas.mockReturnValue(SIDECAR_RESTART_TOOLS)
      await server.handleBridgeRequest(SESSION_ID, 'req-s1', 'bridge:sync', {})
      expect(mockSendCommand).toHaveBeenCalledTimes(1)

      // 2. pi crashes — RPC client disappears
      mockRpcClient = null

      // 3. Bridge request during crash — silent failure
      mockSendCommand.mockClear()
      await server.handleBridgeRequest(SESSION_ID, 'req-s2', 'bridge:sync', {})
      expect(mockSendCommand).not.toHaveBeenCalled()

      // 4. Tool execute during crash — silent failure
      await server.handleBridgeRequest(SESSION_ID, 'req-s3', 'bridge:tool_execute', {
        toolName: 'hello',
        params: {},
      })
      expect(mockSendCommand).not.toHaveBeenCalled()

      // 5. pi restarts — new RPC client
      mockRpcClient = createMockRpcClient()

      // 6. Tools re-synced
      mockSendCommand.mockClear()
      await server.handleBridgeRequest(SESSION_ID, 'req-s4', 'bridge:sync', {})
      expect(mockSendCommand).toHaveBeenCalledTimes(1)
      expect(mockSendCommand.mock.calls[0][1].response.success).toBe(true)

      // 7. Tool execute works again
      mockHandleBridgeToolExecute.mockResolvedValue({
        content: JSON.stringify({ result: 'post-restart' }),
        isError: false,
      })
      mockSendCommand.mockClear()
      await server.handleBridgeRequest(SESSION_ID, 'req-s5', 'bridge:tool_execute', {
        toolName: 'hello',
        params: {},
        toolCallId: 'tc-restart',
      })
      expect(mockSendCommand).toHaveBeenCalledTimes(1)
      expect(mockSendCommand.mock.calls[0][1].response.content).toContain('post-restart')
    })
  })

  // ── Bridge intercept during reconnect ─────────────────────────

  describe('Bridge intercept during reconnect', () => {
    it('handles bridge:intercept when plugin service is available', async () => {
      mockHandleBridgeIntercept.mockResolvedValue({ injectedMessages: [] })

      await server.handleBridgeRequest(SESSION_ID, 'req-int', 'bridge:intercept', {
        eventName: 'before_agent_start',
        data: { sessionId: SESSION_ID, query: 'hello' },
      })

      expect(mockSendCommand).toHaveBeenCalledTimes(1)
      expect(mockSendCommand).toHaveBeenCalledWith(
        'extension_ui_response',
        expect.objectContaining({
          id: 'req-int',
          response: { injectedMessages: [] },
        }),
      )
    })

    it('returns empty intercept when plugin service is not available', async () => {
      const serverWithoutPlugin = new RuntimeServer(0, '/tmp/test-project')
      const sessionService = new SessionService({} as never, {} as never, {} as never, '/tmp', {} as never, {} as never)
      serverWithoutPlugin.setServices(sessionService, {} as never, {} as never, {} as never, {} as never)

      mockSendCommand.mockClear()
      await serverWithoutPlugin.handleBridgeRequest(SESSION_ID, 'req-int2', 'bridge:intercept', {
        eventName: 'before_agent_start',
        data: { sessionId: SESSION_ID },
      })

      expect(mockSendCommand).toHaveBeenCalledWith(
        'extension_ui_response',
        expect.objectContaining({
          id: 'req-int2',
          response: {},
        }),
      )
    })
  })

  // ── Unknown bridge method ──────────────────────────────────────

  describe('Unknown bridge method', () => {
    it('returns error for unknown bridge method', async () => {
      await server.handleBridgeRequest(SESSION_ID, 'req-unk', 'bridge:unknown', {})

      expect(mockSendCommand).toHaveBeenCalledWith(
        'extension_ui_response',
        expect.objectContaining({
          id: 'req-unk',
          response: expect.objectContaining({
            error: expect.stringContaining('Unknown bridge method'),
          }),
        }),
      )
    })
  })
})
