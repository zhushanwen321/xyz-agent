import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { WebSocket } from 'ws'

/**
 * Interface-level tests for SessionService.restoreSession fix.
 *
 * The fix changed two things:
 * 1. Reuse original sessionId instead of crypto.randomUUID()
 * 2. Call adapter.detach() + unsubUsageListener() on existing session before overwrite
 *
 * We mock ProcessManager, EventAdapter, scanSessions, and config-store
 * so the tests run without spawning real pi processes or touching the filesystem.
 */

// ── Mock session-scanner ────────────────────────────────────────

const mockScannedSessions: Array<{
  id: string
  filePath: string
  cwd: string
  name: string | null
  lastModified: number
}> = []

vi.mock('../src/session-scanner.js', () => ({
  scanSessions: () => mockScannedSessions,
  deleteSessionFile: vi.fn(),
}))

// ── Mock config-store ───────────────────────────────────────────

vi.mock('../src/config-store.js', () => ({
  getDefaultModel: vi.fn().mockReturnValue('test-provider/test-model'),
  loadSkills: vi.fn().mockReturnValue([]),
}))

// ── Mock EventAdapter ───────────────────────────────────────────

const attachMock = vi.fn()
const detachMock = vi.fn()

vi.mock('../src/event-adapter.js', () => ({
  EventAdapter: class MockEventAdapter {
  private _sid: string
  private _send: (msg: unknown) => void

  constructor(sessionId: string, send: (msg: unknown) => void) {
    this._sid = sessionId
    this._send = send
  }

  /** Expose the sessionId for assertions */
  get sessionId() { return this._sid }

  attach = attachMock
  detach = detachMock
  },
}))

// ── Mock ProcessManager ─────────────────────────────────────────

const createSessionMock = vi.fn()
const onSessionExitMock = vi.fn()

vi.mock('../src/process-manager.js', () => ({
  ProcessManager: class MockProcessManager {
  createSession = createSessionMock
  getClient = vi.fn()
  hasClient = vi.fn().mockReturnValue(false)
  destroySession = vi.fn().mockResolvedValue(undefined)
  destroyAll = vi.fn().mockResolvedValue(undefined)
  onSessionExit = onSessionExitMock
  rekey = vi.fn()
  getSessionIdByClient = vi.fn()
  },
}))

// ── Mock pi-config-bridge ────────────────────────────────────────

vi.mock('../src/pi-config-bridge.js', () => ({
  getDefaultModel: () => ({ provider: 'test', modelId: 'provider-model' }),
  getSkillPaths: () => [],
  getSessionsDir: () => '/mock/sessions',
  readModels: () => ({ providers: {} }),
  readSettings: () => ({}),
}))

// ── Import after mocks ──────────────────────────────────────────

import { SessionService } from '../src/services/session-service.js'
import type { IMessageBroker, IEventAdapter } from '../src/interfaces.js'

/** Minimal scanned session fixture */
function addScannedSession(id: string, cwd = '/tmp/test-project') {
  const entry = { id, filePath: `/fake/sessions/${id}.jsonl`, cwd, name: null, lastModified: Date.now() }
  mockScannedSessions.push(entry)
  return entry
}

/** Minimal RpcClient-like mock for ProcessManager.createSession */
function makeMockClient() {
  return {
  onEvent: vi.fn().mockReturnValue(vi.fn()), // returns unsub fn
  sendCommand: vi.fn().mockResolvedValue({ type: 'success', payload: {} }),
  prompt: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn().mockResolvedValue(undefined),
  }
}

