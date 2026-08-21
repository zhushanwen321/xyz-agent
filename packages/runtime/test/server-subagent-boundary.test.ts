import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import {
  createMockSessionServiceInstance,
  createMockConfigServiceClass,
  createMockModelServiceClass,
  createMockProcessManagerClass,
  createMockEventAdapterClass,
  createMockSkillScannerModule,
  createMockAgentScannerModule,
  mockPiProviderStoreModule,
  mockSessionFileUtilsModule,
  mockPiPathsModule,
  createMockTrashModule,
} from './helpers/service-mocks.js'
import { startOnFreePort } from './helpers/free-port.js'

/**
 * Boundary & error path tests for RuntimeServer message.send with subagent.
 *
 * Supplements server-subagent.test.ts which covers normal paths.
 * These tests verify edge-case behavior at the runtime/server layer:
 * XML injection, sanitization, empty fields, structural integrity.
 */

// ── Mock SessionService ───────────────────────────────────────────
//
// controlSubagent=true：sendSubagentMessage 模拟真实编码（base64 marker → 调 sendMessage），
// 测试需要持有 sendMessageMock / sendSubagentMessageMock ref 做断言，因此在 vi.mock
// 之外用 createMockSessionServiceInstance 创建，再把 instance 字段铺到 class 上。

const { instance: sessionServiceInstance, sendMessageMock, sendSubagentMessageMock } =
  createMockSessionServiceInstance({ controlSubagent: true })

vi.mock('../src/services/session/session-service.js', () => {
  return {
    SessionService: class MockSessionService {
      sendMessage = sessionServiceInstance.sendMessage
      sendSubagentMessage = sessionServiceInstance.sendSubagentMessage
      listPersistedSessions = sessionServiceInstance.listPersistedSessions
      getSummary = sessionServiceInstance.getSummary
      getHistory = sessionServiceInstance.getHistory
      create = sessionServiceInstance.create
      delete = sessionServiceInstance.delete
      destroyAll = sessionServiceInstance.destroyAll
      clear = sessionServiceInstance.clear
      renameSession = sessionServiceInstance.renameSession
      restoreSession = sessionServiceInstance.restoreSession
      hasActiveSession = sessionServiceInstance.hasActiveSession
      compact = sessionServiceInstance.compact
      abort = sessionServiceInstance.abort
      switchModel = sessionServiceInstance.switchModel
      setOnSessionDestroyed = sessionServiceInstance.setOnSessionDestroyed
    },
  }
})

vi.mock('../src/services/config-service.js', () => ({
  ConfigService: createMockConfigServiceClass(),
}))

vi.mock('../src/services/model-service.js', () => ({
  ModelService: createMockModelServiceClass(),
}))

vi.mock('../src/infra/pi/process-manager.js', () => ({
  ProcessManager: createMockProcessManagerClass(),
}))

vi.mock('../src/infra/pi/event-adapter.js', () => ({
  EventAdapter: createMockEventAdapterClass(),
}))

vi.mock('../src/services/scanners/skill-scanner.js', () => createMockSkillScannerModule())
vi.mock('../src/services/scanners/agent-scanner.js', () => createMockAgentScannerModule())

// pi-config-bridge 已拆分：model/settings → pi-provider-store，session 扫描 → session-file-utils，
// 路径 → pi-paths。按实际 import 来源 mock 各符号（其余实现保留原模块）。
// 注意：vi.mock 第二参数必须是内联箭头（不能直接传导入的函数引用或其调用结果——
// hoist 时 imports 尚未初始化会触发 TDZ）。箭头 body 在模块首次 import 时执行，此时安全。
vi.mock('../src/infra/pi/pi-provider-store.js', async (importOriginal) =>
  mockPiProviderStoreModule(await importOriginal<Record<string, unknown>>()),
)
vi.mock('../src/infra/pi/session-file-utils.js', async (importOriginal) =>
  mockSessionFileUtilsModule(await importOriginal<Record<string, unknown>>()),
)
vi.mock('../src/infra/pi/pi-paths.js', async (importOriginal) =>
  mockPiPathsModule(await importOriginal<Record<string, unknown>>()),
)

vi.mock('../src/infra/system/trash.js', () => createMockTrashModule())

import { RuntimeServer } from '../src/transport/server.js'
import { SessionService } from '../src/services/session/session-service.js'
import { ConfigService } from '../src/services/config-service.js'
import { PiConfigStore } from '../src/infra/pi/pi-config-store.js'
import { ModelApiDiscoverer } from '../src/infra/model-api-discoverer.js'
import { ModelService } from '../src/services/model-service.js'

/** S1-W1：真实 WS 测试统一 token（ConnectionManager auth 握手，见 ws-listen-hardening.test.ts） */
const TEST_WS_TOKEN = 'test-ws-token-subagent-boundary'

describe('RuntimeServer message.send subagent — boundary & error paths', () => {
  let server: RuntimeServer
  let port: number
  let ws: WebSocket

  beforeEach(async () => {
  sendMessageMock.mockClear()
  sendSubagentMessageMock.mockClear()
  // EADDRINUSE 韧性：端口在 RuntimeServer 构造函数绑定，重试需整体重建（startOnFreePort 语义）
  const started = await startOnFreePort((p) => {
    const s = new RuntimeServer(p, '/tmp/test-project', TEST_WS_TOKEN)
    s.setServices(
      new SessionService({} as never, {} as never, {} as never, '/tmp', {} as never, {} as never, {} as never, { readGitInfo: () => undefined, pruneStaleCache: () => {} } as never, {} as never),
      new ConfigService('/tmp', new PiConfigStore()),
      new ModelService(new ModelApiDiscoverer()),
      {} as never,
    )
    return s
  })
  server = started.instance
  port = started.port
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
    // S1-W1：首条消息 auth，等 auth.result ok 后连接才可用
    ws.send(JSON.stringify({ type: 'auth', payload: { token: TEST_WS_TOKEN } }))
    })
    ws.on('message', (data) => {
    const msg = JSON.parse(String(data))
    if (msg.type === 'auth.result' && msg.payload?.ok === true) {
      setTimeout(() => resolve(ws), 100)
    }
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
