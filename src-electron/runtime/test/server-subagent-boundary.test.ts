import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebSocket } from 'ws'

/**
 * Boundary & error path tests for RuntimeServer message.send with subagent.
 *
 * Supplements server-subagent.test.ts which covers normal paths.
 * These tests verify edge-case behavior at the runtime/server layer:
 * XML injection, sanitization, empty fields, structural integrity.
 */

// ── Mock SessionService ───────────────────────────────────────────

const sendMessageMock = vi.fn().mockResolvedValue(undefined)

const sendSubagentMessageMock = vi.fn().mockImplementation(
  async (sessionId: string, agent: string, task: string, content?: string) => {
    const payload = JSON.stringify({ agent, task })
    const encoded = Buffer.from(payload, 'utf-8').toString('base64')
    const marker = `<!-- xyz-agent-force-subagent:${encoded} -->`
    const promptText = content || `Execute task using agent '${agent}'`
    await sendMessageMock(sessionId, `${marker}\n${promptText}`)
  },
)

vi.mock('../src/services/session/session-service.js', () => {
  return {
  SessionService: class MockSessionService {
    sendMessage = sendMessageMock
    sendSubagentMessage = sendSubagentMessageMock
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

// Mock model-service
vi.mock('../src/services/model-service.js', () => ({
  ModelService: class MockModelService {
    aggregateModels = vi.fn().mockReturnValue([])
    discoverModelsFromApi = vi.fn().mockResolvedValue([])
  },
}))

// Mock process-manager (transitive dep)
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

vi.mock('../src/infra/system/trash.js', () => ({
  trash: vi.fn(),
}))

import { RuntimeServer } from '../src/transport/server.js'
import { SessionService } from '../src/services/session/session-service.js'
import { ConfigService } from '../src/services/config-service.js'
import { PiConfigStore } from '../src/infra/pi/pi-config-store.js'
import { ModelApiDiscoverer } from '../src/infra/model-api-discoverer.js'
import { ModelService } from '../src/services/model-service.js'

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

describe('RuntimeServer message.send subagent — boundary & error paths', () => {
  let server: RuntimeServer
  let port: number
  let ws: WebSocket

  beforeEach(async () => {
  sendMessageMock.mockClear()
  sendSubagentMessageMock.mockClear()
  port = await getFreePort()
  server = new RuntimeServer(port, '/tmp/test-project')
  server.setServices(
    new SessionService({} as never, {} as never, {} as never, '/tmp', {} as never, {} as never, {} as never, {} as never, {} as never, { readGitInfo: () => undefined, pruneStaleCache: () => {} } as never),
    new ConfigService('/tmp', new PiConfigStore()),
    new ModelService(new ModelApiDiscoverer()),
    {} as never,
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

  function connectClient(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(`ws://localhost:${port}`)
    ws.on('open', () => {
    setTimeout(() => resolve(ws), 100)
    })
    ws.on('error', reject)
  })
  }

  function sendAndCollect(ws: WebSocket, msg: object): Promise<void> {
  return new Promise((resolve) => {
    ws.send(JSON.stringify(msg))
    setTimeout(() => resolve(), 200)
  })
  }

  // ── Boundary: XML-dangerous chars in agent name ────────────────

  it('should preserve special characters in agent name via JSON escaping', async () => {
  const client = await connectClient()

  await sendAndCollect(client, {
  type: 'message.send',
  id: 'test-xml-agent',
  payload: {
  sessionId: 'sess-xml-agent',
  content: 'unused',
  subagent: { agent: 'a<b>c"d&e', task: 'normal task' },
  },
  })

  expect(sendMessageMock).toHaveBeenCalledTimes(1)
  const sent = sendMessageMock.mock.calls[0][1] as string
  // JSON.stringify escapes special chars — original values preserved when parsed
  const markerMatch = sent.match(/<!-- xyz-agent-force-subagent:(.+?) -->/)
  expect(markerMatch).not.toBeNull()
  const decoded = Buffer.from(markerMatch![1], 'base64').toString('utf-8')
  const parsed = JSON.parse(decoded)
  expect(parsed.agent).toBe('a<b>c"d&e')
  expect(parsed.task).toBe('normal task')
  })

  // ── Boundary: XML-dangerous chars in task ──────────────────────

  it('should preserve special characters in task via JSON escaping', async () => {
  const client = await connectClient()

  await sendAndCollect(client, {
  type: 'message.send',
  id: 'test-xml-task',
  payload: {
  sessionId: 'sess-xml-task',
  content: 'unused',
  subagent: { agent: 'clean-agent', task: '<script>alert("xss")</script>&done' },
  },
  })

  expect(sendMessageMock).toHaveBeenCalledTimes(1)
  const sent = sendMessageMock.mock.calls[0][1] as string
  // JSON.stringify escapes special chars — original values preserved when parsed
  const markerMatch = sent.match(/<!-- xyz-agent-force-subagent:(.+?) -->/)
  expect(markerMatch).not.toBeNull()
  const decoded = Buffer.from(markerMatch![1], 'base64').toString('utf-8')
  const parsed = JSON.parse(decoded)
  expect(parsed.task).toBe('<script>alert("xss")</script>&done')
  })

  // ── Boundary: newlines in task ─────────────────────────────────

  it('should preserve newlines in task text within the XML prompt', async () => {
  const client = await connectClient()

  const multilineTask = 'step 1: read code\nstep 2: find bugs\nstep 3: report'

  await sendAndCollect(client, {
    type: 'message.send',
    id: 'test-newlines',
    payload: {
    sessionId: 'sess-newlines',
    content: 'unused',
    subagent: { agent: 'reviewer', task: multilineTask },
    },
  })

  expect(sendMessageMock).toHaveBeenCalledTimes(1)
  const sent = sendMessageMock.mock.calls[0][1] as string
  // Newlines are JSON-escaped in the marker, but preserved when parsed
  const markerMatch = sent.match(/<!-- xyz-agent-force-subagent:(.+?) -->/)
  expect(markerMatch).not.toBeNull()
  const decoded = Buffer.from(markerMatch![1], 'base64').toString('utf-8')
  const parsed = JSON.parse(decoded)
  expect(parsed.task).toBe(multilineTask)
  })

  // ── Error: empty agent name ────────────────────────────────────

  it('should still construct XML prompt when agent name is empty string', async () => {
  const client = await connectClient()

  await sendAndCollect(client, {
  type: 'message.send',
  id: 'test-empty-agent',
  payload: {
  sessionId: 'sess-empty-agent',
  content: 'unused',
  subagent: { agent: '', task: 'do something' },
  },
  })

  expect(sendMessageMock).toHaveBeenCalledTimes(1)
  const sent = sendMessageMock.mock.calls[0][1] as string
  // Should still produce valid marker structure with empty agent
  expect(sent).toContain('xyz-agent-force-subagent')
  expect(sent).not.toContain('<tool_call')
  const markerMatch = sent.match(/<!-- xyz-agent-force-subagent:(.+?) -->/)
  expect(markerMatch).not.toBeNull()
  const decoded = Buffer.from(markerMatch![1], 'base64').toString('utf-8')
  const parsed = JSON.parse(decoded)
  expect(parsed.agent).toBe('')
  expect(parsed.task).toBe('do something')
  })

  // ── Error: empty task ──────────────────────────────────────────

  it('should still construct XML prompt when task is empty string', async () => {
  const client = await connectClient()

  await sendAndCollect(client, {
  type: 'message.send',
  id: 'test-empty-task',
  payload: {
  sessionId: 'sess-empty-task',
  content: 'unused',
  subagent: { agent: 'agent-name', task: '' },
  },
  })

  expect(sendMessageMock).toHaveBeenCalledTimes(1)
  const sent = sendMessageMock.mock.calls[0][1] as string
  expect(sent).toContain('xyz-agent-force-subagent')
  expect(sent).not.toContain('<tool_call')
  const markerMatch = sent.match(/<!-- xyz-agent-force-subagent:(.+?) -->/)
  expect(markerMatch).not.toBeNull()
  const decoded = Buffer.from(markerMatch![1], 'base64').toString('utf-8')
  const parsed = JSON.parse(decoded)
  expect(parsed.agent).toBe('agent-name')
  expect(parsed.task).toBe('')
  })

  // ── Boundary: very long agent name + task ──────────────────────

  it('should produce structurally valid XML prompt with long agent name and task', async () => {
  const client = await connectClient()
  const longAgent = 'agent-' + 'x'.repeat(500)
  const longTask = 'task: ' + 'y'.repeat(1000)

  await sendAndCollect(client, {
    type: 'message.send',
    id: 'test-long-fields',
    payload: {
    sessionId: 'sess-long',
    content: 'unused',
    subagent: { agent: longAgent, task: longTask },
    },
  })

  expect(sendMessageMock).toHaveBeenCalledTimes(1)
  const sent = sendMessageMock.mock.calls[0][1] as string

  // Verify structural integrity — hidden marker format
  expect(sent).toContain('xyz-agent-force-subagent')
  expect(sent).not.toContain('<tool_call')
  // Verify the JSON inside the marker is parseable
  const markerMatch = sent.match(/<!-- xyz-agent-force-subagent:(.+?) -->/)
  expect(markerMatch).not.toBeNull()
  const decoded = Buffer.from(markerMatch![1], 'base64').toString('utf-8')
  const parsed = JSON.parse(decoded)
  expect(parsed.agent).toBe(longAgent)
  expect(parsed.task).toBe(longTask)
  })

  // ── Boundary: single-quote in agent/task (not stripped by regex) ─

  it('should preserve single quotes in agent and task (not in sanitize regex)', async () => {
  const client = await connectClient()

  await sendAndCollect(client, {
  type: 'message.send',
  id: 'test-single-quote',
  payload: {
  sessionId: 'sess-quote',
  content: 'unused',
  subagent: { agent: "agent's-name", task: "it's O'Reilly's book" },
  },
  })

  expect(sendMessageMock).toHaveBeenCalledTimes(1)
  const sent = sendMessageMock.mock.calls[0][1] as string
  // Single quotes are preserved through base64 encode/decode round-trip
  const markerMatch = sent.match(/<!-- xyz-agent-force-subagent:(.+?) -->/)
  expect(markerMatch).not.toBeNull()
  const decoded = Buffer.from(markerMatch![1], 'base64').toString('utf-8')
  const parsed = JSON.parse(decoded)
  expect(parsed.agent).toBe("agent's-name")
  expect(parsed.task).toBe("it's O'Reilly's book")
  })
})