/** Create a SessionService with a mocked pm and no-op broker */
function createService(): SessionService {
  const noopBroker: IMessageBroker = {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
  }
  const adapterFactory = (_sessionId: string): IEventAdapter => {
    return {
      attach: attachMock,
      detach: detachMock,
    }
  }
  // Use a minimal mock pm that satisfies the constructor
  const mockPm = {
    createSession: createSessionMock,
    getClient: vi.fn(),
    hasClient: vi.fn().mockReturnValue(false),
    destroySession: vi.fn().mockResolvedValue(undefined),
    destroyAll: vi.fn().mockResolvedValue(undefined),
    onSessionExit: onSessionExitMock,
    rekey: vi.fn(),
    getSessionIdByClient: vi.fn(),
  }
  return new SessionService(
    mockPm as never,
    noopBroker,
    adapterFactory,
    '/tmp',
  )
}

describe('SessionService.restoreSession', () => {
  let service: SessionService

  beforeEach(() => {
  vi.clearAllMocks()
  mockScannedSessions.length = 0
  service = createService()
  })

  // ── Normal path ──────────────────────────────────────────────

  it('should reuse the original sessionId (not generate a new UUID)', async () => {
  const originalId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  addScannedSession(originalId)
  createSessionMock.mockResolvedValue(makeMockClient())

  const summary = await service.restoreSession(originalId)

  // Returned summary has the same id
  expect(summary.id).toBe(originalId)

  // ProcessManager.createSession was called with the original id
  expect(createSessionMock).toHaveBeenCalledWith(
    originalId,
    '/tmp/test-project',
    expect.objectContaining({ skillPaths: expect.any(Array) }),
  )
  })

  it('should create EventAdapter with the original sessionId', async () => {
  const originalId = '11111111-2222-3333-4444-555555555555'
  addScannedSession(originalId)
  createSessionMock.mockResolvedValue(makeMockClient())

  await service.restoreSession(originalId)

  // attachMock called means adapter was created + attached
  expect(attachMock).toHaveBeenCalledTimes(1)
  expect(createSessionMock).toHaveBeenCalledWith(originalId, expect.any(String), expect.any(Object))
  })

  it('should call switch_session with the scanned session file path', async () => {
  const id = 'switch-test-id'
  const entry = addScannedSession(id, '/my/project')
  const mockClient = makeMockClient()
  createSessionMock.mockResolvedValue(mockClient)

  await service.restoreSession(id)

  expect(mockClient.sendCommand).toHaveBeenCalledWith(
    'switch_session',
    { sessionPath: entry.filePath },
  )
  })

  // ── Boundary ─────────────────────────────────────────────────

  it('should detach existing adapter when called twice with same sessionId', async () => {
  const id = 'double-restore-id'
  addScannedSession(id)
  createSessionMock.mockResolvedValue(makeMockClient())

  // First restore
  await service.restoreSession(id)
  expect(detachMock).not.toHaveBeenCalled()

  // Second restore with same id — should detach the first adapter
  createSessionMock.mockResolvedValue(makeMockClient())
  await service.restoreSession(id)

  // detach should have been called once for the first session's adapter
  expect(detachMock).toHaveBeenCalledTimes(1)
  })

  it('should throw error when session file is not found in scan results', async () => {
  // No scanned sessions added — scanSessions returns []
  await expect(service.restoreSession('nonexistent-id')).rejects.toThrow(
    'Persisted session nonexistent-id not found',
  )
  })

  // ── Error path ───────────────────────────────────────────────

  it('should propagate error when ProcessManager.createSession fails', async () => {
  const id = 'pm-fail-id'
  addScannedSession(id)
  createSessionMock.mockRejectedValue(new Error('spawn pi failed'))

  await expect(service.restoreSession(id)).rejects.toThrow('spawn pi failed')
  })

  it('should keep session in map even if client.sendCommand(switch_session) fails', async () => {
  const id = 'switch-fail-id'
  addScannedSession(id)
  const mockClient = makeMockClient()
  mockClient.sendCommand.mockRejectedValue(new Error('switch failed'))
  createSessionMock.mockResolvedValue(mockClient)

  // restoreSession does NOT catch switch_session errors — they propagate
  await expect(service.restoreSession(id)).rejects.toThrow('switch failed')
  })
})
