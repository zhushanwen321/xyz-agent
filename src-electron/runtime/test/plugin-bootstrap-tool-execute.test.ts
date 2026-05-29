/**
 * Worker 端 tool execute RPC handler 测试
 *
 * 验证 plugin-bootstrap.ts 的 handleMessage 对 'plugin.tool.execute'
 * RPC request 的处理：
 * - 执行已注册 handler → 返回结果
 * - handler 未注册 → METHOD_NOT_FOUND
 * - handler 抛出异常 → INTERNAL_ERROR
 * - 未知 method → METHOD_NOT_FOUND
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolExecuteHandler, HostToWorkerMessage } from '../src/services/plugin-service/plugin-types.js'
import { PluginRpcErrorCodes } from '../src/services/plugin-service/plugin-types.js'

// vi.hoisted: factories are executed BEFORE vi.mock is evaluated (vitest v4 hoisting)
const { mockPostMessage, mockRpcClientFactory } = vi.hoisted(() => {
  function createRpcClient() {
    return {
      attach: vi.fn(),
      request: vi.fn(),
      onNotification: vi.fn(),
      handleResponse: vi.fn(),
      handleNotification: vi.fn(),
      notify: vi.fn(),
    }
  }
  return {
    mockPostMessage: vi.fn(),
    mockRpcClientFactory: createRpcClient,
  }
})

vi.mock('node:worker_threads', () => ({
  parentPort: { on: vi.fn(), postMessage: mockPostMessage },
}))

vi.mock('../src/services/plugin-service/plugin-rpc-client.js', () => ({
  PluginRpcClient: vi.fn().mockImplementation(mockRpcClientFactory),
}))

describe('plugin-bootstrap tool execute RPC handler', () => {
  let handleMessage: (msg: HostToWorkerMessage) => Promise<void>
  let registerToolHandler: (key: string, handler: ToolExecuteHandler) => void

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../src/services/plugin-service/plugin-bootstrap.js')
    handleMessage = mod.handleMessage
    registerToolHandler = mod.registerToolHandler
  })

  it('executes registered handler and returns result', async () => {
    const handler: ToolExecuteHandler = vi.fn().mockResolvedValue({ content: 'ok' })
    registerToolHandler('p:t', handler)
    await handleMessage({
      type: 'rpc',
      request: {
        jsonrpc: '2.0',
        id: 42,
        method: 'plugin.tool.execute',
        params: { pluginId: 'p', toolName: 't', arguments: { x: 1 } },
      },
    })
    expect(handler).toHaveBeenCalledWith({
      arguments: { x: 1 },
      sessionId: undefined,
      toolCallId: undefined,
    })
    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'rpc',
      response: { jsonrpc: '2.0', id: 42, result: { content: 'ok' } },
    })
  })

  it('returns error when handler not found', async () => {
    await handleMessage({
      type: 'rpc',
      request: {
        jsonrpc: '2.0',
        id: 43,
        method: 'plugin.tool.execute',
        params: { pluginId: 'x', toolName: 'missing', arguments: {} },
      },
    })
    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'rpc',
      response: {
        jsonrpc: '2.0',
        id: 43,
        error: {
          code: PluginRpcErrorCodes.METHOD_NOT_FOUND,
          message: 'Tool handler not found: x:missing',
        },
      },
    })
  })

  it('returns error when handler throws', async () => {
    const handler: ToolExecuteHandler = vi.fn().mockRejectedValue(new Error('boom'))
    registerToolHandler('e:f', handler)
    await handleMessage({
      type: 'rpc',
      request: {
        jsonrpc: '2.0',
        id: 44,
        method: 'plugin.tool.execute',
        params: { pluginId: 'e', toolName: 'f', arguments: {} },
      },
    })
    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'rpc',
      response: {
        jsonrpc: '2.0',
        id: 44,
        error: {
          code: PluginRpcErrorCodes.INTERNAL_ERROR,
          message: 'Tool execution error: boom',
        },
      },
    })
  })

  it('returns error for unknown method', async () => {
    await handleMessage({
      type: 'rpc',
      request: {
        jsonrpc: '2.0',
        id: 45,
        method: 'unknown.method',
        params: {},
      },
    })
    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'rpc',
      response: {
        jsonrpc: '2.0',
        id: 45,
        error: {
          code: PluginRpcErrorCodes.METHOD_NOT_FOUND,
          message: 'Unknown method: unknown.method',
        },
      },
    })
  })
})
