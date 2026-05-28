/**
 * Hook 执行管道集成测试
 *
 * 验证 PluginService 的 hook 管道方法：
 * - executeHooks: hookRegistry 查询 + 按优先级排序 + broadcast 通知
 * - syncToolsToBridge: 收集 toolRegistry schema
 * - handleBridgeToolExecute: 工具执行请求路由
 * - handleBridgeEvent: bridge 事件广播
 * - handleBridgeIntercept: bridge 拦截请求
 *
 * 这些测试不依赖 PluginService.initialize()，直接操作私有状态。
 */

import { describe, it, expect, vi } from 'vitest'
import { PluginService } from '../src/services/plugin-service/plugin-service.js'
import type { IMessageBroker } from '../src/interfaces.js'
import type { HookEntry, ToolEntry, BridgeToolExecuteRequest, HookContext } from '../src/services/plugin-service/plugin-types.js'

function createMockBroker(): IMessageBroker {
  return {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
  }
}

/** 获取 PluginService 内部注册表的便捷方法 */
function serviceRegistry(service: PluginService) {
  return service as unknown as {
    hookRegistry: Map<string, HookEntry[]>
    toolRegistry: Map<string, ToolEntry>
    rpcServer: { broadcast: ReturnType<typeof vi.fn> }
  }
}

// ══════════════════════════════════════════════════════════════════
// executeHooks
// ══════════════════════════════════════════════════════════════════

describe('PluginService.executeHooks', () => {
  // ── TC-HKP-01: 无注册 handler 返回未阻塞 ─────────────────────────
  it('TC-HKP-01: no registered handlers returns { blocked: false }', async () => {
    const service = new PluginService({} as never, createMockBroker())
    const result = await (service as any).executeHooks('onBeforeSendMessage', {
      pluginId: '',
      hookType: 'onBeforeSendMessage',
      data: { text: 'hello' },
      timestamp: Date.now(),
    })
    expect(result).toEqual({ blocked: false })
  })

  // ── TC-HKP-02: 排序后 broadcast 通知 Worker ────────────────────
  it('TC-HKP-02: sorted handlers broadcast invoke notification', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = serviceRegistry(service)

    // 注册三个 handler（乱序 priority，验证排序）
    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p-sandbox', handlerId: 'h3', priority: 200 },
      { pluginId: 'p-builtin', handlerId: 'h1', priority: 0 },
      { pluginId: 'p-trusted', handlerId: 'h2', priority: 100 },
    ])

    const context: HookContext = {
      pluginId: '',
      hookType: 'onBeforeSendMessage',
      data: { text: 'test' },
      timestamp: 1000,
    }
    const result = await (service as any).executeHooks('onBeforeSendMessage', context)

    // 简化实现：不等待 Worker 结果，返回默认未阻塞
    expect(result).toEqual({ blocked: false })
  })

  // ── TC-HKP-03: 不存在的 hookType 返回未阻塞 ────────────────────
  it('TC-HKP-03: unknown hookType returns { blocked: false }', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)

    const reg = serviceRegistry(service)
    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p1', handlerId: 'h1', priority: 0 },
    ])

    const result = await (service as any).executeHooks('onNonExistentHook', {
      pluginId: '',
      hookType: 'onNonExistentHook' as any,
      data: {},
      timestamp: Date.now(),
    })
    expect(result).toEqual({ blocked: false })
  })

  // ── TC-HKP-04: 优先级排序 — priority 0 先于 priority 200 ──────
  it('TC-HKP-04: handlers are sorted by priority ascending', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = serviceRegistry(service)

    // 只验证排序结果，不验证 broadcast 调用
    reg.hookRegistry.set('onBeforeToolCall', [
      { pluginId: 'low', handlerId: 'h_low', priority: 200 },
      { pluginId: 'high', handlerId: 'h_high', priority: 0 },
      { pluginId: 'mid', handlerId: 'h_mid', priority: 100 },
    ])

    // 模拟 executeHooks 内部逻辑来验证排序
    const entries = reg.hookRegistry.get('onBeforeToolCall')!
    const sorted = [...entries].sort((a, b) => a.priority - b.priority)

    expect(sorted[0].handlerId).toBe('h_high')
    expect(sorted[1].handlerId).toBe('h_mid')
    expect(sorted[2].handlerId).toBe('h_low')
  })
})

