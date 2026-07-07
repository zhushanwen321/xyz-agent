/**
 * Tool Execution via RPC — TDD tests for BG1 Task 1
 *
 * Tests the full tool execution path:
 *   PluginService.handleBridgeToolExecute
 *     → toolRegistry.find → PluginHost.getWorkerHandle
 *     → PluginRpcServer.invoke(workerId, 'plugin.tool.execute', params, 30_000)
 *     → BridgeToolExecuteResponse
 *
 * Also tests PluginRpcServer.invoke() directly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PluginService } from '../src/services/plugin-service/plugin-service.js'
import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'
import type { IMessageBroker } from '../src/interfaces.js'
import type { ToolEntry, BridgeToolExecuteRequest } from '../src/services/plugin-service/plugin-types.js'

// ── Helpers ────────────────────────────────────────────────────

function createMockBroker(): IMessageBroker {
  return {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
  }
}

/** Access PluginService internals for test setup */
function internals(service: PluginService) {
  return service as unknown as {
    toolRegistry: Map<string, ToolEntry>
    rpcServer: PluginRpcServer
    host: {
      getWorkerHandle(pluginId: string): { workerId: string; postMessage(message: unknown): void } | undefined
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// PluginRpcServer.invoke
// ══════════════════════════════════════════════════════════════════

describe('PluginRpcServer.invoke', () => {
  let rpcServer: PluginRpcServer

  beforeEach(() => {
    rpcServer = new PluginRpcServer()
  })

  it('sends RPC request and resolves on response', async () => {
    // Mock a worker port that captures messages
    const sentMessages: unknown[] = []
    const mockPort = { postMessage: (msg: unknown) => { sentMessages.push(msg) } }
    rpcServer.registerWorker('worker-1', mockPort)

    // Invoke in background
    const invokePromise = rpcServer.invoke('worker-1', 'plugin.tool.execute', { toolName: 'hello' }, 5_000)

    // Should have sent a request message
    expect(sentMessages).toHaveLength(1)
    const sent = sentMessages[0] as { type: string; request: Record<string, unknown> }
    expect(sent.type).toBe('rpc')
    expect(sent.request.method).toBe('plugin.tool.execute')
    expect(sent.request.params).toEqual({ toolName: 'hello' })
    expect(typeof sent.request.id).toBe('number')

    // Simulate response from worker
    const requestId = sent.request.id as number
    rpcServer.handleResponse({ jsonrpc: '2.0', id: requestId, result: { content: 'Hello!', isError: false } })

    const result = await invokePromise
    expect(result).toEqual({ content: 'Hello!', isError: false })
  })

  it('rejects on timeout', async () => {
    vi.useFakeTimers()

    const mockPort = { postMessage: vi.fn() }
    rpcServer.registerWorker('worker-1', mockPort)

    const invokePromise = rpcServer.invoke('worker-1', 'plugin.tool.execute', {}, 5_000)

    // Advance past timeout
    vi.advanceTimersByTime(5_100)

    await expect(invokePromise).rejects.toThrow('RPC timeout')

    vi.useRealTimers()
  })

  it('rejects with error response from worker', async () => {
    const sentMessages: unknown[] = []
    const mockPort = { postMessage: (msg: unknown) => { sentMessages.push(msg) } }
    rpcServer.registerWorker('worker-1', mockPort)

    const invokePromise = rpcServer.invoke('worker-1', 'test.method', {}, 5_000)

    const sent = sentMessages[0] as { request: Record<string, unknown> }
    const requestId = sent.request.id as number

    // Simulate error response
    rpcServer.handleResponse({
      jsonrpc: '2.0',
      id: requestId,
      error: { code: -32603, message: 'Internal error' },
    })

    await expect(invokePromise).rejects.toThrow('Internal error')
  })

  it('throws for unknown worker', async () => {
    await expect(
      rpcServer.invoke('unknown-worker', 'test.method', {}, 5_000),
    ).rejects.toThrow('Worker not found')
  })
})

// ══════════════════════════════════════════════════════════════════
// PluginService.handleBridgeToolExecute
// ══════════════════════════════════════════════════════════════════

describe('PluginService.handleBridgeToolExecute (BG1 T1)', () => {
  // ── Happy path: tool found, worker executes, result returned ──
  it('routes tool execution to worker and returns result', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    // Setup: tool registered
    reg.toolRegistry.set('p1:hello', {
      pluginId: 'p1',
      handlerId: 'p1:hello',
      schema: { name: 'hello', description: 'Says hello', parameters: {} },
    })

    // Setup: mock host.getWorkerHandle
    const mockHandle = {
      workerId: 'worker-1',
      postMessage: vi.fn(),
    }
    reg.host.getWorkerHandle = vi.fn().mockReturnValue(mockHandle)

    // Setup: mock rpcServer.invoke
    reg.rpcServer.invoke = vi.fn().mockResolvedValue({
      content: 'Hello, World!',
      isError: false,
    })

    const request: BridgeToolExecuteRequest = {
      type: 'bridge.tool.execute',
      toolName: 'hello',
      parameters: { name: 'World' },
    }
    const result = await service.handleBridgeToolExecute(request)

    expect(result).toEqual({ content: 'Hello, World!', isError: false })
    expect(reg.host.getWorkerHandle).toHaveBeenCalledWith('p1')
    expect(reg.rpcServer.invoke).toHaveBeenCalledWith(
      'worker-1',
      'plugin.tool.execute',
      expect.objectContaining({
        pluginId: 'p1',
        toolName: 'hello',
        arguments: { name: 'World' },
      }),
      30_000,
    )
  })

  // ── Tool not found → error ──
  it('returns error when tool not found', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)

    const request: BridgeToolExecuteRequest = {
      type: 'bridge.tool.execute',
      toolName: 'nonexistent',
      parameters: {},
    }
    const result = await service.handleBridgeToolExecute(request)

    expect(result).toEqual({
      content: 'Tool not found: nonexistent',
      isError: true,
    })
  })

  // ── Worker crashed → error ──
  it('returns error when worker handle not found (crashed)', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.toolRegistry.set('p1:hello', {
      pluginId: 'p1',
      handlerId: 'p1:hello',
      schema: { name: 'hello', description: '', parameters: {} },
    })

    // Worker handle not found
    reg.host.getWorkerHandle = vi.fn().mockReturnValue(undefined)

    const request: BridgeToolExecuteRequest = {
      type: 'bridge.tool.execute',
      toolName: 'hello',
      parameters: {},
    }
    const result = await service.handleBridgeToolExecute(request)

    expect(result).toEqual({
      content: 'Plugin worker crashed',
      isError: true,
    })
  })

  // ── RPC timeout → error ──
  it('returns error on RPC timeout', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.toolRegistry.set('p1:hello', {
      pluginId: 'p1',
      handlerId: 'p1:hello',
      schema: { name: 'hello', description: '', parameters: {} },
    })

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    // Simulate timeout
    const timeoutError = new Error('RPC timeout')
    reg.rpcServer.invoke = vi.fn().mockRejectedValue(timeoutError)

    const request: BridgeToolExecuteRequest = {
      type: 'bridge.tool.execute',
      toolName: 'hello',
      parameters: {},
    }
    const result = await service.handleBridgeToolExecute(request)

    expect(result).toEqual({
      content: 'Plugin tool execution timed out',
      isError: true,
    })
  })

  // ── Worker execution error → error ──
  it('returns error on worker execution failure', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.toolRegistry.set('p1:hello', {
      pluginId: 'p1',
      handlerId: 'p1:hello',
      schema: { name: 'hello', description: '', parameters: {} },
    })

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    const execError = new Error('Something went wrong in plugin')
    reg.rpcServer.invoke = vi.fn().mockRejectedValue(execError)

    const request: BridgeToolExecuteRequest = {
      type: 'bridge.tool.execute',
      toolName: 'hello',
      parameters: {},
    }
    const result = await service.handleBridgeToolExecute(request)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('Plugin tool execution failed')
    expect(result.content).toContain('Something went wrong in plugin')
  })

  // ── Worker returns error result → forwarded as-is ──
  it('forwards worker error result as-is', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.toolRegistry.set('p1:hello', {
      pluginId: 'p1',
      handlerId: 'p1:hello',
      schema: { name: 'hello', description: '', parameters: {} },
    })

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    reg.rpcServer.invoke = vi.fn().mockResolvedValue({
      content: 'something went wrong',
      isError: true,
    })

    const request: BridgeToolExecuteRequest = {
      type: 'bridge.tool.execute',
      toolName: 'hello',
      parameters: {},
    }
    const result = await service.handleBridgeToolExecute(request)

    expect(result).toEqual({
      content: 'something went wrong',
      isError: true,
    })
  })

  // ── Passes sessionId and toolCallId through to RPC params ──
  it('passes sessionId and toolCallId in RPC params', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.toolRegistry.set('p1:hello', {
      pluginId: 'p1',
      handlerId: 'p1:hello',
      schema: { name: 'hello', description: '', parameters: {} },
    })

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    reg.rpcServer.invoke = vi.fn().mockResolvedValue({
      content: 'ok',
      isError: false,
    })

    const request: BridgeToolExecuteRequest = {
      type: 'bridge.tool.execute',
      toolName: 'hello',
      parameters: { name: 'test' },
      sessionId: 'session-123',
      toolCallId: 'call-456',
    }
    await service.handleBridgeToolExecute(request)

    expect(reg.rpcServer.invoke).toHaveBeenCalledWith(
      'worker-1',
      'plugin.tool.execute',
      expect.objectContaining({
        sessionId: 'session-123',
        toolCallId: 'call-456',
      }),
      30_000,
    )
  })
})
