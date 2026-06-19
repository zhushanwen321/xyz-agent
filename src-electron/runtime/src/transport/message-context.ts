/**
 * transport message-handler 的共享上下文接口（D8）。
 *
 * 5 个 handler 的 Context 接口此前各自重复声明 `send` / `sendError` 签名（4/5 完全相同，
 * tree 只有 send）。抽此 base interface 让它们 extends，消除签名重复。每个 handler 仍保留
 * 自己的领域 service 依赖（pluginService / sessionService / ...），只共享「向 ws 发消息」
 * 这一对无业务语义的契约。
 */
import type { WebSocket as WsType } from 'ws'
import type { ServerMessage } from '@xyz-agent/shared'

/**
 * 所有 message-handler 共享的最小发消息契约。
 * - `send`：5/5 handler 都有（向单个 ws 发 ServerMessage）。
 * - `sendError`：4/5 handler 有（tree 不发 error，故 tree 的 Context 只 extends 这里的 send
 *   而不带 sendError——tree 不继承本接口，仅复用 send 形态）。
 *
 * 实现由 server.ts 提供（send/sendError 都是 server 的方法），handler 只通过 ctx 调用。
 */
export interface MessageHandlerContext {
  send(ws: WsType, msg: ServerMessage): void
  sendError(ws: WsType, code: string, message: string, id?: string, sessionId?: string): void
}
