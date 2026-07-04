/**
 * transport message-context 桩（git-message-handler.ts GitHandlerContext extends MessageHandlerContext）。
 * 仅暴露 handler 用到的 send/sendError/reply 签名。完整定义在 src-electron/runtime/src/transport/message-context.ts（未改动）。
 */
import type { WebSocket as WsType } from 'ws'
import type { ServerMessage, ServerMessageType } from '@xyz-agent/shared'

export interface ErrorDetails {
  hint?: string
  path?: string
  [k: string]: unknown
}

export interface MessageHandlerContext {
  send(ws: WsType, msg: ServerMessage): void
  sendError(ws: WsType, code: string, message: string, id?: string, details?: ErrorDetails): void
  reply(ws: WsType, id: string | undefined, type: ServerMessageType, payload: Record<string, unknown>): void
}
