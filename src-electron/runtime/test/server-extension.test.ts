import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebSocket } from 'ws'

/**
 * Task 3 tests: Server extension UI response routing.
 *
 * Test strategy:
 * - Basic routing (ui_response, list, toggle) uses real timers via WS
 * - Timeout mechanism tested directly via registerExtensionTimeout + cleanupExtensionTimeouts
 * - Session cleanup tested via clearExtensionTimeoutsForSession
 */

// ── Mocks ────────────────────────────────────────────────────────

const mockSendCommand = vi.fn().mockResolvedValue({ success: true })

vi.mock('../src/services/session-service.js', () => {
  return {
    SessionService: class MockSessionService {
      sendMessage = vi.fn().mockResolvedValue(undefined)
      sendSubagentMessage = vi.fn().mockResolvedValue(undefined)
      listPersistedSessions = vi.fn().mockReturnValue([])
      getSummary = vi.fn().mockReturnValue(undefined)
      getHistory = vi.fn().mockResolvedValue([])
      create = vi.fn().mockResolvedValue({ id: 'test-session-id', cwd: '/tmp', status: 'active' })
      delete = vi.fn().mockResolvedValue(undefined)
      destroyAll = vi.fn().mockResolvedValue(undefined)
      clear = vi.fn().mockResolvedValue(undefined)
      renameSession = vi.fn().mockResolvedValue(undefined)
      restoreSession = vi.fn().mockResolvedValue({ id: 'test-session-id', cwd: '/tmp', status: 'active' })
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
    deleteProvider = vi.fn().mockReturnValue(true)
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

vi.mock('../src/process-manager.js', () => ({
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

vi.mock('../src/event-adapter.js', () => ({
  EventAdapter: class MockEventAdapter {
    attach = vi.fn()
    detach = vi.fn()
  },
}))

vi.mock('../src/config-store.js', () => ({
  updateToolPermissions: vi.fn(),
  getProvider: vi.fn().mockReturnValue(undefined),
  getDefaultModel: vi.fn().mockReturnValue('test/model'),
}))

vi.mock('../src/skill-scanner.js', () => ({
  scanSkills: vi.fn().mockReturnValue([]),
}))

vi.mock('../src/agent-scanner.js', () => ({
  scanAgents: vi.fn().mockReturnValue([]),
}))

vi.mock('../src/pi-config-bridge.js', () => ({
  getDefaultModel: () => ({ provider: 'test', modelId: 'provider-model' }),
  getSkillPaths: () => [],
  getSessionsDir: () => '/mock/sessions',
  readModels: () => ({ providers: {} }),
  readSettings: () => ({}),
  scanPiSessions: () => [],
  refreshAll: () => {},
}))

vi.mock('../src/extension-service.js', () => {
  return {
    ExtensionService: class MockExtensionService {
      scanExtensions = vi.fn().mockResolvedValue([])
      getEnabledExtensions = vi.fn().mockResolvedValue([])
      toggleExtension = vi.fn().mockResolvedValue(undefined)
      getExtensionPaths = vi.fn().mockResolvedValue([])
    },
  }
})

vi.mock('../src/trash.js', () => ({
  trash: vi.fn(),
}))

import { SidecarServer } from '../src/server.js'
import { SessionService } from '../src/services/session-service.js'
import { ConfigService } from '../src/services/config-service.js'
import { ModelService } from '../src/services/model-service.js'
import { ExtensionService } from '../src/extension-service.js'

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = require('node:http').createServer()
    server.listen(0, () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') {
        const port = addr.port
        server.close(() => resolve(port))
      } else {
        reject(new Error('Failed to get port'))
      }
    })
  })
}

function waitForMessage(ws: WebSocket, type: string, timeout = 2000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', handler)
      reject(new Error(`Timed out waiting for message type "${type}"`))
    }, timeout)
    const handler = (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === type) {
          clearTimeout(timer)
          ws.off('message', handler)
          resolve(msg)
        }
      } catch { /* skip */ }
    }
    ws.on('message', handler)
  })
}

// ── Tests with real timers (basic routing) ────────────────────────

