/**
 * Hook API 模块
 *
 * 提供 Hook 注册的 RPC handler（主线程侧）和 Worker 侧代理对象。
 *
 * 主线程侧：registerHookRpcHandlers() 在 PluginRpcServer 上注册
 *   plugin.hooks.register / plugin.hooks.unregister 两个 RPC 方法。
 *
 * Worker 侧：createHookApi() 返回代理对象，提供 onBeforeSendMessage
 *   等 5 个方法，每个方法生成 handlerId、保存到本地 map、发 RPC 注册，
 *   并返回 Disposable。
 *
 * Worker 同时监听 `plugin.hooks.invoke` 通知，用于主线程回调 hook handler。
 */

import type { PluginRpcServer } from './plugin-rpc-server.js'
import type { PluginRpcClient } from './plugin-rpc-client.js'
import type {
  HookEntry,
  PluginDescriptor,
  HookInterceptor,
  HookObserver,
  PiEventCallback,
  Disposable,
} from './plugin-types.js'

/** Hook 注册服务依赖（主线程侧） */
export interface HookService {
  /** hook 注册表，key 为 hookType，value 为该类型的所有注册条目 */
  hookRegistry: Map<string, HookEntry[]>
  /** 根据 pluginId 获取插件描述符（用于计算优先级） */
  getDescriptor(pluginId: string): PluginDescriptor | undefined
}

/** Worker 本地存储的 hook handler 包装 */
interface StoredHandler {
  /** 统一签名的调用函数 */
  invoke: (context: unknown) => Promise<unknown>
  /** 原始 handler 引用（用于 dispose 时清理） */
  original: HookInterceptor | HookObserver | PiEventCallback
}

let hookCounter = 0

/**
 * 根据 PluginDescriptor 计算优先级。
 *
 * - built-in 插件: 0（最高优先级）
 * - trusted 外部插件: 100
 * - sandbox 插件: 200（最低优先级）
 */
const PRIORITY_BUILT_IN = 0
const PRIORITY_TRUSTED = 100
const PRIORITY_SANDBOX = 200

function computePriority(descriptor: PluginDescriptor): number {
  if (descriptor.source === 'built-in') return PRIORITY_BUILT_IN
  if (descriptor.trustLevel === 'trusted') return PRIORITY_TRUSTED
  return PRIORITY_SANDBOX
}

/**
 * 在 PluginRpcServer 上注册 hook 相关的 RPC handler。
 *
 * 注册的方法：
 * - `plugin.hooks.register` — 注册 hook handler，按 priority 排序存储
 * - `plugin.hooks.unregister` — 注销 hook handler
 */
export function registerHookRpcHandlers(
  rpcServer: PluginRpcServer,
  service: HookService,
): void {
  rpcServer.registerMethod('plugin.hooks.register', async (params) => {
    const pluginId = params.pluginId as string
    const hookType = params.hookType as string
    const handlerId = params.handlerId as string

    // 获取插件描述符以计算优先级
    const descriptor = service.getDescriptor(pluginId)
    const priority = descriptor ? computePriority(descriptor) : PRIORITY_SANDBOX

    // 存储到 hookRegistry
    let entries = service.hookRegistry.get(hookType)
    if (!entries) {
      entries = []
      service.hookRegistry.set(hookType, entries)
    }
    entries.push({ pluginId, handlerId, priority })

    // 按 priority 排序（低数值先执行）
    entries.sort((a, b) => a.priority - b.priority)

    return { registered: true }
  })

  rpcServer.registerMethod('plugin.hooks.unregister', async (params) => {
    const handlerId = params.handlerId as string
    const hookType = params.hookType as string

    const entries = service.hookRegistry.get(hookType)
    if (entries) {
      const idx = entries.findIndex(e => e.handlerId === handlerId)
      if (idx >= 0) {
        entries.splice(idx, 1)
      }
      if (entries.length === 0) {
        service.hookRegistry.delete(hookType)
      }
    }

    return { unregistered: true }
  })
}

/**
 * 创建 Worker 侧 Hook API 代理对象。
 *
 * 每个 onXxx 方法会：
 * 1. 生成唯一 handlerId
 * 2. 保存 handler 到 Worker 本地 map（handlerId → 包装后的 invoke 函数）
 * 3. 发 RPC 到主线程注册
 * 4. 返回 Disposable（取消注册时发 RPC 并清理本地 map）
 *
 * 同时注册 `plugin.hooks.invoke` 通知处理器：
 * - 收到通知后从本地 map 查找 handler
 * - 调用 handler(context)
 * - 将结果通过 `plugin.hooks.invoke.result` RPC 返回主线程
 */
