/**
 * Plugin UI Dialog RPC — 串行排队 + 60s 超时 + WS 往返
 *
 * 验证 showConfirm/showSelect/showInput 通过 handleUiRequest
 * 向前端广播 UI 请求，并通过 handleUiResponse 接收结果。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PluginService } from '../src/services/plugin-service/plugin-service.js'
import { PluginRegistry } from '../src/services/plugin-service/plugin-registry.js'
import type { IMessageBroker, ISessionService } from '../src/interfaces.js'
import type { IPluginServiceDeps } from '../src/services/plugin-service/plugin-types.js'

// ── Fixtures ──────────────────────────────────────────────────

function createMockBroker(): IMessageBroker & { messages: Array<{ type: string; payload: unknown }> } {
  const messages: Array<{ type: string; payload: unknown }> = []
  return {
    messages,
    send: vi.fn(),
    broadcast: vi.fn((msg) => {
      messages.push({ type: msg.type, payload: msg.payload })
    }),
    sendError: vi.fn(),
  }
}

function createService(broker?: ReturnType<typeof createMockBroker>, depsOverrides?: Partial<IPluginServiceDeps>): {
  service: PluginService
  broker: ReturnType<typeof createMockBroker>
} {
  const b = broker ?? createMockBroker()
  const registry = new PluginRegistry('/tmp/fake-project', '/tmp/fake-project')
  const deps: IPluginServiceDeps = {
    broadcastFn: (type, payload) => b.broadcast({ type, payload } as never),
    ...depsOverrides,
  }
  const service = new PluginService(registry, b, deps)
  return { service, broker: b }
}

/** 活跃 session 桩：listPersistedSessions 返回 status==='active' 的 session（ActiveSessionResolver 全盘扫描依据）。 */
function createActiveSessionStub(sessionId: string): ISessionService {
  return {
    listPersistedSessions: () => [{
      cwd: '/tmp',
      sessions: [{ id: sessionId, label: sessionId, cwd: '/tmp', status: 'active', lastActiveAt: 1, modelId: 'test-model' }],
    }],
  } as unknown as ISessionService
}

function getUiHandlers(service: PluginService) {
  const svc = service as unknown as {
    registerRpcMethods(): void
    rpcServer: {
      methods: Map<string, (params: Record<string, unknown>) => Promise<unknown>>
    }
  }
  svc.registerRpcMethods()
  return svc.rpcServer.methods
}

// Access internal UI 队列状态（重构后下沉到 UiRequestQueue 模块，直接暴露实例便于实时读取）
function getInternals(service: PluginService) {
  return (service as unknown as { uiRequestQueue: {
    activeUiRequest: string | null
    uiRequestQueue: Array<{ params: Record<string, unknown>; resolve: (v: unknown) => void }>
    pendingUiRequests: Map<string, { resolve: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }>
  } }).uiRequestQueue
}

// ══════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════

