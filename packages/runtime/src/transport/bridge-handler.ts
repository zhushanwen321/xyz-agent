/**
 * Bridge request handler for extension UI requests that bypass the frontend.
 *
 * 纯路由铁律：本类只做 method→pluginService 分派 + pi response 回写。
 * 所有领域逻辑（schema 塑形、事件白名单过滤）已下沉到 plugin-service：
 *  - bridge:sync        → pluginService.getBridgeSyncPayload()（工具 schema 塑形）
 *  - bridge:tool_execute → pluginService.handleBridgeToolExecute()（ADR-0012 契约）
 *  - bridge:intercept    → pluginService.handleBridgeIntercept()（before_agent_start 判定下沉）
 *  - bridge:event        → pluginService.handleBridgeEvent()（fire-and-forget）
 *  - bridge:malformed    → marker 通道解析失败哨兵回包（E5，event-adapter 折叠产出）
 *
 * 回包序列化契约（设计 bridge-rewrite-pi-0.84 §3.3-D1）：新通道（select+BRIDGE_MARKER）
 * 的回包必须 JSON.stringify 后以 method='select' 回传——rpc-client 对 select 走
 * `{value: String(response)}`，传裸对象会变 '[object Object]'（对字符串幂等安全）。
 * bridge:event 例外：恒 null → cancelled 帧（bridge 侧 void 丢弃）。
 */
import type { IPiEngine } from '../services/ports/pi-engine.js'
import type { IPluginService } from '../interfaces.js'
import { toErrorMessage } from '../utils/errors.js'

export class BridgeHandler {
  constructor(
    private readonly pluginService: IPluginService | null,
    /**
     * bridge 请求登记所（marker 通道识别后的登记点）：新通道 method 恒为 'select'，
     * ExtensionTimeoutManager.registerTimeout 的 bridge: 前缀判定不再命中，识别出的
     * 请求到达本 handler 时登记进 bridgeRequestIds——供 extension-message-handler 拦截
     * 前端误发的 ui_response（bridge 请求由 runtime 内部应答，前端不得抢答）；
     * clearForSession 按 session 跟踪清理。结构类型：生产注入 ExtensionTimeoutManager。
     */
    private readonly timeoutManager?: { addBridgeRequest(sessionId: string, requestId: string): void },
  ) {}

  async handleBridgeRequest(
    sessionId: string,
    requestId: string,
    method: string,
    data: Record<string, unknown>,
    client: IPiEngine,
  ): Promise<void> {
    this.timeoutManager?.addBridgeRequest(sessionId, requestId)
    try {
      switch (method) {
        // 同步工具 schema（塑形由 plugin-service 负责）
        case 'bridge:sync': {
          const payload = this.pluginService?.getBridgeSyncPayload
            ? this.pluginService.getBridgeSyncPayload()
            : { tools: [], commands: [], success: true }
          client.sendExtensionUiResponse(requestId, JSON.stringify(payload), 'select')
          return
        }

        // 执行 bridge 工具（ADR-0012 契约）；请求对象构造是 transport↔service 边界编组
        case 'bridge:tool_execute': {
          if (!this.pluginService?.handleBridgeToolExecute) {
            client.sendExtensionUiResponse(
              requestId,
              JSON.stringify({ content: 'Plugin system not available', isError: true }),
              'select',
            )
            return
          }
          const result = await this.pluginService.handleBridgeToolExecute({
            type: 'bridge.tool.execute',
            toolName: data.toolName as string,
            parameters: (data.params as Record<string, unknown>) ?? {},
            toolCallId: (data.toolCallId as string) ?? '',
            sessionId,
          })
          client.sendExtensionUiResponse(requestId, JSON.stringify(result), 'select')
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
          // response=null → sendExtensionUiResponse 发 {cancelled:true}（非旧 {response:null}）。
          // 无功能影响：bridge 扩展对 bridge:event 的响应 void 丢弃（见 pi bridge/index.ts:58）。
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
          client.sendExtensionUiResponse(requestId, JSON.stringify(result), 'select')
          return
        }

        // marker 通道解析失败哨兵（event-adapter 折叠产出）：回 E5 malformed 错误（含恢复
        // 指引），warn 留痕（raw payload 进日志），不透传前端。第 7 处回包点，同用
        // stringify+'select' 序列化（防漏登记，设计 §3.3-D6）。
        case 'bridge:malformed': {
          console.warn(`[server] malformed bridge request from session ${sessionId}, raw payload:`, data.raw)
          client.sendExtensionUiResponse(
            requestId,
            JSON.stringify({
              error: 'malformed bridge request',
              hint: 'bridge extension and runtime protocol mismatch — redeploy same-version runtime+bridge',
            }),
            'select',
          )
          return
        }

        default: {
          console.warn(`[server] Unknown bridge method: ${method}`)
          client.sendExtensionUiResponse(
            requestId,
            JSON.stringify({ error: `Unknown bridge method: ${method}` }),
            'select',
          )
        }
      }
    } catch (e) {
      console.error(`[server] bridge request failed: ${method}`, e)
      try {
        // sendExtensionUiResponse 是同步 void（pi 不回 extension_ui_response 的 RPC reply，
        // 内部走 sendRaw 直接写 stdin），不会抛异步超时错误；但 stdin.write 可能同步抛，
        // 故仍保留 try/catch 兜底。
        client.sendExtensionUiResponse(requestId, JSON.stringify({ error: String(e) }), 'select')
         
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