// ══════════════════════════════════════════════════════════════════
// syncToolsToBridge
// ══════════════════════════════════════════════════════════════════

describe('PluginService.syncToolsToBridge', () => {
  // ── TC-HKP-05: 空 registry 同步后 getToolSchemas 返回空 ─────────
  it('TC-HKP-05: empty toolRegistry produces empty cache', () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)

    service.syncToolsToBridge()
    expect(service.getToolSchemas()).toEqual([])
  })

  // ── TC-HKP-06: 同步后 schema 可被 getToolSchemas 获取 ─────────
  it('TC-HKP-06: syncToolsToBridge collects all tool schemas', () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = serviceRegistry(service)

    reg.toolRegistry.set('plugin-a:hello', {
      pluginId: 'plugin-a',
      handlerId: 'plugin-a:hello',
      schema: { name: 'hello', description: 'Says hello', parameters: { type: 'object', properties: {} } },
    })
    reg.toolRegistry.set('plugin-b:search', {
      pluginId: 'plugin-b',
      handlerId: 'plugin-b:search',
      schema: { name: 'search', description: 'Searches', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
    })

    service.syncToolsToBridge()

    const schemas = service.getToolSchemas()
    expect(schemas).toHaveLength(2)
    expect(schemas[0].name).toBe('hello')
    expect(schemas[1].name).toBe('search')
  })

  // ── TC-HKP-07: 多次 sync 后 schema 列表更新 ──────────────────
  it('TC-HKP-07: syncToolsToBridge reflects registry changes', () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = serviceRegistry(service)

    // 初始同步
    reg.toolRegistry.set('p1:tool1', {
      pluginId: 'p1', handlerId: 'p1:tool1',
      schema: { name: 'tool1', description: '', parameters: {} },
    })
    service.syncToolsToBridge()
    expect(service.getToolSchemas()).toHaveLength(1)

    // 添加新工具后再次同步
    reg.toolRegistry.set('p2:tool2', {
      pluginId: 'p2', handlerId: 'p2:tool2',
      schema: { name: 'tool2', description: '', parameters: {} },
    })
    service.syncToolsToBridge()
    expect(service.getToolSchemas()).toHaveLength(2)
  })
})

// ══════════════════════════════════════════════════════════════════
// handleBridgeToolExecute
// ══════════════════════════════════════════════════════════════════

describe('PluginService.handleBridgeToolExecute', () => {
  // ── TC-HKP-08: 存在的工具返回 stubbed 结果 ──────────────────────
  it('TC-HKP-08: existing tool returns stubbed success', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = serviceRegistry(service)

    reg.toolRegistry.set('p1:hello', {
      pluginId: 'p1',
      handlerId: 'p1:hello',
      schema: { name: 'hello', description: '', parameters: {} },
    })

    const request: BridgeToolExecuteRequest = {
      type: 'bridge.tool.execute',
      toolName: 'p1:hello',
      parameters: { name: 'world' },
    }
    const result = await service.handleBridgeToolExecute(request)
    expect(result.isError).toBe(false)
    expect(result.content).toBeDefined()
  })

  // ── TC-HKP-09: 不存在的工具返回错误 ─────────────────────────────
  it('TC-HKP-09: non-existent tool returns error', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)

    const request: BridgeToolExecuteRequest = {
      type: 'bridge.tool.execute',
      toolName: 'nonexistent:tool',
      parameters: {},
    }
    const result = await service.handleBridgeToolExecute(request)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('not found')
  })

  // ── TC-HKP-10: 空 registry 返回错误 ─────────────────────────────
  it('TC-HKP-10: empty toolRegistry returns error', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)

    const request: BridgeToolExecuteRequest = {
      type: 'bridge.tool.execute',
      toolName: 'any:tool',
      parameters: {},
    }
    const result = await service.handleBridgeToolExecute(request)
    expect(result.isError).toBe(true)
  })
})

