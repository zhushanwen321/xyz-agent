import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tmpdir } from 'node:os'
import type { WebSocket } from 'ws'

/**
 * Interface-level tests for SessionService.restoreSession fix.
 *
 * The fix changed two things:
 * 1. Reuse original sessionId instead of crypto.randomUUID()
 * 2. Call adapter.detach() on existing session before overwrite (W3: usage listener removed,
 *    EventAdapter is sole pi-event listener owner)
 *
 * We mock ProcessManager, EventAdapter, scanSessions, and config-store
 * so the tests run without spawning real pi processes or touching the filesystem.
 */

// ── Mock pi-config-bridge（session-scanner 已内联）──────────

const mockScannedSessions: Array<{
  id: string
  filePath: string
  cwd: string
  name: string | null
  lastModified: number
  timestamp: string
  size: number
}> = []

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
  return { ...actual, scanPiSessions: () => mockScannedSessions, patchSessionCwd: () => true }
})
vi.mock('../src/infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-paths.js')>()
  return {
    ...actual,
    getSessionsDir: () => '/mock/sessions',
    getPiAgentDir: () => '/mock/xyz-agent/pi/agent',
  }
})

vi.mock('../src/infra/system/trash.js', () => ({
  trash: vi.fn(),
}))

// ── Mock EventAdapter ───────────────────────────────────────────

const attachMock = vi.fn()
const detachMock = vi.fn()

vi.mock('../src/infra/pi/event-adapter.js', () => ({
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

vi.mock('../src/infra/pi/process-manager.js', () => ({
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

// ── Import after mocks ──────────────────────────────────────────

import { SessionService } from '../src/services/session/session-service.js'
import { PiConfigStore } from '../src/infra/pi/pi-config-store.js'
import { PiSessionStore } from '../src/infra/pi/session-store.js'
import type { IMessageBroker, IEventAdapter } from '../src/interfaces.js'
import type { IGitInfoReader } from '../src/services/ports/git-info.js'

// IGitInfoReader 桩：本测试聚焦 restore 语义，不验证 git 摘要字段（readGitInfo 恒 undefined）。
const noopGitInfoReader: IGitInfoReader = { readGitInfo: () => undefined, pruneStaleCache: () => {} }

/** Minimal scanned session fixture */
function addScannedSession(id: string, cwd = tmpdir()) {
  const entry = { id, filePath: `/fake/sessions/${id}.jsonl`, cwd, name: null, lastModified: Date.now(), timestamp: new Date().toISOString(), size: 0 }
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
  const adapterFactory = (_sessionId: string, _interceptor: unknown): IEventAdapter => {
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
    { getExtensionPaths: vi.fn().mockResolvedValue([]) } as never,
    new PiConfigStore(),
    new PiSessionStore(),
    noopGitInfoReader,
    {} as never,
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
    tmpdir(),
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

  // ── CWD fallback ─────────────────────────────────────────────

  it('should fall back to home dir when session cwd does not exist', async () => {
  const id = 'cwd-fallback-id'
  // Use a path that is guaranteed not to exist
  const nonexistentCwd = '/tmp/xyz-agent-test-cwd-nonexistent-' + Date.now()
  addScannedSession(id, nonexistentCwd)
  createSessionMock.mockResolvedValue(makeMockClient())

  await service.restoreSession(id)

  // createSession should be called with homedir() as cwd, not the nonexistent path
  expect(createSessionMock).toHaveBeenCalledWith(
    id,
    expect.not.stringContaining('nonexistent'),
    expect.objectContaining({ skillPaths: expect.any(Array) }),
  )
  })
})
