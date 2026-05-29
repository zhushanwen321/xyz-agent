/**
 * Data Flow Integration Tests
 *
 * 跨模块集成测试：验证 5 条 data flow 的完整调用链。
 * 模块间（EventAdapter, Server, ExtensionService）使用真实实例，
 * 只 mock 最外层边界（pi RpcClient、WS 连接）。
 *
 * 覆盖:
 * - DF-1: Extension UI 请求-响应 (confirm/select/cancel/timeout/session-cleanup)
 * - DF-2: Extension 错误转发
 * - DF-3: 工具进度更新
 * - DF-4: Extension 列表管理
 * - DF-5: Extension 启用/禁用
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebSocket } from 'ws'

import type { ServerMessage } from '@xyz-agent/shared'

// ── Mocks (最外层边界) ────────────────────────────────────────────

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

// EventAdapter 使用真实实例 — 不 mock

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

vi.mock('../src/trash.js', () => ({
  trash: vi.fn(),
}))

// ── Imports (mock 之后) ───────────────────────────────────────────

import { SidecarServer } from '../src/server.js'
import { EventAdapter } from '../src/event-adapter.js'
import { SessionService } from '../src/services/session-service.js'
import { ConfigService } from '../src/services/config-service.js'
import { ModelService } from '../src/services/model-service.js'

// ── Helpers ────────────────────────────────────────────────────────

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const httpServer = require('node:http').createServer()
    httpServer.listen(0, () => {
      const addr = httpServer.address()
      if (addr && typeof addr === 'object') {
        const port = addr.port
        httpServer.close(() => resolve(port))
      } else {
        reject(new Error('Failed to get port'))
      }
    })
  })
}

function waitForMessage(ws: WebSocket, type: string, timeout = 3000): Promise<Record<string, unknown>> {
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

/** Wait for async handleEvent to flush */
const flushAsync = () => new Promise<void>(r => setTimeout(r, 0))

function connectClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`)
    ws.on('open', () => setTimeout(() => resolve(ws), 100))
    ws.on('error', reject)
  })
}

/** 创建一个 mock RpcClient，其 onEvent 会注册 listener 并可通过 getEventListener 取出 */
function createMockRpcClient() {
  let eventListener: ((event: Record<string, unknown>) => void) | null = null
  return {
    sendCommand: mockSendCommand,
    onEvent: vi.fn().mockImplementation((listener: (event: Record<string, unknown>) => void) => {
      eventListener = listener
      return () => { eventListener = null }
    }),
    getEventListener: () => eventListener,
    onExit: vi.fn(),
    exited: false,
    kill: vi.fn(),
    start: vi.fn(),
  }
}

/** 创建 WS 连接的完整 server fixture (真实 timers) */
interface WSFixture {
  server: SidecarServer
  sessionService: SessionService
  ws: WebSocket
  port: number
  rpcClient: ReturnType<typeof createMockRpcClient>
  adapterSent: ServerMessage[]
  /** 触发 pi 事件 (EventAdapter → adapterSent 收集) */
  emitPiEvent: (event: Record<string, unknown>) => void
  cleanup: () => Promise<void>
}

async function createWSFixture(extensionService?: object): Promise<WSFixture> {
  const port = await getFreePort()
  const server = new SidecarServer(port, '/tmp/test-project')
  const sessionService = new SessionService({} as never, {} as never, {} as never, '/tmp', {} as never, {} as never)

  server.setServices(
    sessionService,
    new ConfigService('/tmp'),
    new ModelService(),
    {} as never,
    extensionService as never | undefined,
  )

  await server.start()
  const ws = await connectClient(port)

  const rpcClient = createMockRpcClient()
  vi.mocked(sessionService.getRpcClient).mockReturnValue(rpcClient as never)

  // 真实 EventAdapter，send 输出到收集数组
  const adapterSent: ServerMessage[] = []
  const adapter = new EventAdapter('test-session-1', (msg) => adapterSent.push(msg), {
    onExtensionUIRequest: (requestId, sid, method) => {
      server.registerExtensionTimeout(sid, requestId, method)
    },
  })

  // attach adapter 到 mock RpcClient
  adapter.attach({
    onEvent: (listener) => {
      rpcClient.onEvent(listener)
      return () => adapter.detach()
    },
  })

  return {
    server,
    sessionService,
    ws,
    port,
    rpcClient,
    adapterSent,
    emitPiEvent: (event: Record<string, unknown>) => {
      const listener = rpcClient.getEventListener()
      if (listener) listener(event)
    },
    cleanup: async () => {
      ws.close()
      await server.stop()
    },
  }
}

// ══════════════════════════════════════════════════════════════════
// DF-1: Extension UI 请求-响应
// ══════════════════════════════════════════════════════════════════

describe('DF-1: Extension UI 请求-响应 (EventAdapter → Server → RpcClient)', () => {
  let fixture: WSFixture

  beforeEach(async () => {
    vi.useRealTimers()
    mockSendCommand.mockClear()
    fixture = await createWSFixture()
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  it('confirm 端到端: pi event → adapter translate → onExtensionUIRequest → 前端 response → RpcClient', async () => {
    // 1. pi 发出 extension_ui_request (confirm)
    fixture.emitPiEvent({
      type: 'extension_ui_request',
      method: 'confirm',
      id: 'req-confirm-1',
      title: 'Allow file access?',
      message: 'Extension wants to read /tmp/test.txt',
    })
    await flushAsync()

    // 2. EventAdapter 翻译 + 触发 onExtensionUIRequest
    expect(fixture.adapterSent).toHaveLength(1)
    expect(fixture.adapterSent[0].type).toBe('extension.ui_request')
    expect(fixture.adapterSent[0].payload).toMatchObject({
      sessionId: 'test-session-1',
      requestId: 'req-confirm-1',
      method: 'confirm',
      title: 'Allow file access?',
      message: 'Extension wants to read /tmp/test.txt',
    })

    // 3. 前端通过 WS 发送 extension.ui_response (result=true)
    fixture.ws.send(JSON.stringify({
      type: 'extension.ui_response',
      id: 'resp-1',
      payload: {
        sessionId: 'test-session-1',
        requestId: 'req-confirm-1',
        result: true,
      },
    }))

    // 4. 验证 server 转发到 RpcClient
    await new Promise((r) => setTimeout(r, 200))
    expect(fixture.sessionService.getRpcClient).toHaveBeenCalledWith('test-session-1')
    expect(mockSendCommand).toHaveBeenCalledWith(
      'extension_ui_response',
      expect.objectContaining({
        id: 'req-confirm-1',
        response: true,
      }),
    )
  })

  it('select 端到端: pi event → adapter translate → 前端 response (string)', async () => {
    // 1. pi 发出 extension_ui_request (select)
    fixture.emitPiEvent({
      type: 'extension_ui_request',
      method: 'select',
      id: 'req-select-1',
      title: 'Pick an option',
      options: [
        { label: 'Option A', value: 'a', description: 'Desc A' },
        { label: 'Option B', value: 'b' },
      ],
    })
    await flushAsync()

    // 2. 验证 adapter 翻译 (options 变为 string[])
    expect(fixture.adapterSent).toHaveLength(1)
    const payload = fixture.adapterSent[0].payload as Record<string, unknown>
    expect(payload.method).toBe('select')
    expect(payload.options).toEqual(['Option A', 'Option B'])

    // 3. 前端发送 extension.ui_response (result='option1')
    fixture.ws.send(JSON.stringify({
      type: 'extension.ui_response',
      id: 'resp-select-1',
      payload: {
        sessionId: 'test-session-1',
        requestId: 'req-select-1',
        result: 'option1',
      },
    }))

    // 4. 验证 server 转发到 RpcClient
    await new Promise((r) => setTimeout(r, 200))
    expect(mockSendCommand).toHaveBeenCalledWith(
      'extension_ui_response',
      expect.objectContaining({
        id: 'req-select-1',
        response: 'option1',
      }),
    )
  })

  it('cancel 路径: extension.ui_response (result=false) → server 转发 false', async () => {
    // 1. pi 发出 confirm 请求
    fixture.emitPiEvent({
      type: 'extension_ui_request',
      method: 'confirm',
      id: 'req-cancel-1',
      title: 'Allow?',
    })
    await flushAsync()

    expect(fixture.adapterSent).toHaveLength(1)

    // 2. 前端发送 cancel (result=false)
    fixture.ws.send(JSON.stringify({
      type: 'extension.ui_response',
      id: 'resp-cancel-1',
      payload: {
        sessionId: 'test-session-1',
        requestId: 'req-cancel-1',
        result: false,
      },
    }))

    // 3. 验证 server 转发 false 到 pi
    await new Promise((r) => setTimeout(r, 200))
    expect(mockSendCommand).toHaveBeenCalledWith(
      'extension_ui_response',
      expect.objectContaining({
        id: 'req-cancel-1',
        response: false,
      }),
    )
  })

  it('cancel 路径: extension.ui_response (result=null) → server 转发 null', async () => {
    // 1. pi 发出 input 请求
    fixture.emitPiEvent({
      type: 'extension_ui_request',
      method: 'input',
      id: 'req-null-1',
      title: 'Enter value',
    })
    await flushAsync()

    expect(fixture.adapterSent).toHaveLength(1)

    // 2. 前端发送 null
    fixture.ws.send(JSON.stringify({
      type: 'extension.ui_response',
      id: 'resp-null-1',
      payload: {
        sessionId: 'test-session-1',
        requestId: 'req-null-1',
        result: null,
      },
    }))

    // 3. 验证 server 转发 null
    await new Promise((r) => setTimeout(r, 200))
    expect(mockSendCommand).toHaveBeenCalledWith(
      'extension_ui_response',
      expect.objectContaining({
        id: 'req-null-1',
        response: null,
      }),
    )
  })
})

// ── DF-1 超时路径 (fake timers, 不启动 server) ────────────────────

describe('DF-1: Extension UI 超时路径', () => {
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
    )

    vi.mocked(sessionService.getRpcClient).mockReturnValue({
      sendCommand: mockSendCommand,
      onEvent: vi.fn().mockReturnValue(() => {}),
      onExit: vi.fn(),
      exited: false,
      kill: vi.fn(),
      start: vi.fn(),
    } as never)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('confirm 超时 → server 发送 response=false', () => {
    server.registerExtensionTimeout('sess-1', 'req-timeout-confirm', 'confirm')

    vi.advanceTimersByTime(300_000)

    expect(mockSendCommand).toHaveBeenCalledWith(
      'extension_ui_response',
      expect.objectContaining({
        id: 'req-timeout-confirm',
        response: false,
      }),
    )
  })

  it('select 超时 → server 发送 response=null', () => {
    server.registerExtensionTimeout('sess-1', 'req-timeout-select', 'select')

    vi.advanceTimersByTime(300_000)

    expect(mockSendCommand).toHaveBeenCalledWith(
      'extension_ui_response',
      expect.objectContaining({
        id: 'req-timeout-select',
        response: null,
      }),
    )
  })

  it('超时后 clearExtensionTimeout → 不再触发', () => {
    server.registerExtensionTimeout('sess-1', 'req-clear-timeout', 'confirm')
    server.clearExtensionTimeout('req-clear-timeout')

    vi.advanceTimersByTime(300_000)

    expect(mockSendCommand).not.toHaveBeenCalled()
  })

  it('notify 不注册超时 (fire-and-forget)', () => {
    server.registerExtensionTimeout('sess-1', 'req-notify', 'notify')

    vi.advanceTimersByTime(300_000)

    expect(mockSendCommand).not.toHaveBeenCalled()
  })
})

// ── DF-1 session 删除清理超时 (fake timers) ───────────────────────

describe('DF-1: session 删除清理超时', () => {
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
    )

    vi.mocked(sessionService.getRpcClient).mockReturnValue({
      sendCommand: mockSendCommand,
      onEvent: vi.fn().mockReturnValue(() => {}),
      onExit: vi.fn(),
      exited: false,
      kill: vi.fn(),
      start: vi.fn(),
    } as never)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('session 删除清理超时: registerTimeout → clearExtensionTimeoutsForSession → 超时不触发', () => {
    server.registerExtensionTimeout('sess-del-1', 'req-del-a', 'confirm')
    server.registerExtensionTimeout('sess-del-1', 'req-del-b', 'select')
    server.registerExtensionTimeout('sess-other', 'req-del-c', 'confirm')

    server.clearExtensionTimeoutsForSession('sess-del-1')

    vi.advanceTimersByTime(300_000)

    // sess-del-1 的超时不触发，sess-other 的仍然触发
    expect(mockSendCommand).toHaveBeenCalledTimes(1)
    expect(mockSendCommand).toHaveBeenCalledWith(
      'extension_ui_response',
      expect.objectContaining({ id: 'req-del-c' }),
    )
  })
})

// ══════════════════════════════════════════════════════════════════
// DF-2: Extension 错误转发 (EventAdapter translate)
// ══════════════════════════════════════════════════════════════════

describe('DF-2: Extension 错误转发 (EventAdapter → server broadcast)', () => {
  let fixture: WSFixture

  beforeEach(async () => {
    mockSendCommand.mockClear()
    fixture = await createWSFixture()
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  it('extension_error → EventAdapter 翻译为 extension.error (含 sessionId)', async () => {
    fixture.emitPiEvent({
      type: 'extension_error',
      extensionName: 'my-extension',
      error: 'Extension crashed unexpectedly',
    })
    await flushAsync()

    expect(fixture.adapterSent).toHaveLength(1)
    expect(fixture.adapterSent[0].type).toBe('extension.error')
    expect(fixture.adapterSent[0].payload).toMatchObject({
      sessionId: 'test-session-1',
      extensionName: 'my-extension',
      error: 'Extension crashed unexpectedly',
    })
  })

  it('extension_error 无显式 sessionId → EventAdapter 注入构造函数的 sessionId', async () => {
    fixture.emitPiEvent({
      type: 'extension_error',
      extensionName: 'ext-no-sid',
      error: 'some error',
    })
    await flushAsync()

    expect(fixture.adapterSent).toHaveLength(1)
    expect(fixture.adapterSent[0].payload).toMatchObject({
      sessionId: 'test-session-1',
      extensionName: 'ext-no-sid',
      error: 'some error',
    })
  })
})

// ══════════════════════════════════════════════════════════════════
// DF-3: 工具进度更新 (EventAdapter translate)
// ══════════════════════════════════════════════════════════════════

describe('DF-3: 工具进度更新 (EventAdapter → server broadcast)', () => {
  let fixture: WSFixture

  beforeEach(async () => {
    mockSendCommand.mockClear()
    fixture = await createWSFixture()
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  it('progress + partialResult → EventAdapter 翻译为 message.tool_call_update', async () => {
    fixture.emitPiEvent({
      type: 'tool_execution_update',
      toolCallId: 'tc-progress-1',
      toolName: 'read_file',
      partialResult: 'processing',
    })
    await flushAsync()

    expect(fixture.adapterSent).toHaveLength(1)
    expect(fixture.adapterSent[0].type).toBe('message.tool_call_update')
    expect(fixture.adapterSent[0].payload).toMatchObject({
      sessionId: 'test-session-1',
      toolCallId: 'tc-progress-1',
      detail: 'processing',
    })
  })

  it('无 partialResult → detail 为 undefined', async () => {
    fixture.emitPiEvent({
      type: 'tool_execution_update',
      toolCallId: 'tc-progress-2',
      toolName: 'search',
    })
    await flushAsync()

    expect(fixture.adapterSent).toHaveLength(1)
    expect(fixture.adapterSent[0].payload).toMatchObject({
      sessionId: 'test-session-1',
      toolCallId: 'tc-progress-2',
    })
    expect((fixture.adapterSent[0].payload as Record<string, unknown>).detail).toBeUndefined()
  })
})

// ══════════════════════════════════════════════════════════════════
// DF-4: Extension 列表管理 (WS → Server → ExtensionService → WS)
// ══════════════════════════════════════════════════════════════════

describe('DF-4: Extension 列表管理', () => {
  let server: SidecarServer
  let ws: WebSocket
  let mockExtensionService: {
    scanExtensions: ReturnType<typeof vi.fn>
    getEnabledExtensions: ReturnType<typeof vi.fn>
    toggleExtension: ReturnType<typeof vi.fn>
    getExtensionPaths: ReturnType<typeof vi.fn>
  }

  beforeEach(async () => {
    vi.useRealTimers()
    mockSendCommand.mockClear()

    const port = await getFreePort()
    server = new SidecarServer(port, '/tmp/test-project')
    const sessionService = new SessionService({} as never, {} as never, {} as never, '/tmp', {} as never, {} as never)

    mockExtensionService = {
      scanExtensions: vi.fn().mockResolvedValue([
        { name: 'ext-a', version: '1.0.0', description: 'Extension A', path: '/path/a', enabled: true },
        { name: 'ext-b', version: '2.0.0', description: 'Extension B', path: '/path/b', enabled: false },
      ]),
      getEnabledExtensions: vi.fn().mockResolvedValue([]),
      toggleExtension: vi.fn().mockResolvedValue(undefined),
      getExtensionPaths: vi.fn().mockResolvedValue([]),
    }

    server.setServices(
      sessionService,
      new ConfigService('/tmp'),
      new ModelService(),
      {} as never,
      mockExtensionService as never,
    )

    await server.start()
    ws = await connectClient(port)
  })

  afterEach(async () => {
    ws.close()
    await server.stop()
  })

  it('ExtensionService 返回 2 个 extension → WS 收到 config.extensions 含完整列表', async () => {
    const responsePromise = waitForMessage(ws, 'config.extensions')

    ws.send(JSON.stringify({
      type: 'extension.list',
      id: 'ext-list-df4',
      payload: {},
    }))

    const msg = await responsePromise
    expect(msg.id).toBe('ext-list-df4')
    const payload = msg.payload as { extensions: Array<Record<string, unknown>> }
    expect(payload.extensions).toHaveLength(2)
    expect(payload.extensions[0]).toMatchObject({
      name: 'ext-a',
      version: '1.0.0',
      enabled: true,
    })
    expect(payload.extensions[1]).toMatchObject({
      name: 'ext-b',
      version: '2.0.0',
      enabled: false,
    })

    expect(mockExtensionService.scanExtensions).toHaveBeenCalledOnce()
  })

  it('ExtensionService 为 null → 返回空列表', async () => {
    const port2 = await getFreePort()
    const server2 = new SidecarServer(port2, '/tmp/test-project')
    const sessionService2 = new SessionService({} as never, {} as never, {} as never, '/tmp', {} as never, {} as never)
    server2.setServices(sessionService2, new ConfigService('/tmp'), new ModelService(), {} as never)
    await server2.start()
    const ws2 = await connectClient(port2)

    const responsePromise = waitForMessage(ws2, 'config.extensions')

    ws2.send(JSON.stringify({
      type: 'extension.list',
      id: 'ext-list-null',
      payload: {},
    }))

    const msg = await responsePromise
    expect(msg.payload).toMatchObject({ extensions: [] })

    ws2.close()
    await server2.stop()
  })
})

// ══════════════════════════════════════════════════════════════════
// DF-5: Extension 启用/禁用 (WS → Server → ExtensionService.toggle → WS)
// ══════════════════════════════════════════════════════════════════

describe('DF-5: Extension 启用/禁用', () => {
  let server: SidecarServer
  let ws: WebSocket
  let mockExtensionService: {
    scanExtensions: ReturnType<typeof vi.fn>
    getEnabledExtensions: ReturnType<typeof vi.fn>
    toggleExtension: ReturnType<typeof vi.fn>
    getExtensionPaths: ReturnType<typeof vi.fn>
  }

  beforeEach(async () => {
    vi.useRealTimers()
    mockSendCommand.mockClear()

    const port = await getFreePort()
    server = new SidecarServer(port, '/tmp/test-project')
    const sessionService = new SessionService({} as never, {} as never, {} as never, '/tmp', {} as never, {} as never)

    mockExtensionService = {
      scanExtensions: vi.fn().mockResolvedValue([
        { name: 'ext-a', version: '1.0.0', description: 'Extension A', path: '/path/a', enabled: false },
      ]),
      getEnabledExtensions: vi.fn().mockResolvedValue([]),
      toggleExtension: vi.fn().mockResolvedValue(undefined),
      getExtensionPaths: vi.fn().mockResolvedValue([]),
    }

    server.setServices(
      sessionService,
      new ConfigService('/tmp'),
      new ModelService(),
      {} as never,
      mockExtensionService as never,
    )

    await server.start()
    ws = await connectClient(port)
  })

  afterEach(async () => {
    ws.close()
    await server.stop()
  })

  it('禁用 extension → toggleExtension(false) → scanExtensions → config.extensions', async () => {
    const responsePromise = waitForMessage(ws, 'config.extensions')

    ws.send(JSON.stringify({
      type: 'extension.toggle',
      id: 'ext-toggle-df5',
      payload: { name: 'ext-a', enabled: false },
    }))

    const msg = await responsePromise
    expect(msg.id).toBe('ext-toggle-df5')

    expect(mockExtensionService.toggleExtension).toHaveBeenCalledWith('ext-a', false)
    expect(mockExtensionService.scanExtensions).toHaveBeenCalledOnce()

    const payload = msg.payload as { extensions: Array<Record<string, unknown>> }
    expect(payload.extensions).toHaveLength(1)
    expect(payload.extensions[0]).toMatchObject({
      name: 'ext-a',
      enabled: false,
    })
  })

  it('ExtensionService 为 null → 返回 error', async () => {
    const port2 = await getFreePort()
    const server2 = new SidecarServer(port2, '/tmp/test-project')
    const sessionService2 = new SessionService({} as never, {} as never, {} as never, '/tmp', {} as never, {} as never)
    server2.setServices(sessionService2, new ConfigService('/tmp'), new ModelService(), {} as never)
    await server2.start()
    const ws2 = await connectClient(port2)

    const errorPromise = waitForMessage(ws2, 'error')

    ws2.send(JSON.stringify({
      type: 'extension.toggle',
      id: 'ext-toggle-null',
      payload: { name: 'ext-a', enabled: true },
    }))

    const errMsg = await errorPromise
    expect(errMsg.payload).toMatchObject({
      code: 'handler_error',
      message: expect.stringContaining('Extension service not available'),
    })

    ws2.close()
    await server2.stop()
  })
})
