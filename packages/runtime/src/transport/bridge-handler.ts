/**
 * Bridge request handler for extension UI requests that bypass the frontend.
 *
 * 纯路由铁律：本类只做 method→pluginService 分派 + pi response 回写。
 * 所有领域逻辑（schema 塑形、事件白名单过滤）已下沉到 plugin-service：
 *  - bridge:sync        → pluginService.getBridgeSyncPayload()（工具 schema 塑形）
 *  - bridge:tool_execute → pluginService.handleBridgeToolExecute()（ADR-0012 契约）
 *  - bridge:intercept    → pluginService.handleBridgeIntercept()（before_agent_start 判定下沉）
 *  - bridge:event        → pluginService.handleBridgeEvent()（fire-and-forget）
 */
import type { IPiEngine } from '../services/ports/pi-engine.js'
import type { IPluginService } from '../interfaces.js'
import { toErrorMessage } from '../utils/errors.js'

export class BridgeHandler {
  constructor(private readonly pluginService: IPluginService | null) {}

  async handleBridgeRequest(
    sessionId: string,
    requestId: string,
    method: string,
    data: Record<string, unknown>,
    client: IPiEngine,
  ): Promise<void> {
    try {
      switch (method) {
        // 同步工具 schema（塑形由 plugin-service 负责）
        case 'bridge:sync': {
          const payload = this.pluginService?.getBridgeSyncPayload
            ? this.pluginService.getBridgeSyncPayload()
            : { tools: [], commands: [], success: true }
          client.sendExtensionUiResponse(requestId, payload)
          return
        }

        // 执行 bridge 工具（ADR-0012 契约）；请求对象构造是 transport↔service 边界编组
        case 'bridge:tool_execute': {
          if (!this.pluginService?.handleBridgeToolExecute) {
            client.sendExtensionUiResponse(requestId, { content: 'Plugin system not available', isError: true })
            return
          }
          const result = await this.pluginService.handleBridgeToolExecute({
            type: 'bridge.tool.execute',
            toolName: data.toolName as string,
            parameters: (data.params as Record<string, unknown>) ?? {},
            toolCallId: (data.toolCallId as string) ?? '',
            sessionId,
          })
          client.sendExtensionUiResponse(requestId, result)
          return
        }

        // fire-and-forget 事件
        case 'bridge:event': {
          console.log(`[server] bridge event: ${data.eventName as string} from session ${sessionId}`)
          this.pluginService?.handleBridgeEvent?.(
            data.eventName as string,
            (data.data as Record<string, unknown>) ?? {},
            sessionId,
          )
          client.sendExtensionUiResponse(requestId, null)
          return
        }

        // 拦截（before_agent_start 判定下沉 plugin-service）
        case 'bridge:intercept': {
          const eventName = data.eventName as string
          const eventData = (data.data as Record<string, unknown>) ?? {}
          const result = this.pluginService?.handleBridgeIntercept
            ? await this.pluginService.handleBridgeIntercept(eventName, eventData, sessionId)
            : {}
          client.sendExtensionUiResponse(requestId, result)
          return
        }

        default: {
          console.warn(`[server] Unknown bridge method: ${method}`)
          client.sendExtensionUiResponse(requestId, { error: `Unknown bridge method: ${method}` })
        }
      }
    } catch (e) {
      console.error(`[server] bridge request failed: ${method}`, e)
      try {
        // sendExtensionUiResponse 是同步 void（pi 不回 extension_ui_response 的 RPC reply，
        // 内部走 sendRaw 直接写 stdin），不会抛异步超时错误；但 stdin.write 可能同步抛，
        // 故仍保留 try/catch 兜底。
        client.sendExtensionUiResponse(requestId, { error: String(e) })
        // eslint-disable-next-line taste/no-silent-catch
      } catch (sendErr) {
        console.error(`[bridge-handler] failed to send error response to pi: ${toErrorMessage(sendErr)}`)
        // Cannot propagate further — both pi and frontend channels exhausted
      }
    }
  }

  /** Handle statusSetUpdate events from event-adapter */
  handleStatusSetUpdate(payload: { sessionId: string; key: string; text: string; textRaw?: string }): void {
    this.pluginService?.handleBridgeEvent?.('plugin:statusSetUpdate', payload, payload.sessionId)
  }
}
