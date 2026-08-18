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
 * Tests for T3: Runtime manual trigger handling (subagent field in message.send).
 *
 * These tests verify that when `msg.payload.subagent` is present with
 * `{ agent: string; task: string }`, the runtime constructs an XML structured
 * prompt instead of sending raw content to `sessionService.sendMessage`.
 */

// ── Mock SessionService to capture sendMessage calls ────────────
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
  mockPiProviderStoreModule(
    await importOriginal<Record<string, unknown>>(),
  ),
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
const TEST_WS_TOKEN = 'test-ws-token-subagent'

describe('RuntimeServer message.send with subagent field', () => {
  let server: RuntimeServer
  let port: number
  let ws: WebSocket

  beforeEach(async () => {
  sendMessageMock.mockClear()
  sendSubagentMessageMock.mockClear()
  // EADDRINUSE 韧性：端口在 RuntimeServer 构造函数绑定，重试需整体重建（startOnFreePort 语义）。
  // 注：server.test.ts 是本文件的 symlink（同体设计），本改动同时对两者生效。
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

  /** Helper: connect a WS client, auth (S1-W1), and wait for initial state to drain */
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
      // Wait a tick for initial state messages to be sent
      setTimeout(() => resolve(ws), 100)
    }
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
    undefined,
  )
  })
})
