/**
 * Worker Thread 入口脚本
 *
 * 在独立 Worker Thread 中运行，负责：
 * 1. 动态 import 插件模块（load）
 * 2. 调用插件的 activate / deactivate 生命周期
 * 3. 通过 PluginRpcClient 转发插件 RPC 请求到主线程
 *
 * 通信协议：通过 parentPort 收发 HostToWorkerMessage / WorkerToHostMessage
 */

import { parentPort } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'
import type {
  HostToWorkerMessage,
  PluginModule,
  PluginContext,
  Phase2AgentAPI,
  PluginStateStorage,
  Disposable,
  RpcRequest,
  ToolExecuteHandler,
} from './plugin-types.js'
import { PluginRpcErrorCodes } from './plugin-types.js'
import { PluginRpcClient } from './plugin-rpc-client.js'
import { createRequireInterceptor, createEnvProxy } from './plugin-sandbox.js'
import { createToolApi } from './tool-api.js'
import { createHookApi } from './hook-api.js'
import { createSessionApi } from './api/session-api.js'
import { createConfigApi } from './api/config-api.js'
import { createSessionDataApi } from './api/session-data-api.js'
import { createUiApi } from './api/ui-api.js'
import { createAgentApi } from './api/agent-api.js'
import { createWorkspaceApi } from './api/workspace-api.js'
import { createStorageApi } from './api/storage-api.js'
import { createNotifyApi } from './api/notify-api.js'
import { toErrorMessage } from '../../utils/errors.js'

const rpcClient = new PluginRpcClient()
const loadedModules = new Map<string, PluginModule>()

/** Worker 本地 tool handler 注册表 */
const toolHandlers = new Map<string, ToolExecuteHandler>()

/** 注册 tool handler（由 tool-api.ts 调用） */
export function registerToolHandler(toolKey: string, handler: ToolExecuteHandler): void {
  toolHandlers.set(toolKey, handler)
}

/** 注销 tool handler（由 tool-api.ts 调用） */
export function unregisterToolHandler(toolKey: string): void {
  toolHandlers.delete(toolKey)
}

if (parentPort) {
  rpcClient.attach(parentPort)

  parentPort.on('message', (msg: HostToWorkerMessage) => {
    handleMessage(msg).catch((e: unknown) => {
      parentPort!.postMessage({
        type: 'fatal_error',
        error: String(e),
        stack: e instanceof Error ? e.stack : undefined,
      })
    })
  })
}

export async function handleMessage(msg: HostToWorkerMessage): Promise<void> {
  switch (msg.type) {
    case 'load': {
      try {
        // sandbox 模式下初始化 require 拦截
        if (msg.trustLevel === 'sandbox') {
          initSandbox(msg.pluginPath)
        }

        const moduleUrl = pathToFileURL(msg.pluginPath).href
        const mod = (await import(moduleUrl)) as PluginModule
        loadedModules.set(msg.pluginId, mod)
        parentPort!.postMessage({ type: 'loaded', pluginId: msg.pluginId })
      } catch (e: unknown) {
        parentPort!.postMessage({ type: 'error', pluginId: msg.pluginId, error: String(e) })
      }
      break
    }

    case 'activate': {
      const mod = loadedModules.get(msg.pluginId)
      if (!mod) {
        parentPort!.postMessage({ type: 'error', pluginId: msg.pluginId, error: 'Module not loaded' })
        break
      }
      try {
        const context = createPluginContext(msg.pluginId, msg.pluginDir)
        await mod.activate(context)
        parentPort!.postMessage({ type: 'activated', pluginId: msg.pluginId })
      } catch (e: unknown) {
        parentPort!.postMessage({ type: 'error', pluginId: msg.pluginId, error: String(e) })
      }
      break
    }

    case 'deactivate': {
      const mod = loadedModules.get(msg.pluginId)
      if (mod?.deactivate) {
        try {
          await mod.deactivate()
        } catch (e: unknown) {
          // deactivate 失败时发送 error 而非 deactivated
          parentPort!.postMessage({ type: 'error', pluginId: msg.pluginId, error: String(e) })
          break
        }
      }
      parentPort!.postMessage({ type: 'deactivated', pluginId: msg.pluginId })
      break
    }

    case 'rpc': {
      if (msg.response) {
        rpcClient.handleResponse(msg.response)
      }
      if (msg.notification) {
        rpcClient.handleNotification(msg.notification)
      }
      if (msg.request) {
        handleIncomingRequest(msg.request)
      }
      break
    }
  }
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
      const msg = toErrorMessage(e)
      postRpcResponse(request.id, undefined, {
        code: PluginRpcErrorCodes.INTERNAL_ERROR,
        message: `Tool execution error: ${msg}`,
      })
    }
  } else {
    postRpcResponse(request.id, undefined, {
      code: PluginRpcErrorCodes.METHOD_NOT_FOUND,
      message: `Unknown method: ${request.method}`,
    })
  }
}

