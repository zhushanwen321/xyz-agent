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
 *
 * 单一广播真相源：broadcastPluginNotification() 封装"组装 plugin:notification
 * payload + 调用 broadcastFn"，plugin.notify 与 plugin.ui.notify 两个 RPC 入口共用。
 * 无 broadcastFn 时返回 false，由调用方各自打印 warn 文案（两入口的原始文案不同，
 * 因此 warn 不进核心函数——去重的是"广播逻辑"，可观测文案各自保留，行为逐字不变）。
 */

import type { PluginRpcServer } from '../plugin-rpc-server.js'
import type { PluginRpcClient } from '../plugin-rpc-client.js'

/** broadcastFn 类型：Server→Client 推送（[HISTORICAL] 冒号 + camelCase 命名约定） */
export type PluginBroadcastFn = (type: string, payload: unknown) => void

/**
 * 单一来源的插件通知广播。fire-and-forget。
 *
 * 行为契约（不可变）：
 *   - 有 broadcastFn：调用 `broadcastFn('plugin:notification', { pluginId, level, message })`，返回 true
 *   - 无 broadcastFn：返回 false（不在此处 warn，由调用方按各自原始文案打印）
 *
 * 不在此函数内 warn 的原因：plugin.notify 与 plugin.ui.notify 两个 RPC 入口的
 * 历史 warn 文案不同（分别含 'plugin.notify' / 'ui-api notify' 字样），统一模板会
 * 改变可观测输出。去重的核心是广播 payload 组装，warn 是入口特定的可观测细节。
 */
export function broadcastPluginNotification(
  broadcastFn: PluginBroadcastFn | undefined,
  pluginId: string,
  level: string,
  message: string,
): boolean {
  if (broadcastFn) {
    broadcastFn('plugin:notification', { pluginId, level, message })
    return true
  }
  return false
}

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
  broadcastFn?: PluginBroadcastFn,
): NotifyHandlers {
  return {
    notify: (pluginId, level, message) => {
      // 文案与重构前逐字一致（commit 8dd3034f 父版本）
      if (!broadcastPluginNotification(broadcastFn, pluginId, level, message)) {
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
