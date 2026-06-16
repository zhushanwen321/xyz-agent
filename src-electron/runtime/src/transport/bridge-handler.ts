/**
 * Bridge request handler for extension UI requests that bypass the frontend.
 * Routes to PluginService and sends extension_ui_response back to pi RPC.
 */
import type { IRpcClient } from '../interfaces.js'
import type { IPluginService } from '../interfaces.js'

export class BridgeHandler {
  constructor(private readonly pluginService: IPluginService | null) {}

  async handleBridgeRequest(
    sessionId: string,
    requestId: string,
    method: string,
    data: Record<string, unknown>,
    client: IRpcClient,
  ): Promise<void> {
    try {
      const methodName = method as string
      switch (methodName) {
        case 'bridge:sync': {
          const tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }> = []
          const commands: Array<{ name: string }> = []
          if (this.pluginService?.getToolSchemas) {
            const schemas = this.pluginService.getToolSchemas()
            for (const s of schemas) {
              tools.push({ name: s.name, description: s.description, parameters: s.parameters })
            }
          }
          await client.sendCommand('extension_ui_response', { id: requestId, response: { tools, commands, success: true } })
          return
        }

        case 'bridge:tool_execute': {
          const toolName = data.toolName as string
          const params = data.params as Record<string, unknown> ?? {}
          if (!this.pluginService?.handleBridgeToolExecute) {
            await client.sendCommand('extension_ui_response', { id: requestId, response: { content: 'Plugin system not available', isError: true } })
            return
          }
          const result = await this.pluginService.handleBridgeToolExecute({
            type: 'bridge.tool.execute',
            toolName, parameters: params, toolCallId: data.toolCallId as string ?? '', sessionId,
          })
          await client.sendCommand('extension_ui_response', { id: requestId, response: result })
          return
        }

        case 'bridge:event': {
          const eventName = data.eventName as string
          const eventData = data.data as Record<string, unknown> ?? {}
          console.log(`[server] bridge event: ${eventName} from session ${sessionId}`)
          if (this.pluginService?.handleBridgeEvent) {
            this.pluginService.handleBridgeEvent(eventName, eventData, sessionId)
          }
          await client.sendCommand('extension_ui_response', { id: requestId, response: null })
          return
        }

        case 'bridge:intercept': {
          const eventName = data.eventName as string
          const eventData = data.data as Record<string, unknown> ?? {}
          if (this.pluginService?.handleBridgeIntercept && eventName === 'before_agent_start') {
            const result = await this.pluginService.handleBridgeIntercept(eventName, eventData, sessionId)
            await client.sendCommand('extension_ui_response', { id: requestId, response: result })
            return
          }
          await client.sendCommand('extension_ui_response', { id: requestId, response: {} })
          return
        }

        default: {
          console.warn(`[server] Unknown bridge method: ${methodName}`)
          await client.sendCommand('extension_ui_response', { id: requestId, response: { error: `Unknown bridge method: ${methodName}` } })
        }
      }
    } catch (e) {
      console.error(`[server] bridge request failed: ${method}`, e)
      try {
        await client.sendCommand('extension_ui_response', { id: requestId, response: { error: String(e) } })
        // eslint-disable-next-line taste/no-silent-catch
      } catch (sendErr) {
        console.error(`[bridge-handler] failed to send error response to pi: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`)
        // Cannot propagate further — both pi and frontend channels exhausted
      }
    }
  }

  /** Handle statusSetUpdate events from event-adapter */
  handleStatusSetUpdate(payload: { sessionId: string; key: string; text: string }): void {
    if (this.pluginService?.handleBridgeEvent) {
      this.pluginService.handleBridgeEvent('plugin:statusSetUpdate', payload, payload.sessionId)
    }
  }
}
