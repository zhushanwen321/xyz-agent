import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import type { Server as HttpServer } from 'node:http'

/**
 * Tests for T3: Sidecar manual trigger handling (subagent field in message.send).
 *
 * These tests verify that when `msg.payload.subagent` is present with
 * `{ agent: string; task: string }`, the sidecar constructs an XML structured
 * prompt instead of sending raw content to `pool.sendMessage`.
 *
 * ALL TESTS SHOULD FAIL until the implementation in server.ts handles
 * the `subagent` field in the `message.send` case.
 */

// ── Mock SessionPool to capture sendMessage calls ────────────────

const sendMessageMock = vi.fn().mockResolvedValue(undefined)

vi.mock('../src/session-pool.js', () => {
  return {
  SessionPool: class MockSessionPool {
    sendMessage = sendMessageMock
    addClient = vi.fn()
    removeClient = vi.fn()
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
    approveTool = vi.fn().mockResolvedValue(undefined)
    denyTool = vi.fn().mockResolvedValue(undefined)
    alwaysAllowTool = vi.fn().mockResolvedValue(undefined)
  },
  }
})

// Mock config-store to avoid file system access
vi.mock('../src/config-store.js', () => ({
  updateToolPermissions: vi.fn(),
  getProvider: vi.fn().mockReturnValue(undefined),
  loadSkills: vi.fn().mockReturnValue([]),
  saveSkills: vi.fn(),
  loadAgents: vi.fn().mockReturnValue([]),
  saveAgents: vi.fn(),
  getDefaultModel: vi.fn().mockReturnValue(undefined),
}))

// Mock provider-store to avoid file system access
vi.mock('../src/provider-store.js', () => ({
  listProviders: vi.fn().mockReturnValue([]),
  setProvider: vi.fn(),
  deleteProvider: vi.fn(),
}))

// Mock model-db
vi.mock('../src/model-db.js', () => ({
  lookupModel: vi.fn().mockReturnValue(undefined),
}))

// Mock skill-scanner and agent-scanner
vi.mock('../src/skill-scanner.js', () => ({
  scanSkills: vi.fn().mockReturnValue([]),
}))

vi.mock('../src/agent-scanner.js', () => ({
  scanAgents: vi.fn().mockReturnValue([]),
}))

import { SidecarServer } from '../src/server.js'

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

  // Should have called sendMessage with XML structured prompt
  expect(sendMessageMock).toHaveBeenCalledTimes(1)
  const sentContent = sendMessageMock.mock.calls[0][1] as string

  // The content should be XML-formatted, not the raw "original content"
  expect(sentContent).toContain('<tool_call tool="subagent">')
  expect(sentContent).toContain('"agent":"harness-executor"')
  expect(sentContent).toContain('"task":"Implement the feature"')
  expect(sentContent).toContain('</tool_call')
  expect(sentContent).not.toBe('original content')
  })

  it('should sanitize special characters in agent name and task', async () => {
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

  // Special characters <>"& should be stripped
  expect(sentContent).not.toContain('<with>')
  expect(sentContent).not.toContain('"special"')
  expect(sentContent).not.toContain('&')
  // The sanitized values should be present
  expect(sentContent).toContain('"agent":"agentwithspecialchars"')
  expect(sentContent).toContain('"task":"do something important  more"')
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

  // Even with empty task, should construct the XML prompt
  expect(sentContent).toContain('<tool_call tool="subagent">')
  expect(sentContent).toContain('"agent":"test-agent"')
  expect(sentContent).toContain('"task":""')
  expect(sentContent).toContain('</tool_call')
  })

  it('should log the constructed XML prompt for subagent messages', async () => {
  const client = await connectClient()
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

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

  // Should log the subagent prompt
  const subagentLogCall = logSpy.mock.calls.find(
    (call) => typeof call[0] === 'string' && call[0].includes('[sidecar] subagent prompt:'),
  )
  expect(subagentLogCall).toBeDefined()
  expect(subagentLogCall![1]).toContain('<tool_call tool="subagent">')
  expect(subagentLogCall![1]).toContain('"agent":"reviewer"')

  logSpy.mockRestore()
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
