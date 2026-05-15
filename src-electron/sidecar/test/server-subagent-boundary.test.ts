import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebSocket } from 'ws'

/**
 * Boundary & error path tests for SidecarServer message.send with subagent.
 *
 * Supplements server-subagent.test.ts which covers normal paths.
 * These tests verify edge-case behavior at the sidecar/server layer:
 * XML injection, sanitization, empty fields, structural integrity.
 */

// ── Mock SessionPool ───────────────────────────────────────────────

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

vi.mock('../src/config-store.js', () => ({
  updateToolPermissions: vi.fn(),
  getProvider: vi.fn().mockReturnValue(undefined),
  loadSkills: vi.fn().mockReturnValue([]),
  saveSkills: vi.fn(),
  loadAgents: vi.fn().mockReturnValue([]),
  saveAgents: vi.fn(),
  getDefaultModel: vi.fn().mockReturnValue(undefined),
}))

vi.mock('../src/provider-store.js', () => ({
  listProviders: vi.fn().mockReturnValue([]),
  setProvider: vi.fn(),
  deleteProvider: vi.fn(),
}))

vi.mock('../src/model-db.js', () => ({
  lookupModel: vi.fn().mockReturnValue(undefined),
}))

vi.mock('../src/skill-scanner.js', () => ({
  scanSkills: vi.fn().mockReturnValue([]),
}))

vi.mock('../src/agent-scanner.js', () => ({
  scanAgents: vi.fn().mockReturnValue([]),
}))

import { SidecarServer } from '../src/server.js'

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

describe('SidecarServer message.send subagent — boundary & error paths', () => {
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

  it('should strip < > " & from agent name to prevent XML injection', async () => {
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
  // All <>"& should be removed from agent name
  expect(sent).not.toContain('<b>')
  expect(sent).toContain('"agent":"abcde"')
  })

  // ── Boundary: XML-dangerous chars in task ──────────────────────

  it('should strip < > " & from task text to prevent XML injection', async () => {
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
  // All <>"& should be removed from task
  expect(sent).not.toContain('<script>')
  expect(sent).not.toContain('</script>')
  expect(sent).toContain('"task":"scriptalert(xss)/scriptdone"')
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
  // Newlines should be preserved (not stripped by the sanitize regex)
  expect(sent).toContain('step 1: read code\nstep 2: find bugs\nstep 3: report')
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
  // Should still produce valid XML structure with empty agent
  expect(sent).toContain('<tool_call tool="subagent">')
  expect(sent).toContain('"agent":""')
  expect(sent).toContain('"task":"do something"')
  expect(sent).toContain('</tool_call')
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
  expect(sent).toContain('<tool_call tool="subagent">')
  expect(sent).toContain('"agent":"agent-name"')
  expect(sent).toContain('"task":""')
  expect(sent).toContain('</tool_call')
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

  // Verify structural integrity
  expect(sent).toContain('<tool_call tool="subagent">')
  expect(sent).toContain('</tool_call />')
  // Verify the JSON inside is parseable
  const jsonMatch = sent.match(/\{[^}]+\}/)
  expect(jsonMatch).not.toBeNull()
  const parsed = JSON.parse(jsonMatch![0])
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
  // Single quotes are NOT in the /[<>"&]/ regex, so they pass through
  expect(sent).toContain("agent's-name")
  expect(sent).toContain("it's O'Reilly's book")
  })
})
