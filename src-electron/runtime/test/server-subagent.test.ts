import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebSocket } from 'ws'

/**
 * Tests for T3: Sidecar manual trigger handling (subagent field in message.send).
 *
 * These tests verify that when `msg.payload.subagent` is present with
 * `{ agent: string; task: string }`, the runtime constructs an XML structured
 * prompt instead of sending raw content to `sessionService.sendMessage`.
 */

// ── Mock SessionService to capture sendMessage calls ────────────

const sendMessageMock = vi.fn().mockResolvedValue(undefined)

vi.mock('../src/services/session-service.js', () => {
  return {
  SessionService: class MockSessionService {
    sendMessage = sendMessageMock
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
  },
  }
})

// Mock config-service
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

// Mock model-service
vi.mock('../src/services/model-service.js', () => ({
  ModelService: class MockModelService {
    aggregateModels = vi.fn().mockReturnValue([])
    discoverModelsFromApi = vi.fn().mockResolvedValue([])
  },
}))

// Mock process-manager (transitive dep of SessionService)
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

// Mock event-adapter
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

vi.mock('../src/provider-store.js', () => ({
  listProviders: vi.fn().mockReturnValue([]),
  setProvider: vi.fn(),
  deleteProvider: vi.fn(),
}))

vi.mock('../src/skill-scanner.js', () => ({
  scanSkills: vi.fn().mockReturnValue([]),
}))

vi.mock('../src/agent-scanner.js', () => ({
  scanAgents: vi.fn().mockReturnValue([]),
}))

vi.mock('../src/session-scanner.js', () => ({
  scanSessions: vi.fn().mockReturnValue([]),
  deleteSessionFile: vi.fn(),
  invalidateScanCache: vi.fn(),
}))

vi.mock('../src/pi-config-bridge.js', () => ({
  getDefaultModel: () => ({ provider: 'test', modelId: 'provider-model' }),
  getSkillPaths: () => [],
  getSessionsDir: () => '/mock/sessions',
  readModels: () => ({ providers: {} }),
  readSettings: () => ({}),
}))

import { SidecarServer } from '../src/server.js'
import { SessionService } from '../src/services/session-service.js'
import { ConfigService } from '../src/services/config-service.js'
import { ModelService } from '../src/services/model-service.js'

/** Find a free port */
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