describe('SidecarServer: extension message routing', () => {
  let server: SidecarServer
  let port: number
  let ws: WebSocket
  let sessionService: SessionService

  beforeEach(async () => {
    mockSendCommand.mockClear()
    port = await getFreePort()
    server = new SidecarServer(port, '/tmp/test-project')
    sessionService = new SessionService({} as never, {} as never, {} as never, '/tmp', {} as never, {} as never)
    server.setServices(
      sessionService,
      new ConfigService('/tmp'),
      new ModelService(),
      {} as never,
      new ExtensionService(),
    )
    await server.start()
  })

  afterEach(async () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close()
    }
    await server.stop()
  })

  function connectClient(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      ws = new WebSocket(`ws://localhost:${port}`)
      ws.on('open', () => setTimeout(() => resolve(ws), 100))
      ws.on('error', reject)
    })
  }

  // ── extension.ui_response ────────────────────────────────────────

  describe('extension.ui_response', () => {
    it('forwards ui_response to pi via RpcClient', async () => {
      const client = await connectClient()

      ws.send(JSON.stringify({
        type: 'extension.ui_response',
        id: 'resp-1',
        payload: {
          sessionId: 'sess-1',
          requestId: 'req-1',
          result: true,
        },
      }))

      await new Promise((r) => setTimeout(r, 200))

      expect(sessionService.getRpcClient).toHaveBeenCalledWith('sess-1')
      expect(mockSendCommand).toHaveBeenCalledWith(
        'extension_ui_response',
        expect.objectContaining({
          id: 'req-1',
          response: true,
        }),
      )
    })

    it('handles string result', async () => {
      await connectClient()

      ws.send(JSON.stringify({
        type: 'extension.ui_response',
        id: 'resp-2',
        payload: {
          sessionId: 'sess-1',
          requestId: 'req-2',
          result: 'selected-value',
        },
      }))

      await new Promise((r) => setTimeout(r, 200))

      expect(mockSendCommand).toHaveBeenCalledWith(
        'extension_ui_response',
        expect.objectContaining({
          id: 'req-2',
          response: 'selected-value',
        }),
      )
    })

    it('handles null result', async () => {
      await connectClient()

      ws.send(JSON.stringify({
        type: 'extension.ui_response',
        id: 'resp-3',
        payload: {
          sessionId: 'sess-1',
          requestId: 'req-3',
          result: null,
        },
      }))

      await new Promise((r) => setTimeout(r, 200))

      expect(mockSendCommand).toHaveBeenCalledWith(
        'extension_ui_response',
        expect.objectContaining({
          id: 'req-3',
          response: null,
        }),
      )
    })

    it('sends error when RpcClient not found', async () => {
      vi.mocked(sessionService.getRpcClient).mockReturnValueOnce(undefined)
      await connectClient()

      const errorPromise = waitForMessage(ws, 'error')

      ws.send(JSON.stringify({
        type: 'extension.ui_response',
        id: 'resp-err',
        payload: {
          sessionId: 'unknown-session',
          requestId: 'req-err',
          result: true,
        },
      }))

      const errMsg = await errorPromise
      expect(errMsg.payload).toMatchObject({
        code: 'handler_error',
        sessionId: 'unknown-session',
      })
    })
  })

  // ── extension.list ───────────────────────────────────────────────

  describe('extension.list', () => {
    it('returns extension list from ExtensionService', async () => {
      await connectClient()

      const responsePromise = waitForMessage(ws, 'config.extensions')

      ws.send(JSON.stringify({
        type: 'extension.list',
        id: 'ext-list-1',
        payload: {},
      }))

      const msg = await responsePromise
      expect(msg.id).toBe('ext-list-1')
      expect(msg.payload).toMatchObject({ extensions: [] })
    })
  })

  // ── extension.toggle ─────────────────────────────────────────────

  describe('extension.toggle', () => {
    it('calls toggleExtension and returns updated list', async () => {
      await connectClient()

      const responsePromise = waitForMessage(ws, 'config.extensions')

      ws.send(JSON.stringify({
        type: 'extension.toggle',
        id: 'ext-toggle-1',
        payload: { name: 'my-ext', enabled: true },
      }))

      const msg = await responsePromise
      expect(msg.id).toBe('ext-toggle-1')
      expect(msg.payload).toMatchObject({ extensions: [] })
    })
  })
})

// ── Tests with fake timers (timeout mechanism) ────────────────────

describe('SidecarServer: extension timeout mechanism', () => {
  let server: SidecarServer
  let sessionService: SessionService

  beforeEach(() => {
    vi.useFakeTimers()
    mockSendCommand.mockClear()
    server = new SidecarServer(0, '/tmp/test-project')
    sessionService = new SessionService({} as never, {} as never, {} as never, '/tmp', {} as never, {} as never)
    server.setServices(
      sessionService,
      new ConfigService('/tmp'),
      new ModelService(),
      {} as never,
      new ExtensionService(),
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('triggers default response after timeout (confirm → false)', () => {
    server.registerExtensionTimeout('sess-1', 'req-timeout-1', 'confirm')

    vi.advanceTimersByTime(300_000)

    expect(mockSendCommand).toHaveBeenCalledWith(
      'extension_ui_response',
      expect.objectContaining({
        id: 'req-timeout-1',
        response: false,
      }),
    )
  })

  it('triggers default response after timeout (select → null)', () => {
    server.registerExtensionTimeout('sess-1', 'req-timeout-sel', 'select')

    vi.advanceTimersByTime(300_000)

    expect(mockSendCommand).toHaveBeenCalledWith(
      'extension_ui_response',
      expect.objectContaining({
        id: 'req-timeout-sel',
        response: null,
      }),
    )
  })

  it('triggers default response after timeout (input → null)', () => {
    server.registerExtensionTimeout('sess-1', 'req-timeout-inp', 'input')

    vi.advanceTimersByTime(300_000)

    expect(mockSendCommand).toHaveBeenCalledWith(
      'extension_ui_response',
      expect.objectContaining({
        id: 'req-timeout-inp',
        response: null,
      }),
    )
  })

  it('does NOT trigger timeout if cleared by ui_response', () => {
    server.registerExtensionTimeout('sess-1', 'req-clear-1', 'confirm')

    // Simulate clearing the timeout (as would happen when ui_response is received)
    server.clearExtensionTimeout('req-clear-1')

    vi.advanceTimersByTime(300_000)

    expect(mockSendCommand).not.toHaveBeenCalled()
  })

  it('clears all timeouts for a session', () => {
    server.registerExtensionTimeout('sess-cleanup', 'req-a', 'confirm')
    server.registerExtensionTimeout('sess-cleanup', 'req-b', 'select')
    server.registerExtensionTimeout('sess-other', 'req-c', 'confirm')

    server.clearExtensionTimeoutsForSession('sess-cleanup')

    vi.advanceTimersByTime(300_000)

    // Only req-c (sess-other) should have fired
    expect(mockSendCommand).toHaveBeenCalledTimes(1)
    expect(mockSendCommand).toHaveBeenCalledWith(
      'extension_ui_response',
      expect.objectContaining({ id: 'req-c' }),
    )
  })

  it('notify method does not register timeout', () => {
    // notify is fire-and-forget, no response expected
    server.registerExtensionTimeout('sess-1', 'req-notify', 'notify')

    vi.advanceTimersByTime(300_000)

    expect(mockSendCommand).not.toHaveBeenCalled()
  })
})