function postRpcResponse(
  id: number | string | null,
  result: unknown,
  error: { code: number; message: string } | undefined,
): void {
  if (id === null) return
  // JSON-RPC id: 项目内约定为 number，RpcResponse.id 类型为 number
  const numericId = typeof id === 'number' ? id : Number(id)
  if (error) {
    parentPort!.postMessage({
      type: 'rpc',
      response: { jsonrpc: '2.0', id: numericId, error },
    })
  } else {
    parentPort!.postMessage({
      type: 'rpc',
      response: { jsonrpc: '2.0', id: numericId, result },
    })
  }
}

function createPluginContext(pluginId: string, pluginDir: string): PluginContext {
  const subscriptions: Disposable[] = []
  const api = createAgentAPI(pluginId)
  return {
    pluginId,
    pluginPath: pluginDir,
    globalState: createStateStorageProxy(pluginId, 'global'),
    workspaceState: createStateStorageProxy(pluginId, 'workspace'),
    api,
    subscriptions,
  }
}

function createAgentAPI(pluginId: string): Phase2AgentAPI {
  return {
    storage: {
      global: createStorageApi(rpcClient, pluginId, 'global'),
      workspace: createStorageApi(rpcClient, pluginId, 'workspace'),
    },
    notify: createNotifyApi(rpcClient, pluginId),
    sessions: createSessionApi(rpcClient, pluginId),
    events: {
      on: (event: string, handler: (data: unknown) => void): Disposable => {
        const unsubscribe = rpcClient.onNotification(`plugin.event.${event}`, handler)
        return { dispose: unsubscribe }
      },
      emit: (event: string, data: unknown): void => {
        rpcClient.notify(`plugin.event.${event}`, { pluginId, data })
      },
    },
    tools: createToolApi(rpcClient, pluginId),
    hooks: createHookApi(rpcClient, pluginId),
    config: createConfigApi(rpcClient, pluginId),
    sessionData: createSessionDataApi(rpcClient, pluginId),
    ui: createUiApi(rpcClient, pluginId),
    agent: createAgentApi(rpcClient, pluginId),
    workspace: createWorkspaceApi(rpcClient, pluginId),
  }
}

/**
 * 创建 PluginStateStorage 的 RPC proxy（PluginContext.globalState/workspaceState 用）。
 *
 * P6 后委托给 api/storage-api.ts 的 createStorageApi——storage proxy 实现单一真相源。
 * scope 仅可为 'global' | 'workspace'（调用方保证）。
 */
function createStateStorageProxy(
  pluginId: string,
  scope: 'global' | 'workspace',
): PluginStateStorage {
  return createStorageApi(rpcClient, pluginId, scope)
}

/**
 * 初始化 sandbox 环境：拦截 require 调用和替换 process.env。
 *
 * 在 Worker Thread 的 load 阶段调用，确保后续插件代码的 require
 * 受到 BLOCKED_BUILTINS 和路径边界约束。
 */
function initSandbox(pluginDir: string): void {
  // Worker Thread 中可用 require()，此处是同步操作
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Module = require('node:module')
  const interceptor = createRequireInterceptor(pluginDir)

  const _originalResolveFilename = Module._resolveFilename
  Module._resolveFilename = function (
    request: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Module._resolveFilename has variadic args
    ...args: any[]
  ): string {
    const resolved = _originalResolveFilename.call(this, request, ...args) as string
    interceptor(request, resolved)
    return resolved
  }

  // 替换 process.env 为空 Proxy
  process.env = createEnvProxy()
}
