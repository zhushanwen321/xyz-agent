/**
 * UI API 模块
 *
 * 提供前端交互（对话框、通知、状态栏）的 RPC handler（主线程侧）和 Worker 侧代理对象。
 *
 * 主线程侧：registerUiRpcHandlers() 在 PluginRpcServer 上注册
 *   plugin.ui.showSelect / showConfirm / showInput / notify / updateStatusBarItem 五个 RPC 方法。
 *
 * Worker 侧：createUiApi() 返回代理对象，通过 RPC 转发到主线程。
 *
 * showSelect/confirm/input 经 ctx.handleUiRequest 发 extension_ui_request 到前端并等待响应。
 */

import type { PluginRpcServer } from '../plugin-rpc-server.js'
import type { PluginRpcClient } from '../plugin-rpc-client.js'
import type { StatusBarItemOptions } from '../plugin-types.js'

/** UI 服务依赖（主线程侧） */
export interface UiHandlers {
  /**
   * 发送 extension_ui_request 到前端。
   * 经 handleUiRequest 发送，返回前端选择结果。
   */
  showSelect(title: string, options: string[], pluginId: string): Promise<string | undefined>
  showConfirm(title: string, message: string, pluginId: string): Promise<boolean>
  showInput(title: string, defaultValue: string | undefined, pluginId: string): Promise<string | undefined>
  notify(pluginId: string, level: string, message: string): Promise<void>
  updateStatusBarItem(pluginId: string, id: string, text: string, options?: StatusBarItemOptions): Promise<void>
}

export function registerUiRpcHandlers(
  rpcServer: PluginRpcServer,
  deps: UiHandlers,
): void {
  rpcServer.registerMethod('plugin.ui.showSelect', async (params) => {
    const title = params.title as string
    const options = params.options as string[]
    const pluginId = params.pluginId as string
    return deps.showSelect(title, options, pluginId)
  })

  rpcServer.registerMethod('plugin.ui.showConfirm', async (params) => {
    const title = params.title as string
    const message = params.message as string
    const pluginId = params.pluginId as string
    return deps.showConfirm(title, message, pluginId)
  })

  rpcServer.registerMethod('plugin.ui.showInput', async (params) => {
    const title = params.title as string
    const defaultValue = params.defaultValue as string | undefined
    const pluginId = params.pluginId as string
    return deps.showInput(title, defaultValue, pluginId)
  })

  rpcServer.registerMethod('plugin.ui.notify', async (params) => {
    const pluginId = params.pluginId as string
    const level = params.level as string
    const message = params.message as string
    await deps.notify(pluginId, level, message)
  })

  rpcServer.registerMethod('plugin.ui.updateStatusBarItem', async (params) => {
    const pluginId = params.pluginId as string
    const id = params.id as string
    const text = params.text as string
    const options = params.options as StatusBarItemOptions | undefined
    await deps.updateStatusBarItem(pluginId, id, text, options)
  })
}

export function createUiApi(
  rpcClient: PluginRpcClient,
  pluginId: string,
): {
  showSelect(title: string, options: string[]): Promise<string | undefined>
  showConfirm(title: string, message: string): Promise<boolean>
  showInput(title: string, defaultValue?: string): Promise<string | undefined>
  notify(level: 'info' | 'warn' | 'error', message: string): Promise<void>
  updateStatusBarItem(id: string, text: string, options?: StatusBarItemOptions): Promise<void>
} {
  return {
    showSelect: (title: string, options: string[]) =>
      rpcClient.request('plugin.ui.showSelect', { pluginId, title, options }) as Promise<string | undefined>,

    showConfirm: (title: string, message: string) =>
      rpcClient.request('plugin.ui.showConfirm', { pluginId, title, message }) as Promise<boolean>,

    showInput: (title: string, defaultValue?: string) =>
      rpcClient.request('plugin.ui.showInput', { pluginId, title, defaultValue }) as Promise<string | undefined>,

    notify: (level: 'info' | 'warn' | 'error', message: string) =>
      rpcClient.request('plugin.ui.notify', { pluginId, level, message }).then(() => {}),

    updateStatusBarItem: (id: string, text: string, options?: StatusBarItemOptions) =>
      rpcClient.request('plugin.ui.updateStatusBarItem', { pluginId, id, text, options }).then(() => {}),
  }
}