describe('UI Dialog RPC — showConfirm WS往返', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('showConfirm broadcasts UI request and resolves on response', async () => {
    const { service, broker } = createService()
    const methods = getUiHandlers(service)

    const confirmPromise = methods.get('plugin.ui.showConfirm')!({
      pluginId: 'test-plugin',
      title: 'Confirm?',
      message: 'Are you sure?',
    })

    // Should have broadcast a UI request
    expect(broker.broadcast).toHaveBeenCalled()
    const broadcastCall = broker.messages.find(m => m.type === 'plugin:uiRequest' || (m.payload as Record<string, unknown>)?.requestId)
    expect(broadcastCall).toBeDefined()

    // Extract requestId from broadcast
    const payload = broadcastCall!.payload as Record<string, unknown>
    const requestId = payload.requestId as string
    expect(requestId).toBeTruthy()
    // MF-3（R2 回归）：无活跃 session（deps.sessionService 未注入）→ sessionId 为 undefined
    // （前端 C2 守卫按 sessionId 分区消费，无 sid 会丢弃——此断言锁住「注入缺失」回归）
    expect(payload.sessionId).toBeUndefined()

    // Simulate frontend response（走公共接口，行为不变）
    service.handleUiResponse(requestId, true)

    const result = await confirmPromise
    expect(result).toBe(true)
  })

  it('showConfirm broadcasts active sessionId in payload (MF-2 R2 regression)', async () => {
    // 活跃 session 注入：ActiveSessionResolver 经 deps.sessionService.listPersistedSessions
    // 找 status==='active' 的 session，resolve 时点注入 broadcast payload（与 views.update 同源）
    const { service, broker } = createService(undefined, { sessionService: createActiveSessionStub('s1') })
    const methods = getUiHandlers(service)

    const confirmPromise = methods.get('plugin.ui.showConfirm')!({
      pluginId: 'test-plugin',
      title: 'Confirm?',
      message: 'Are you sure?',
    })

    const broadcastCall = broker.messages.find(m => m.type === 'plugin:uiRequest' || (m.payload as Record<string, unknown>)?.requestId)
    expect(broadcastCall).toBeDefined()
    const payload = broadcastCall!.payload as Record<string, unknown>
    // MF-3（R2）：核心注入断言——无 sid 的 uiRequest 会被前端 C2 守卫丢弃，plugin dialog 永不弹出
    expect(payload.sessionId).toBe('s1')

    service.handleUiResponse(payload.requestId as string, true)
    const result = await confirmPromise
    expect(result).toBe(true)
  })

  it('showSelect returns selected option', async () => {
    const { service } = createService()
    const methods = getUiHandlers(service)

    const selectPromise = methods.get('plugin.ui.showSelect')!({
      pluginId: 'p1',
      title: 'Choose',
      options: ['A', 'B'],
    })

    const internals = getInternals(service)
    // Get the pending request's requestId
    const pendingEntries = Array.from(internals.pendingUiRequests.entries())
    expect(pendingEntries.length).toBe(1)
    const [reqId] = pendingEntries[0]

    service.handleUiResponse(reqId, 'A')

    const result = await selectPromise
    expect(result).toBe('A')
  })

  it('showInput returns user input', async () => {
    const { service } = createService()
    const methods = getUiHandlers(service)

    const inputPromise = methods.get('plugin.ui.showInput')!({
      pluginId: 'p1',
      title: 'Enter name',
    })

    const internals = getInternals(service)
    const pendingEntries = Array.from(internals.pendingUiRequests.entries())
    const [reqId] = pendingEntries[0]
    service.handleUiResponse(reqId, 'typed-value')

    const result = await inputPromise
    expect(result).toBe('typed-value')
  })
})

describe('UI Dialog — serial queue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('queues second request while first is pending', async () => {
    const { service } = createService()
    const methods = getUiHandlers(service)
    const internals = getInternals(service)

    // First request — no response yet
    const promise1 = methods.get('plugin.ui.showConfirm')!({
      pluginId: 'p1', title: 'Q1', message: 'First?',
    })

    expect(internals.activeUiRequest).toBeTruthy()

    // Second request — should be queued
    const promise2 = methods.get('plugin.ui.showConfirm')!({
      pluginId: 'p1', title: 'Q2', message: 'Second?',
    })

    expect(internals.uiRequestQueue.length).toBe(1)

    // Resolve first
    const pending1 = Array.from(internals.pendingUiRequests.keys())[0]
    service.handleUiResponse(pending1, true)

    const r1 = await promise1
    expect(r1).toBe(true)

    // Second should now be active
    expect(internals.uiRequestQueue.length).toBe(0)

    // Resolve second
    const pending2 = Array.from(internals.pendingUiRequests.keys())[0]
    service.handleUiResponse(pending2, false)

    const r2 = await promise2
    expect(r2).toBe(false)
  })
})

describe('UI Dialog — 60s timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('showConfirm resolves with default (false) after timeout', async () => {
    const { service } = createService()
    const methods = getUiHandlers(service)

    const confirmPromise = methods.get('plugin.ui.showConfirm')!({
      pluginId: 'p1', title: 'T', message: 'Timeout test',
    })

    // Advance past 60s
    vi.advanceTimersByTime(61_000)

    const result = await confirmPromise
    expect(result).toBe(false)
  })

  it('showSelect resolves with undefined after timeout', async () => {
    const { service } = createService()
    const methods = getUiHandlers(service)

    const selectPromise = methods.get('plugin.ui.showSelect')!({
      pluginId: 'p1', title: 'T', options: ['A'],
    })

    vi.advanceTimersByTime(61_000)

    const result = await selectPromise
    expect(result).toBeUndefined()
  })

  it('showInput resolves with undefined after timeout', async () => {
    const { service } = createService()
    const methods = getUiHandlers(service)

    const inputPromise = methods.get('plugin.ui.showInput')!({
      pluginId: 'p1', title: 'T',
    })

    vi.advanceTimersByTime(61_000)

    const result = await inputPromise
    expect(result).toBeUndefined()
  })
})
