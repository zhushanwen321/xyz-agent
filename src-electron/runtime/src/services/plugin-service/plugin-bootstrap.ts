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
} from './plugin-types.js'
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

const rpcClient = new PluginRpcClient()
const loadedModules = new Map<string, PluginModule>()

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

async function handleMessage(msg: HostToWorkerMessage): Promise<void> {
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
      break
    }
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
      global: createStateStorageProxy(pluginId, 'global'),
      workspace: createStateStorageProxy(pluginId, 'workspace'),
    },
    notify: {
      info: (msg: string) =>
        rpcClient.request('plugin.notify', { pluginId, level: 'info', message: msg }).then(() => {}),
      warning: (msg: string) =>
        rpcClient.request('plugin.notify', { pluginId, level: 'warning', message: msg }).then(() => {}),
      error: (msg: string) =>
        rpcClient.request('plugin.notify', { pluginId, level: 'error', message: msg }).then(() => {}),
    },
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
 * 创建 PluginStateStorage 的 RPC proxy。
 *
 * 所有 storage 操作通过 RPC 转发到主线程的 PluginStorage 执行，
 * Worker 本身不直接读写文件系统。
 *
 * get 方法需要兼容 PluginStateStorage 的两个重载签名：
 *   get<T>(key: string): Promise<T | undefined>
 *   get<T>(key: string, defaultValue: T): Promise<T>
 */
function createStateStorageProxy(
  pluginId: string,
  scope: string,
): PluginStateStorage {
  return {
    get: <T,>(key: string, defaultValue?: T): Promise<T | undefined> =>
      rpcClient
        .request(`plugin.storage.${scope}.get`, { pluginId, key })
        .then(v => (v as T | undefined) ?? defaultValue),

    set: (key: string, value: unknown): Promise<void> =>
      rpcClient.request(`plugin.storage.${scope}.set`, { pluginId, key, value }).then(() => {}),

    delete: (key: string): Promise<void> =>
      rpcClient.request(`plugin.storage.${scope}.delete`, { pluginId, key }).then(() => {}),

    keys: (): Promise<string[]> =>
      rpcClient
        .request(`plugin.storage.${scope}.keys`, { pluginId })
        .then(v => (v as string[]) ?? []),
  }
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