export function createHookApi(
  rpcClient: PluginRpcClient,
  pluginId: string,
): {
  onBeforeSendMessage(handler: HookInterceptor): Promise<Disposable>
  onBeforeToolCall(handler: HookInterceptor): Promise<Disposable>
  onBeforeAgentStart(handler: HookInterceptor): Promise<Disposable>
  onAfterToolResult(handler: HookObserver): Promise<Disposable>
  onPiEvent(eventName: string, handler: PiEventCallback): Promise<Disposable>
} {
  const handlers = new Map<string, StoredHandler>()

  // 注册 invoke 通知处理器（主线程回调 Worker 中的 hook handler）
  rpcClient.onNotification('plugin.hooks.invoke', (params: unknown) => {
    const p = params as { handlerId: string; context: unknown }
    const stored = handlers.get(p.handlerId)
    if (!stored) return

    Promise.resolve(stored.invoke(p.context))
      .then((result) => {
        rpcClient
          .request('plugin.hooks.invoke.result', {
            handlerId: p.handlerId,
            result,
          })
          .catch((e: unknown) => {
            console.error('[hook-api] hook invoke result delivery failed:', e instanceof Error ? e.message : String(e))
          })
      })
      .catch((e: unknown) => {
        console.error('[hook-api] hook handler error:', e instanceof Error ? e.message : String(e))
      })
  })

  /**
   * 注册一个 hook handler：保存到本地 map + 发 RPC 到主线程。
   * 返回 Disposable 用于取消注册。
   */
  async function registerHook(
    hookType: string,
    handler: HookInterceptor | HookObserver | PiEventCallback,
    invoke: (context: unknown) => Promise<unknown>,
  ): Promise<Disposable> {
    const handlerId = `hook_${pluginId}_${++hookCounter}`
    handlers.set(handlerId, { invoke, original: handler })

    await rpcClient.request('plugin.hooks.register', {
      pluginId,
      hookType,
      handlerId,
    })

    return {
      dispose: () => {
        handlers.delete(handlerId)
        rpcClient
          .request('plugin.hooks.unregister', { pluginId, hookType, handlerId })
          .catch((e: unknown) => {
            console.error('[hook-api] hook unregister failed:', e instanceof Error ? e.message : String(e))
          })
      },
    }
  }

  return {
    /**
     * 注册消息发送前拦截器。可阻止发送或修改消息内容。
     * handler 返回 InterceptorResult（proceed/reason/modifiedData）。
     */
    onBeforeSendMessage: (handler: HookInterceptor) =>
      registerHook('onBeforeSendMessage', handler, async (ctx) => handler(ctx as Parameters<HookInterceptor>[0])),

    /**
     * 注册工具调用前拦截器。可阻止调用或修改参数。
     */
    onBeforeToolCall: (handler: HookInterceptor) =>
      registerHook('onBeforeToolCall', handler, async (ctx) => handler(ctx as Parameters<HookInterceptor>[0])),

    /**
     * 注册 Agent 启动前拦截器。可阻止启动。
     */
    onBeforeAgentStart: (handler: HookInterceptor) =>
      registerHook('onBeforeAgentStart', handler, async (ctx) => handler(ctx as Parameters<HookInterceptor>[0])),

    /**
     * 注册工具结果后观察者。只能读取数据，不能阻止。
     */
    onAfterToolResult: (handler: HookObserver) =>
      registerHook('onAfterToolResult', handler, async (ctx) => {
        await handler(ctx as Parameters<HookObserver>[0])
        return undefined
      }),

    /**
     * 注册 pi 事件观察者。监听指定 eventName 的事件。
     * handler 接收 (eventName, data) 两个参数。
     */
    onPiEvent: (eventName: string, handler: PiEventCallback) =>
      registerHook(
        `onPiEvent:${eventName}`,
        handler,
        async (ctx) => {
          const data = ctx as { eventName: string; data: unknown }
          await handler(data.eventName ?? eventName, data.data)
          return undefined
        },
      ),
  }
}
