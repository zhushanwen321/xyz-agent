/**
 * Hook API 测试
 *
 * 验证主线程侧 registerHookRpcHandlers 和 Worker 侧 createHookApi：
 * - plugin.hooks.register 注册成功 → 返回 { registered: true }
 * - 多个 handler 按优先级排序存储
 * - createHookApi.onPiEvent 注册并触发回调
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'
import type { WorkerPort } from '../src/services/plugin-service/plugin-rpc-server.js'
import {
  registerHookRpcHandlers,
  createHookApi,
} from '../src/services/plugin-service/hook-api.js'
import type { PluginRpcClient } from '../src/services/plugin-service/plugin-rpc-client.js'
import type { HookEntry, PluginDescriptor, Disposable } from '../src/services/plugin-service/plugin-types.js'
import type { RpcResponse } from '../src/services/plugin-service/plugin-types.js'

// ── Helper: mock WorkerPort ──────────────────────────────────────────────

function createMockPort(): WorkerPort & { messages: unknown[] } {
  const messages: unknown[] = []
  return {
    messages,
    postMessage(msg: unknown) {
      messages.push(msg)
    },
  }
}

function extractLastResponse(port: ReturnType<typeof createMockPort>): RpcResponse & { error?: { code: number; message: string } } {
  const last = port.messages[port.messages.length - 1] as { response: RpcResponse }
  return last.response as RpcResponse & { error?: { code: number; message: string } }
}

// ── Helper: mock PluginRpcClient ─────────────────────────────────────────

interface MockRpcClient {
  requestCalls: Array<{ method: string; params: Record<string, unknown> }>
  requestResults: Map<string, unknown>
  onNotificationHandlers: Map<string, (params: unknown) => void>
  // 暴露与 PluginRpcClient 相同的接口
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>
  onNotification: (method: string, handler: (params: unknown) => void) => () => void
  notify: (method: string, params: Record<string, unknown>) => void
}

function createMockRpcClient(): MockRpcClient & PluginRpcClient {
  const requestCalls: Array<{ method: string; params: Record<string, unknown> }> = []
  const requestResults = new Map<string, unknown>()
  const onNotificationHandlers = new Map<string, (params: unknown) => void>()

  return {
    requestCalls,
    requestResults,
    onNotificationHandlers,

    request: (method: string, params: Record<string, unknown>) => {
      requestCalls.push({ method, params })
      const result = requestResults.get(method)
      return Promise.resolve(result !== undefined ? result : undefined)
    },

    onNotification: (method: string, handler: (params: unknown) => void) => {
      // 每个 method 只允许一个 handler（在当前测试场景中够用）
      onNotificationHandlers.set(method, handler)
      return () => {
        onNotificationHandlers.delete(method)
      }
    },

    notify: (_method: string, _params: Record<string, unknown>) => {
      // 测试中不需要
    },
  } as unknown as MockRpcClient & PluginRpcClient
}

// ── 主线程侧：registerHookRpcHandlers ─────────────────────────────────

describe('Hook API — registerHookRpcHandlers', () => {
  let rpc: PluginRpcServer
  let hookRegistry: Map<string, HookEntry[]>
  let port: ReturnType<typeof createMockPort>

  /** mock getDescriptor：根据 source/trustLevel 返回不同优先级 */
  let mockDescriptors = new Map<string, PluginDescriptor>()

  beforeEach(() => {
    rpc = new PluginRpcServer()
    hookRegistry = new Map()
    mockDescriptors = new Map()

    registerHookRpcHandlers(rpc, {
      hookRegistry,
      getDescriptor: (pluginId) => mockDescriptors.get(pluginId),
    })

    port = createMockPort()
    rpc.registerWorker('w1', port)
  })

  // ── TC-HK-01: 注册成功 ──────────────────────────────────────────

  it('TC-HK-01: register hook → returns { registered: true }', async () => {
    await rpc.dispatch('w1', {
      jsonrpc: '2.0',
      id: 1,
      method: 'plugin.hooks.register',
      params: {
        pluginId: 'my-plugin',
        hookType: 'onBeforeSendMessage',
        handlerId: 'hook_my-plugin_1',
      },
    })

    const resp = extractLastResponse(port)
    assert.strictEqual(resp.id, 1)
    assert.ok('result' in resp)
    assert.deepStrictEqual(resp.result, { registered: true })

    // 验证 registry
    const entries = hookRegistry.get('onBeforeSendMessage')
    assert.ok(entries)
    assert.strictEqual(entries.length, 1)
    assert.strictEqual(entries[0].handlerId, 'hook_my-plugin_1')
    // 没有 descriptor → 默认 priority 200
    assert.strictEqual(entries[0].priority, 200)
  })

  // ── TC-HK-02: 多个 handler 按优先级排序 ─────────────────────────

  it('TC-HK-02: multiple handlers sorted by priority (lowest first)', async () => {
    // 注册三个 handler，模拟不同 trustLevel
    mockDescriptors.set('plugin-builtin', {
      pluginId: 'plugin-builtin',
      version: '1.0.0',
      displayName: 'Built-in',
      description: '',
      main: 'index.js',
      activationEvents: [],
      trustLevel: 'trusted',
      status: 'ACTIVE',
      contributes: {},
      permissions: [],
      engines: { 'xyz-agent': '*' },
      pluginPath: '/tmp/builtin',
      source: 'built-in',
      extensionDependencies: [],
    })
    mockDescriptors.set('plugin-trusted', {
      pluginId: 'plugin-trusted',
      version: '1.0.0',
      displayName: 'Trusted',
      description: '',
      main: 'index.js',
      activationEvents: [],
      trustLevel: 'trusted',
      status: 'ACTIVE',
      contributes: {},
      permissions: [],
      engines: { 'xyz-agent': '*' },
      pluginPath: '/tmp/trusted',
      source: 'external',
      extensionDependencies: [],
    })
    mockDescriptors.set('plugin-sandboxed', {
      pluginId: 'plugin-sandboxed',
      version: '1.0.0',
      displayName: 'Sandboxed',
      description: '',
      main: 'index.js',
      activationEvents: [],
      trustLevel: 'sandbox',
      status: 'ACTIVE',
      contributes: {},
      permissions: [],
      engines: { 'xyz-agent': '*' },
      pluginPath: '/tmp/sandbox',
      source: 'external',
      extensionDependencies: [],
    })

    // 按乱序注册 → 验证优先级排序结果
    await rpc.dispatch('w1', {
      jsonrpc: '2.0', id: 1, method: 'plugin.hooks.register',
      params: { pluginId: 'plugin-sandboxed', hookType: 'onBeforeSendMessage', handlerId: 'h_sandbox' },
    })
    await rpc.dispatch('w1', {
      jsonrpc: '2.0', id: 2, method: 'plugin.hooks.register',
      params: { pluginId: 'plugin-builtin', hookType: 'onBeforeSendMessage', handlerId: 'h_builtin' },
    })
    await rpc.dispatch('w1', {
      jsonrpc: '2.0', id: 3, method: 'plugin.hooks.register',
      params: { pluginId: 'plugin-trusted', hookType: 'onBeforeSendMessage', handlerId: 'h_trusted' },
    })

    const entries = hookRegistry.get('onBeforeSendMessage')
    assert.ok(entries)
    assert.strictEqual(entries.length, 3)

    // 期望顺序: built-in (priority=0) → trusted (priority=100) → sandbox (priority=200)
    assert.strictEqual(entries[0].handlerId, 'h_builtin')
    assert.strictEqual(entries[0].priority, 0)

    assert.strictEqual(entries[1].handlerId, 'h_trusted')
    assert.strictEqual(entries[1].priority, 100)

    assert.strictEqual(entries[2].handlerId, 'h_sandbox')
    assert.strictEqual(entries[2].priority, 200)
  })
})

