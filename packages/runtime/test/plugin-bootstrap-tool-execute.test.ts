/**
 * Worker 端 tool execute / hook invoke RPC handler 测试
 *
 * plugin-bootstrap.ts 无法在 Vitest 中直接 import（Worker Thread 顶层副作用
 * 导致 Vite transform 后 exports 丢失）。因此采用独立单元测试策略：
 * 复制核心逻辑（handleIncomingRequest + toolHandlers Map）到此测试文件中验证。
 * plugin.hooks.invoke 分支（D2-1）调用真实的 executeHookRequest（hook-api.ts
 * 无顶层副作用，可直接 import），验证 bootstrap 分支 ↔ 模块级胶水桥接。
 *
 * 集成验证依赖：
 * - 类型检查 (vue-tsc) 确保 plugin-bootstrap.ts 的签名正确
 * - 全量运行时测试覆盖 Worker ↔ 主线程的完整链路
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolExecuteHandler } from '../src/services/plugin-service/plugin-types.js'
import { PluginRpcErrorCodes } from '../src/services/plugin-service/plugin-types.js'
import { executeHookRequest, createHookApi } from '../src/services/plugin-service/hook-api.js'
import type { PluginRpcClient } from '../src/services/plugin-service/plugin-rpc-client.js'

// --- 复制自 plugin-bootstrap.ts 的核心逻辑 ---
// 保持同步。如果 plugin-bootstrap.ts 中的逻辑变更，此测试也需要更新。

const toolHandlers = new Map<string, ToolExecuteHandler>()

function registerToolHandler(toolKey: string, handler: ToolExecuteHandler): void {
  toolHandlers.set(toolKey, handler)
}

interface RpcRequest {
  jsonrpc: '2.0'
  id: number | string | null
  method: string
  params?: unknown
}

interface RpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: { code: number; message: string }
}

const postedMessages: Array<{ type: string; response: RpcResponse }> = []

function postRpcResponse(
  id: number | string | null,
  result: unknown,
  error: { code: number; message: string } | undefined,
): void {
  if (id === null) return
  const response: RpcResponse = { jsonrpc: '2.0', id: id as number }
  if (error) {
    response.error = error
  } else {
    response.result = result
  }
  postedMessages.push({ type: 'rpc', response })
}

async function handleIncomingRequest(request: RpcRequest): Promise<void> {
  if (request.method === 'plugin.tool.execute') {
    const { pluginId, toolName, arguments: args, sessionId, toolCallId } = request.params as Record<string, unknown>
    const toolKey = `${pluginId}:${toolName}`
    const handler = toolHandlers.get(toolKey)
    if (!handler) {
      postRpcResponse(request.id, undefined, {
        code: PluginRpcErrorCodes.METHOD_NOT_FOUND,
        message: `Tool handler not found: ${toolKey}`,
      })
      return
    }
    try {
      const result = await handler({
        arguments: args as Record<string, unknown>,
        sessionId: sessionId as string | undefined,
        toolCallId: toolCallId as string | undefined,
      })
      postRpcResponse(request.id, result, undefined)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      postRpcResponse(request.id, undefined, {
        code: PluginRpcErrorCodes.INTERNAL_ERROR,
        message: `Tool execution error: ${msg}`,
      })
    }
  } else if (request.method === 'plugin.hooks.invoke') {
    // D2-1 request 直连：查 hook handler Map → 调 handler → 结果作为 RPC 响应原样回传。
    // handler 抛错 → 回 {proceed:true}（异常放行语义，与主线程超时/异常放行一致）。
    try {
      const result = await executeHookRequest(request.params)
      postRpcResponse(request.id, result, undefined)
    } catch {
      postRpcResponse(request.id, { proceed: true }, undefined)
    }
  } else {
    postRpcResponse(request.id, undefined, {
      code: PluginRpcErrorCodes.METHOD_NOT_FOUND,
      message: `Unknown method: ${request.method}`,
    })
  }
}
// --- 核心逻辑结束 ---

/** 最小 mock PluginRpcClient（createHookApi 注册 hook 时需要） */
function createMockRpcClient(): PluginRpcClient {
  const requestCalls: Array<{ method: string; params: Record<string, unknown> }> = []
  return {
    request: (method: string, params: Record<string, unknown>) => {
      requestCalls.push({ method, params })
      return Promise.resolve(undefined)
    },
    onNotification: () => () => {},
    notify: () => {},
    attach: () => {},
    requestCalls,
  } as unknown as PluginRpcClient
}

/** 经 createHookApi 注册一个 onBeforeSendMessage 拦截器，返回其 handlerId */
async function registerTestInterceptor(
  handler: (ctx: unknown) => Promise<{ proceed: boolean; reason?: string; modifiedData?: unknown }>,
): Promise<string> {
  const mockClient = createMockRpcClient()
  const hookApi = createHookApi(mockClient, 'bootstrap-test-plugin')
  await hookApi.onBeforeSendMessage(handler)
  const registerCall = (mockClient as unknown as { requestCalls: Array<{ method: string; params: Record<string, unknown> }> })
    .requestCalls.find(c => c.method === 'plugin.hooks.register')
  return registerCall!.params.handlerId as string
}