describe('SidecarServer message.send with subagent field', () => {
  let server: SidecarServer
  let port: number
  let ws: WebSocket

  beforeEach(async () => {
  sendMessageMock.mockClear()
  port = await getFreePort()
  server = new SidecarServer(port, '/tmp/test-project')
  server.setServices(
    new SessionService({} as never, {} as never, {} as never, '/tmp', {} as never),
    new ConfigService('/tmp'),
    new ModelService(),
    {} as never,
  )
  await server.start()
  })

  afterEach(async () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close()
  }
  await server.stop()
  })

  /** Helper: connect a WS client and wait for initial state to drain */
  function connectClient(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(`ws://localhost:${port}`)
    ws.on('open', () => {
    // Wait a tick for initial state messages to be sent
    setTimeout(() => resolve(ws), 100)
    })
    ws.on('error', reject)
  })
  }

  /** Helper: send a message and wait for the response */
  function sendAndCollect(ws: WebSocket, msg: object): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.send(JSON.stringify(msg))
    // Give server time to process
    setTimeout(() => resolve(), 200)
  })
  }

  // ── Test cases ────────────────────────────────────────────────

  it('should send XML structured prompt when subagent field is present', async () => {
  const client = await connectClient()

  await sendAndCollect(client, {
    type: 'message.send',
    id: 'test-1',
    payload: {
    sessionId: 'sess-123',
    content: 'original content',
    subagent: {
      agent: 'harness-executor',
      task: 'Implement the feature',
    },
    },
  })

  // Should have called sendMessage with hidden marker prompt
  expect(sendMessageMock).toHaveBeenCalledTimes(1)
  const sentContent = sendMessageMock.mock.calls[0][1] as string

  // The content should use hidden marker format, not the raw "original content"
  expect(sentContent).toContain('xyz-agent-force-subagent')
  expect(sentContent).not.toContain('<tool_call')
  // Parse the JSON from the marker and verify values
  const markerMatch = sentContent.match(/<!-- xyz-agent-force-subagent:(.+?) -->/)
  expect(markerMatch).not.toBeNull()
  const decoded = Buffer.from(markerMatch![1], 'base64').toString('utf-8')
  const parsed = JSON.parse(decoded)
  expect(parsed.agent).toBe('harness-executor')
  expect(parsed.task).toBe('Implement the feature')
  // Marker should be followed by newline and prompt text
  expect(sentContent).toContain('<!-- xyz-agent-force-subagent')
  expect(sentContent).not.toBe('original content')
  })

  it('should preserve special characters in agent name and task via JSON escaping', async () => {
  const client = await connectClient()

  await sendAndCollect(client, {
    type: 'message.send',
    id: 'test-2',
    payload: {
    sessionId: 'sess-456',
    content: 'unused',
    subagent: {
      agent: 'agent<with>"special&chars',
      task: 'do <something> "important" & more',
    },
    },
  })

  expect(sendMessageMock).toHaveBeenCalledTimes(1)
  const sentContent = sendMessageMock.mock.calls[0][1] as string

  // JSON.stringify handles escaping — original characters preserved in parsed JSON
  const markerMatch = sentContent.match(/<!-- xyz-agent-force-subagent:(.+?) -->/)
  expect(markerMatch).not.toBeNull()
  const decoded = Buffer.from(markerMatch![1], 'base64').toString('utf-8')
  const parsed = JSON.parse(decoded)
  expect(parsed.agent).toBe('agent<with>"special&chars')
  expect(parsed.task).toBe('do <something> "important" & more')
  })

  it('should send raw content when subagent field is absent', async () => {
  const client = await connectClient()

  await sendAndCollect(client, {
    type: 'message.send',
    id: 'test-3',
    payload: {
    sessionId: 'sess-789',
    content: 'just a normal message',
    },
  })

  expect(sendMessageMock).toHaveBeenCalledTimes(1)
  const sentContent = sendMessageMock.mock.calls[0][1] as string

  // Should send the raw content as-is
  expect(sentContent).toBe('just a normal message')
  expect(sentContent).not.toContain('<tool_call')
  })

  it('should handle empty task string in subagent', async () => {
  const client = await connectClient()

  await sendAndCollect(client, {
    type: 'message.send',
    id: 'test-4',
    payload: {
    sessionId: 'sess-empty-task',
    content: 'fallback',
    subagent: {
      agent: 'test-agent',
      task: '',
    },
    },
  })

  expect(sendMessageMock).toHaveBeenCalledTimes(1)
  const sentContent = sendMessageMock.mock.calls[0][1] as string

  // Even with empty task, should construct the hidden marker prompt
  expect(sentContent).toContain('xyz-agent-force-subagent')
  expect(sentContent).not.toContain('<tool_call')
  const markerMatch = sentContent.match(/<!-- xyz-agent-force-subagent:(.+?) -->/)
  expect(markerMatch).not.toBeNull()
  const decoded = Buffer.from(markerMatch![1], 'base64').toString('utf-8')
  const parsed = JSON.parse(decoded)
  expect(parsed.agent).toBe('test-agent')
  expect(parsed.task).toBe('')
  })

  it('should produce valid base64-encoded marker for subagent messages', async () => {
  const client = await connectClient()

  await sendAndCollect(client, {
    type: 'message.send',
    id: 'test-5',
    payload: {
    sessionId: 'sess-log',
    content: 'unused',
    subagent: {
      agent: 'reviewer',
      task: 'Review the code',
    },
    },
  })

  expect(sendMessageMock).toHaveBeenCalledTimes(1)
  const sentContent = sendMessageMock.mock.calls[0][1] as string

  // Marker should contain base64-encoded JSON, not raw JSON
  const markerMatch = sentContent.match(/<!-- xyz-agent-force-subagent:(.+?) -->/)
  expect(markerMatch).not.toBeNull()
  const decoded = Buffer.from(markerMatch![1], 'base64').toString('utf-8')
  const parsed = JSON.parse(decoded)
  expect(parsed.agent).toBe('reviewer')
  expect(parsed.task).toBe('Review the code')
  })

  it('should not modify behavior for normal messages without subagent', async () => {
  const client = await connectClient()

  // Send a normal message
  await sendAndCollect(client, {
    type: 'message.send',
    id: 'test-6',
    payload: {
    sessionId: 'sess-normal',
    content: 'Hello, this is a regular chat message',
    },
  })

  expect(sendMessageMock).toHaveBeenCalledTimes(1)
  expect(sendMessageMock).toHaveBeenCalledWith(
    'sess-normal',
    'Hello, this is a regular chat message',
  )
  })
})
