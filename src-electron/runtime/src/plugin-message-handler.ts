/**
 * Plugin message handler for plugin.* message types.
 * Extracted from SidecarServer to reduce file size.
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ServerMessage } from '@xyz-agent/shared'
import type { IPluginService } from './interfaces.js'

export interface PluginHandlerContext {
  pluginService: IPluginService | null
  send(ws: WsType, msg: ServerMessage): void
  sendError(ws: WsType, code: string, message: string, id?: string, sessionId?: string): void
}

export class PluginMessageHandler {
  constructor(private ctx: PluginHandlerContext) {}

  async handlePluginMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    if (!this.ctx.pluginService) {
      return this.ctx.sendError(ws, 'handler_error', 'Plugin service not available', msg.id)
    }
    switch (msg.type) {
      case 'plugin.list': {
        const plugins = this.ctx.pluginService.getDiscoveredPlugins()
        return this.ctx.send(ws, { type: 'config.plugins', id: msg.id, payload: { plugins } })
      }
      case 'plugin.toggle': {
        const toggledPlugins = await this.ctx.pluginService.togglePlugin(msg.payload.pluginId, msg.payload.enabled)
        return this.ctx.send(ws, { type: 'config.plugins', id: msg.id, payload: { plugins: toggledPlugins } })
      }
      case 'plugin.uninstall': {
        const uninstalledPlugins = await this.ctx.pluginService.uninstallPlugin(msg.payload.pluginId)
        return this.ctx.send(ws, { type: 'config.plugins', id: msg.id, payload: { plugins: uninstalledPlugins } })
      }
      case 'plugin.approvePermissions': {
        await this.ctx.pluginService.approvePermissions(msg.payload.pluginId, msg.payload.permissions)
        return this.ctx.send(ws, { type: 'config.plugins', id: msg.id, payload: { plugins: this.ctx.pluginService.getDiscoveredPlugins() } })
      }
      case 'plugin.revokePermissions': {
        await this.ctx.pluginService.revokePermissions(msg.payload.pluginId)
        return this.ctx.send(ws, { type: 'config.plugins', id: msg.id, payload: { plugins: this.ctx.pluginService.getDiscoveredPlugins() } })
      }
      case 'plugin.executeCommand': {
        await this.ctx.pluginService.executeCommand(msg.payload.pluginId, msg.payload.commandId, msg.payload.args)
        return this.ctx.send(ws, { type: 'pong', id: msg.id, payload: {} })
      }
      case 'plugin.config.get': {
        const configValue = await this.ctx.pluginService.getPluginConfig(msg.payload.pluginId, msg.payload.key)
        const configKey = msg.payload.key ?? '__all__'
        return this.ctx.send(ws, { type: 'plugin:config', id: msg.id, payload: { pluginId: msg.payload.pluginId, config: configKey === '__all__' ? (configValue as Record<string, unknown>) : { [configKey]: configValue } } })
      }
      case 'plugin.config.set': {
        await this.ctx.pluginService.setPluginConfig(msg.payload.pluginId, msg.payload.key, msg.payload.value)
        const allConfig = await this.ctx.pluginService.getPluginConfig(msg.payload.pluginId)
        return this.ctx.send(ws, { type: 'plugin:config', id: msg.id, payload: { pluginId: msg.payload.pluginId, config: allConfig as Record<string, unknown> } })
      }
      case 'plugin.install': {
        const { packageSpec: packageSpecifier } = msg.payload as { packageSpec: string }
        if (!packageSpecifier) {
          return this.ctx.sendError(ws, 'invalid_params', 'Missing packageSpec', msg.id)
        }
        const result = await this.ctx.pluginService.installPlugin(packageSpecifier)
        if (result.success) {
          const plugins = this.ctx.pluginService.getDiscoveredPlugins()
          this.ctx.send(ws, { type: 'config.plugins', id: msg.id, payload: { plugins } })
        } else {
          this.ctx.sendError(ws, 'install_failed', (result as unknown as Record<string, unknown>).error as string ?? 'Install failed', msg.id)
        }
        break
      }
      case 'plugin.uiResponse': {
        const uiService = this.ctx.pluginService as unknown as { handleUiResponse(requestId: string, result: unknown): void }
        if (uiService.handleUiResponse) {
          uiService.handleUiResponse((msg.payload as { requestId: string; result: unknown }).requestId, (msg.payload as { requestId: string; result: unknown }).result)
        }
        return this.ctx.send(ws, { type: 'pong', id: msg.id, payload: {} })
      }
    }
  }
}