describe('plugin-bootstrap tool execute RPC handler', () => {
  beforeEach(() => {
    toolHandlers.clear()
    postedMessages.length = 0
  })

  it('executes registered handler and returns result', async () => {
    const handler: ToolExecuteHandler = vi.fn().mockResolvedValue({ content: 'ok' })
    registerToolHandler('p:t', handler)

    await handleIncomingRequest({
      jsonrpc: '2.0',
      id: 42,
      method: 'plugin.tool.execute',
      params: { pluginId: 'p', toolName: 't', arguments: { x: 1 } },
    })

    expect(handler).toHaveBeenCalledWith({
      arguments: { x: 1 },
      sessionId: undefined,
      toolCallId: undefined,
    })
    expect(postedMessages).toEqual([
      { type: 'rpc', response: { jsonrpc: '2.0', id: 42, result: { content: 'ok' } } },
    ])
  })

  it('returns error when handler not found', async () => {
    await handleIncomingRequest({
      jsonrpc: '2.0',
      id: 43,
      method: 'plugin.tool.execute',
      params: { pluginId: 'x', toolName: 'missing', arguments: {} },
    })

    expect(postedMessages).toEqual([
      {
        type: 'rpc',
        response: {
          jsonrpc: '2.0',
          id: 43,
          error: {
            code: PluginRpcErrorCodes.METHOD_NOT_FOUND,
            message: 'Tool handler not found: x:missing',
          },
        },
      },
    ])
  })

  it('returns error when handler throws', async () => {
    const handler: ToolExecuteHandler = vi.fn().mockRejectedValue(new Error('boom'))
    registerToolHandler('e:f', handler)

    await handleIncomingRequest({
      jsonrpc: '2.0',
      id: 44,
      method: 'plugin.tool.execute',
      params: { pluginId: 'e', toolName: 'f', arguments: {} },
    })

    expect(postedMessages).toEqual([
      {
        type: 'rpc',
        response: {
          jsonrpc: '2.0',
          id: 44,
          error: {
            code: PluginRpcErrorCodes.INTERNAL_ERROR,
            message: 'Tool execution error: boom',
          },
        },
      },
    ])
  })

  it('returns error for unknown method', async () => {
    await handleIncomingRequest({
      jsonrpc: '2.0',
      id: 45,
      method: 'unknown.method',
      params: {},
    })

    expect(postedMessages).toEqual([
      {
        type: 'rpc',
        response: {
          jsonrpc: '2.0',
          id: 45,
          error: {
            code: PluginRpcErrorCodes.METHOD_NOT_FOUND,
            message: 'Unknown method: unknown.method',
          },
        },
      },
    ])
  })
})

describe('plugin-bootstrap plugin.hooks.invoke request branch (D2-1)', () => {
  beforeEach(() => {
    postedMessages.length = 0
  })

  it('responds with InterceptorResult when handler blocks', async () => {
    const handlerId = await registerTestInterceptor(async () => ({
      proceed: false,
      reason: 'API key detected',
    }))

    await handleIncomingRequest({
      jsonrpc: '2.0',
      id: 51,
      method: 'plugin.hooks.invoke',
      params: { handlerId, hookType: 'onBeforeSendMessage', context: { data: 'x' } },
    })

    expect(postedMessages).toEqual([
      {
        type: 'rpc',
        response: {
          jsonrpc: '2.0',
          id: 51,
          result: { proceed: false, reason: 'API key detected' },
        },
      },
    ])
  })

  it('responds with modifiedData when handler transforms', async () => {
    const handlerId = await registerTestInterceptor(async () => ({
      proceed: true,
      modifiedData: { content: 'IMPORTANT' },
    }))

    await handleIncomingRequest({
      jsonrpc: '2.0',
      id: 52,
      method: 'plugin.hooks.invoke',
      params: { handlerId, hookType: 'onBeforeSendMessage', context: { data: { content: '!important' } } },
    })

    expect(postedMessages).toEqual([
      {
        type: 'rpc',
        response: {
          jsonrpc: '2.0',
          id: 52,
          result: { proceed: true, modifiedData: { content: 'IMPORTANT' } },
        },
      },
    ])
  })

  it('responds with {proceed:true} when handler throws (异常放行)', async () => {
    const handlerId = await registerTestInterceptor(async () => {
      throw new Error('handler boom')
    })

    await handleIncomingRequest({
      jsonrpc: '2.0',
      id: 53,
      method: 'plugin.hooks.invoke',
      params: { handlerId, hookType: 'onBeforeSendMessage', context: {} },
    })

    expect(postedMessages).toEqual([
      {
        type: 'rpc',
        response: {
          jsonrpc: '2.0',
          id: 53,
          result: { proceed: true },
        },
      },
    ])
  })

  it('responds with {proceed:true} for unknown handlerId', async () => {
    await handleIncomingRequest({
      jsonrpc: '2.0',
      id: 54,
      method: 'plugin.hooks.invoke',
      params: { handlerId: 'hook_missing_0', hookType: 'onBeforeSendMessage', context: {} },
    })

    expect(postedMessages).toEqual([
      {
        type: 'rpc',
        response: {
          jsonrpc: '2.0',
          id: 54,
          result: { proceed: true },
        },
      },
    ])
  })
})
