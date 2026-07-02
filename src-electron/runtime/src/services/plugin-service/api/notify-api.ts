/**
 * Notify API 模块
 *
 * 提供插件通知（fire-and-forget 广播）的 RPC handler（主线程侧）和 Worker 侧代理对象。
 *
 * 主线程侧：registerNotifyRpcHandler() 在 PluginRpcServer 上注册
 *   plugin.notify 一个 RPC 方法——通过 broadcastFn 广播到前端。
 *
 * Worker 侧：createNotifyApi() 返回 {info/warning/error} 代理对象，通过 RPC
 * 转发到主线程。
 *
 * 此前 handler 内联在 plugin-rpc-setup.ts、Worker 侧代理内联在 plugin-bootstrap.ts。
 * P6 收口到本 api 文件，与其它 6 个域保持一致。
 */

import type { PluginRpcServer } from '../plugin-rpc-server.js'
import type { PluginRpcClient } from '../plugin-rpc-client.js'

/** Notify 服务依赖（主线程侧） */
export interface NotifyHandlers {
  /**
   * 广播一条插件通知。fire-and-forget。
   * @param pluginId 插件 ID
   * @param level   级别（info/warning/error）
   * @param message 消息文本
   */
  notify(pluginId: string, level: string, message: string): void
}

/**
 * 在 PluginRpcServer 上注册 plugin.notify RPC handler。
 *
 * Notify 是 fire-and-forget：直接通过 broadcastFn 广播。无 broadcastFn 时打印警告
 * 并丢弃（保持原行为）。
 */
export function registerNotifyRpcHandler(
  rpcServer: PluginRpcServer,
  deps: NotifyHandlers,
): void {
  rpcServer.registerMethod('plugin.notify', async (params) => {
    deps.notify(
      params.pluginId as string,
      params.level as string,
      params.message as string,
    )
  })
}

/**
 * 由 broadcastFn 构造主线程侧 NotifyHandlers。无 broadcastFn 时警告并丢弃。
 */
export function notifyHandlersFrom(
  broadcastFn?: (type: string, payload: unknown) => void,
): NotifyHandlers {
  return {
    notify: (pluginId, level, message) => {
      if (broadcastFn) {
        broadcastFn('plugin:notification', { pluginId, level, message })
      } else {
        console.warn('[plugin-notify-api] plugin.notify dropped: no broadcastFn configured')
      }
    },
  }
}

/**
 * 创建 Worker 侧 notify 代理对象。
 *
 * Worker 侧 Phase2AgentAPI.notify 签名为 {info/warning/error}(message)，
 * 通过 RPC 转发 plugin.notify 到主线程。
 */
export function createNotifyApi(
  rpcClient: PluginRpcClient,
  pluginId: string,
): {
  info(message: string): Promise<void>
  warning(message: string): Promise<void>
  error(message: string): Promise<void>
} {
  return {
    info: (msg: string) =>
      rpcClient.request('plugin.notify', { pluginId, level: 'info', message: msg }).then(() => {}),
    warning: (msg: string) =>
      rpcClient.request('plugin.notify', { pluginId, level: 'warning', message: msg }).then(() => {}),
    error: (msg: string) =>
      rpcClient.request('plugin.notify', { pluginId, level: 'error', message: msg }).then(() => {}),
  }
}
