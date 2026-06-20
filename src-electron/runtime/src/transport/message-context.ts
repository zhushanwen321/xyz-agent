/**
 * transport message-handler 的共享上下文接口（D8/D9/D2）。
 *
 * 5 个 handler 的 Context 接口此前各自重复声明 `send` / `sendError` 签名（4/5 完全相同，
 * tree 只有 send）。抽此 base interface 让它们 extends，消除签名重复。每个 handler 仍保留
 * 自己的领域 service 依赖（pluginService / sessionService / ...），只共享「向 ws 发消息」
 * 这对无业务语义的契约。
 *
 * - `send`：5/5 handler 都有（向单个 ws 发 ServerMessage）。
 * - `sendError`：4/5 handler 有（tree 不发 error envelope，故 tree 的 Context 只 extends
 *   这里的 send 而不带 sendError——tree 不继承本接口，仅复用 send 形态）。
 * - `reply`（D2）：消灭 46 处 `send(ws, { type, id: msg.id, payload })` 样板。id 默认取请求 id。
 */
import type { WebSocket as WsType } from 'ws'
import type { ServerMessage, ServerMessageType } from '@xyz-agent/shared'

/**
 * 所有 message-handler 共享的最小发消息契约。
 *
 * 实现由 server.ts 提供（send/sendError/reply 都是 server 的方法），handler 只通过 ctx 调用。
 */
export interface MessageHandlerContext {
  send(ws: WsType, msg: ServerMessage): void
  sendError(ws: WsType, code: string, message: string, id?: string, sessionId?: string): void
  /**
   * 发送一条带请求 id 的回复（D2 reply 惯用法）。
   * 等价于 `send(ws, { type, id, payload })`，但省去每次手写 `id: msg.id`。
   */
  reply(ws: WsType, id: string | undefined, type: ServerMessageType, payload: Record<string, unknown>): void
}