// ── Worker 侧：createHookApi ──────────────────────────────────────────

describe('Hook API — createHookApi (Worker side)', () => {
  let mockClient: MockRpcClient & PluginRpcClient
  let invokedParams: unknown[]

  beforeEach(() => {
    mockClient = createMockRpcClient()
    invokedParams = []
  })

  // ── TC-HK-03: onPiEvent 注册并触发 ────────────────────────────

  it('TC-HK-03: onPiEvent registers handler and triggers on invoke notification', async () => {
    const hookApi = createHookApi(mockClient, 'test-plugin')

    // 注册 onPiEvent handler
    const collected: Array<{ eventName: string; data: unknown }> = []
    const disposable = await hookApi.onPiEvent('session:create', async (eventName, data) => {
      collected.push({ eventName, data })
    })

    // 验证注册请求已发送
    const registerCall = mockClient.requestCalls.find(c => c.method === 'plugin.hooks.register')
    assert.ok(registerCall, 'should have sent register request')
    assert.strictEqual(registerCall.params.pluginId, 'test-plugin')
    assert.strictEqual(registerCall.params.hookType, 'onPiEvent:session:create')
    assert.ok(typeof registerCall.params.handlerId === 'string')

    const handlerId = registerCall.params.handlerId as string

    // 模拟主线程发送 hook.invoke 通知
    const invokeHandler = mockClient.onNotificationHandlers.get('plugin.hooks.invoke')
    assert.ok(invokeHandler, 'should have registered invoke notification handler')

    // 触发 invoke
    invokeHandler({
      handlerId,
      context: { eventName: 'session:create', data: { sessionId: 's1' } },
    })

    // 验证 handler 被调用（等待微任务）
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.strictEqual(collected.length, 1)
    assert.strictEqual(collected[0].eventName, 'session:create')
    assert.deepStrictEqual(collected[0].data, { sessionId: 's1' })

    // 验证 invoke result 已返回
    const resultCall = mockClient.requestCalls.find(c => c.method === 'plugin.hooks.invoke.result')
    assert.ok(resultCall, 'should have sent invoke result')
    assert.strictEqual(resultCall.params.handlerId, handlerId)

    // 清理
    disposable.dispose()
  })

  // ── TC-HK-04: onBeforeSendMessage 注册并触发 ───────────────────

  it('TC-HK-04: onBeforeSendMessage registers and intercepts on invoke', async () => {
    const hookApi = createHookApi(mockClient, 'test-plugin')

    const disposable = await hookApi.onBeforeSendMessage(async (ctx) => {
      invokedParams.push(ctx)
      return { blocked: true, modifiedContent: ctx.data }
    })

    const registerCall = mockClient.requestCalls.find(c => c.method === 'plugin.hooks.register')
    assert.ok(registerCall)
    assert.strictEqual(registerCall.params.hookType, 'onBeforeSendMessage')

    const handlerId = registerCall.params.handlerId as string
    const invokeHandler = mockClient.onNotificationHandlers.get('plugin.hooks.invoke')
    assert.ok(invokeHandler)

    invokeHandler({
      handlerId,
      context: { pluginId: 'test-plugin', hookType: 'onBeforeSendMessage', data: { text: 'hello' }, timestamp: Date.now() },
    })

    await new Promise(resolve => setTimeout(resolve, 10))
    assert.strictEqual(invokedParams.length, 1)
    assert.strictEqual((invokedParams[0] as Record<string, unknown>).hookType, 'onBeforeSendMessage')

    // 验证结果已返回
    const resultCall = mockClient.requestCalls.find(c => c.method === 'plugin.hooks.invoke.result')
    assert.ok(resultCall)
    assert.ok((resultCall.params.result as Record<string, unknown>).blocked)

    disposable.dispose()
  })

  // ── TC-HK-05: dispose 清理本地 handler ─────────────────────────

  it('TC-HK-05: dispose removes handler, no invoke response sent after dispose', async () => {
    const hookApi = createHookApi(mockClient, 'test-plugin')

    const collected: number[] = []
    const disposable = await hookApi.onBeforeToolCall(async (ctx) => {
      collected.push(1)
      return { blocked: false }
    })

    const registerCall = mockClient.requestCalls.find(c => c.method === 'plugin.hooks.register')
    assert.ok(registerCall)
    const handlerId = registerCall.params.handlerId as string

    // dispose
    disposable.dispose()

    // 再次触发 invoke → 不触发 handler（已清除）
    const invokeHandler = mockClient.onNotificationHandlers.get('plugin.hooks.invoke')
    assert.ok(invokeHandler)
    invokeHandler({ handlerId, context: {} })

    await new Promise(resolve => setTimeout(resolve, 10))
    assert.strictEqual(collected.length, 0, 'handler should not be called after dispose')

    // 验证 unregister 请求已发送
    const unregisterCall = mockClient.requestCalls.find(c => c.method === 'plugin.hooks.unregister')
    assert.ok(unregisterCall)
    assert.strictEqual(unregisterCall.params.handlerId, handlerId)
  })
})