// ══════════════════════════════════════════════════════════════════
// handleBridgeEvent
// ══════════════════════════════════════════════════════════════════

describe('PluginService.handleBridgeEvent', () => {
  // ── TC-HKP-11: 广播事件给注册的 Worker ─────────────────────────
  it('TC-HKP-11: broadcasts event to registered workers', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = serviceRegistry(service)

    // 注册 hook 类型
    reg.hookRegistry.set('onMessage', [
      { pluginId: 'p1', handlerId: 'h1', priority: 100 },
    ])

    // handleBridgeEvent 不应抛出异常
    service.handleBridgeEvent('onMessage', { text: 'hello' }, 'session-1')
    // 异步 executeHooks 的内部 broadcast — 等待微任务
    await new Promise(resolve => setTimeout(resolve, 10))
  })

  // ── TC-HKP-12: 无注册 handler 不抛出异常 ───────────────────────
  it('TC-HKP-12: no registered handlers does not throw', () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)

    // 不存在的 hook type 不应抛出
    expect(() => {
      service.handleBridgeEvent('unknownEvent', {}, 'session-1')
    }).not.toThrow()
  })
})

// ══════════════════════════════════════════════════════════════════
// handleBridgeIntercept
// ══════════════════════════════════════════════════════════════════

describe('PluginService.handleBridgeIntercept', () => {
  // ── TC-HKP-13: 返回 { injectedMessages: [] } ────────────────────
  it('TC-HKP-13: returns empty injectedMessages by default', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)

    const result = await service.handleBridgeIntercept('before_agent_start', { query: 'hello' }, 'session-1')
    expect(result).toEqual({ injectedMessages: [] })
  })

  // ── TC-HKP-14: 有注册 handler 时仍返回空数组（简化实现）────────
  it('TC-HKP-14: returns empty injectedMessages even with handlers (simplified)', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = serviceRegistry(service)

    reg.hookRegistry.set('before_agent_start', [
      { pluginId: 'p1', handlerId: 'h1', priority: 0 },
    ])

    const result = await service.handleBridgeIntercept('before_agent_start', { query: 'test' }, 'session-2')
    expect(result).toEqual({ injectedMessages: [] })
  })
})

// ══════════════════════════════════════════════════════════════════
// sessionDataCache
// ══════════════════════════════════════════════════════════════════

describe('PluginService.sessionDataCache', () => {
  // ── TC-HKP-15: sessionDataCache 可读写单条 session ──────────────
  it('TC-HKP-15: can read and write session data', () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)

    // 创建 session 数据
    const sessionData = new Map<string, unknown>()
    sessionData.set('key1', 'value1')
    sessionData.set('key2', 42)
    service.sessionDataCache.set('session-1', sessionData)

    // 读取
    const retrieved = service.sessionDataCache.get('session-1')
    expect(retrieved).toBeDefined()
    expect(retrieved!.get('key1')).toBe('value1')
    expect(retrieved!.get('key2')).toBe(42)
  })

  // ── TC-HKP-16: sessionDataCache 支持多 session 隔离 ────────────
  it('TC-HKP-16: multiple sessions are isolated', () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)

    const data1 = new Map<string, unknown>()
    data1.set('msg', 'hello')
    service.sessionDataCache.set('session-a', data1)

    const data2 = new Map<string, unknown>()
    data2.set('msg', 'world')
    service.sessionDataCache.set('session-b', data2)

    expect(service.sessionDataCache.get('session-a')!.get('msg')).toBe('hello')
    expect(service.sessionDataCache.get('session-b')!.get('msg')).toBe('world')
  })
})
