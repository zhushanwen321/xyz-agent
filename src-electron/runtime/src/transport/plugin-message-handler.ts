/**
 * Plugin message handler for plugin.* message types.
 * Extracted from RuntimeServer to reduce file size.
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ClientMessageType, PluginInfo } from '@xyz-agent/shared'
import type { IPluginService } from '../interfaces.js'
import type { PluginDescriptor } from '../services/plugin-service/plugin-types.js'
import type { MessageHandlerContext } from './message-context.js'

export interface PluginHandlerContext extends MessageHandlerContext {
  pluginService: IPluginService | null
}

/**
 * E1 reply 泛型化暴露的既有协议债：IPluginService 返回 PluginDescriptor[]（runtime 内部类型，
 * PluginInfo 超集：多 main/activationEvents/contributes…，缺 enabled，status 标注为内部 PluginState
 * 但实际值经 mapStateForProtocol 已是协议态）。协议 config.plugins 契约却是 PluginInfo[]。
 *
 * 此函数**仅做类型缝合，不改运行时序列化**——透传整个 descriptor 对象（前端按 PluginInfo
 * 字段读取兼容，多余字段被忽略）。待 plugin-service 内建立正式 PluginDescriptor→PluginInfo 映射后删除。
 */
function asPluginInfos(descriptors: PluginDescriptor[]): PluginInfo[] {
  return descriptors as unknown as PluginInfo[]
}

export class PluginMessageHandler {
  constructor(private ctx: PluginHandlerContext) {}

  /** D1: 本 handler 认领的 ClientMessageType 清单。 */
  readonly handles: ClientMessageType[] = [
    'plugin.list', 'plugin.toggle', 'plugin.uninstall', 'plugin.approvePermissions', 'plugin.revokePermissions',
    'plugin.executeCommand', 'plugin.config.get', 'plugin.config.set', 'plugin.install', 'plugin.uiResponse',
  ]

  async handlePluginMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    // D3: service-not-available 前置守卫（与 extension 的 requireExt 同形）。
    if (!this.ctx.pluginService) {
      return this.ctx.sendError(ws, 'handler_error', 'Plugin service not available', msg.id)
    }
    switch (msg.type) {
      case 'plugin.list': {
        const plugins = this.ctx.pluginService.getDiscoveredPlugins()
        return this.ctx.reply(ws, msg.id, 'config.plugins', { plugins: asPluginInfos(plugins) })
      }
      case 'plugin.toggle': {
        const toggledPlugins = await this.ctx.pluginService.togglePlugin(msg.payload.pluginId, msg.payload.enabled)
        return this.ctx.reply(ws, msg.id, 'config.plugins', { plugins: asPluginInfos(toggledPlugins) })
      }
      case 'plugin.uninstall': {
        const uninstalledPlugins = await this.ctx.pluginService.uninstallPlugin(msg.payload.pluginId)
        return this.ctx.reply(ws, msg.id, 'config.plugins', { plugins: asPluginInfos(uninstalledPlugins) })
      }
      case 'plugin.approvePermissions': {
        await this.ctx.pluginService.approvePermissions(msg.payload.pluginId, msg.payload.permissions)
        return this.ctx.reply(ws, msg.id, 'config.plugins', { plugins: asPluginInfos(this.ctx.pluginService.getDiscoveredPlugins()) })
      }
      case 'plugin.revokePermissions': {
        await this.ctx.pluginService.revokePermissions(msg.payload.pluginId)
        return this.ctx.reply(ws, msg.id, 'config.plugins', { plugins: asPluginInfos(this.ctx.pluginService.getDiscoveredPlugins()) })
      }
      case 'plugin.executeCommand': {
        await this.ctx.pluginService.executeCommand(msg.payload.pluginId, msg.payload.commandId, msg.payload.args)
        return this.ctx.reply(ws, msg.id, 'pong', {})
      }
      case 'plugin.config.get': {
        const configValue = await this.ctx.pluginService.getPluginConfig(msg.payload.pluginId, msg.payload.key)
        const configKey = msg.payload.key ?? '__all__'
        return this.ctx.reply(ws, msg.id, 'plugin:config', { pluginId: msg.payload.pluginId, config: configKey === '__all__' ? (configValue as Record<string, unknown>) : { [configKey]: configValue } })
      }
      case 'plugin.config.set': {
        await this.ctx.pluginService.setPluginConfig(msg.payload.pluginId, msg.payload.key, msg.payload.value)
        const allConfig = await this.ctx.pluginService.getPluginConfig(msg.payload.pluginId)
        return this.ctx.reply(ws, msg.id, 'plugin:config', { pluginId: msg.payload.pluginId, config: allConfig as Record<string, unknown> })
      }
      case 'plugin.install': {
        const { packageSpec: packageSpecifier } = msg.payload as { packageSpec: string }
        if (!packageSpecifier) {
          return this.ctx.sendError(ws, 'invalid_params', 'Missing packageSpec', msg.id)
        }
        const result = await this.ctx.pluginService.installPlugin(packageSpecifier)
        if (result.success) {
          const plugins = this.ctx.pluginService.getDiscoveredPlugins()
          this.ctx.reply(ws, msg.id, 'config.plugins', { plugins: asPluginInfos(plugins) })
        } else {
          this.ctx.sendError(ws, 'install_failed', result.error ?? 'Install failed', msg.id)
        }
        break
      }
      case 'plugin.uiResponse': {
        // handleUiResponse 已在 IPluginService 接口声明（interfaces.ts）；顶部 guard 保证 pluginService 非空
        this.ctx.pluginService?.handleUiResponse((msg.payload as { requestId: string; result: unknown }).requestId, (msg.payload as { requestId: string; result: unknown }).result)
        return this.ctx.reply(ws, msg.id, 'pong', {})
      }
    }
  }
}
