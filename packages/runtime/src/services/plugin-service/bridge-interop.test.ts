/**
 * handleBridgeToolExecute clientId 透传测试（P7 长期方案 A 主线程侧入口）。
 *
 * 验证 bridge invoke 从 session lease owner 反查 clientId 并塞进 plugin.tool.execute
 * invoke params——这是「ALS 跨独立 I/O tick 断裂」修复链的主线程起点。
 *
 * 链路：bridge-handler 收 bridge:tool_execute（sessionId）→ handleBridgeToolExecute
 *   → clientIdResolver(sessionId) 反查 lease owner clientId → invoke params 携带 clientId
 *   → Worker 存为执行上下文 → RPC 回主线程 handler 据此 per-client resolve。
 */
import { describe, it, expect, vi } from 'vitest'
import { handleBridgeToolExecute } from './bridge-interop.js'
import type { ToolEntry } from './plugin-types.js'

/** 构造 mock PluginHost：getWorkerHandle 返回固定 workerId + postMessage spy。 */
function mockHost(workerId = 'w1'): {
  host: import('./plugin-host.js').PluginHost
  postMessage: ReturnType<typeof vi.fn>
} {
  const postMessage = vi.fn()
  return {
    host: {
      getWorkerHandle: () => ({ workerId, postMessage }),
    } as unknown as import('./plugin-host.js').PluginHost,
    postMessage,
  }
}

/** 构造 mock PluginRpcServer：invoke 直接返回（不真发 Worker），捕获 params。 */
function mockRpcServer(): {
  rpcServer: import('./plugin-rpc-server.js').PluginRpcServer
  invoke: ReturnType<typeof vi.fn>
} {
  const invoke = vi.fn(async () => ({ content: 'ok' }))
  return {
    rpcServer: { invoke } as unknown as import('./plugin-rpc-server.js').PluginRpcServer,
    invoke,
  }
}

/** 构造含一个工具的 toolRegistry。 */
function mockToolRegistry(toolName = 'my-tool'): Map<string, ToolEntry> {
  const entry: ToolEntry = {
    pluginId: 'p1',
    handlerId: 'h1',
    schema: { name: toolName, description: 'd', parameters: {} },
  }
  return new Map([['p1:h1', entry]])
}

describe('handleBridgeToolExecute clientId 透传 (P7 长期方案 A)', () => {
  // TC-b1: clientIdResolver 返回 clientId → invoke params 携带该 clientId
  it('TC-b1: clientIdResolver 命中 → invoke plugin.tool.execute params 携带 clientId', async () => {
    const registry = mockToolRegistry()
    const { host } = mockHost()
    const { rpcServer, invoke } = mockRpcServer()
    const resolver = vi.fn((sessionId: string | undefined) =>
      sessionId === 'sessionX' ? 'client-A' : undefined)

    await handleBridgeToolExecute(
      { type: 'bridge.tool.execute', toolName: 'my-tool', parameters: {}, sessionId: 'sessionX', toolCallId: 'tc1' },
      registry, host, rpcServer, resolver,
    )

    expect(resolver).toHaveBeenCalledWith('sessionX')
    expect(invoke).toHaveBeenCalledTimes(1)
    const [, method, params] = invoke.mock.calls[0] as [string, string, Record<string, unknown>]
    expect(method).toBe('plugin.tool.execute')
    expect(params.clientId).toBe('client-A')
  })

  // TC-b2: clientIdResolver 返回 undefined（无 lease）→ invoke params clientId undefined（resolver 全局 fallback）
  it('TC-b2: clientIdResolver 返回 undefined → invoke params clientId 为 undefined', async () => {
    const registry = mockToolRegistry()
    const { host } = mockHost()
    const { rpcServer, invoke } = mockRpcServer()
    const resolver = vi.fn(() => undefined)

    await handleBridgeToolExecute(
      { type: 'bridge.tool.execute', toolName: 'my-tool', parameters: {}, sessionId: 'no-lease-session' },
      registry, host, rpcServer, resolver,
    )

    const params = invoke.mock.calls[0][2] as Record<string, unknown>
    expect(params.clientId).toBeUndefined()
  })

  // TC-b3: 不传 clientIdResolver（未注入 leaseManager）→ invoke 不带 clientId（零回归）
  it('TC-b3: 无 clientIdResolver（leaseManager 未注入）→ invoke params 不含 clientId', async () => {
    const registry = mockToolRegistry()
    const { host } = mockHost()
    const { rpcServer, invoke } = mockRpcServer()

    await handleBridgeToolExecute(
      { type: 'bridge.tool.execute', toolName: 'my-tool', parameters: {}, sessionId: 'sessionX' },
      registry, host, rpcServer, // 不传 resolver
    )

    const params = invoke.mock.calls[0][2] as Record<string, unknown>
    expect(params.clientId).toBeUndefined()
  })

  // TC-b4: 不同 session（不同 lease owner）→ 各自的 clientId（per-client 隔离）
  it('TC-b4: sessionX→client-A, sessionY→client-B（per-client 隔离）', async () => {
    const registry = mockToolRegistry()
    const { host } = mockHost()
    const { rpcServer, invoke } = mockRpcServer()
    const leaseOwners = new Map([['sessionX', 'client-A'], ['sessionY', 'client-B']])
    const resolver = vi.fn((sid: string | undefined) => leaseOwners.get(sid ?? ''))

    await handleBridgeToolExecute(
      { type: 'bridge.tool.execute', toolName: 'my-tool', parameters: {}, sessionId: 'sessionX' },
      registry, host, rpcServer, resolver,
    )
    await handleBridgeToolExecute(
      { type: 'bridge.tool.execute', toolName: 'my-tool', parameters: {}, sessionId: 'sessionY' },
      registry, host, rpcServer, resolver,
    )

    const params1 = invoke.mock.calls[0][2] as Record<string, unknown>
    const params2 = invoke.mock.calls[1][2] as Record<string, unknown>
    expect(params1.clientId).toBe('client-A')
    expect(params2.clientId).toBe('client-B')
  })
})
