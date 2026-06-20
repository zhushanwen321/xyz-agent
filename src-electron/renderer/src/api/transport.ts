/**
 * Transport 层 —— 封装 ws-client（R5），提供 connect/send/on 统一管道。
 *
 * 依赖方向：lib/ws-client（transport 是业务层对 ws-client 的唯一适配点）。
 * 骨架阶段：签名完整，体 throw。
 */
import type { ClientMessage, ServerMessage } from '@xyz-agent/shared'

/** 建立 WS 连接（mock 模式 200ms 直进 connected） */
export function connect(): Promise<void> {
  throw new Error('not implemented')
}

/** 发送 ClientMessage（未连接时 queue） */
export function send(msg: ClientMessage): void {
  throw new Error(`not implemented: send(${msg.type})`)
}

/** 订阅 ServerMessage（第 1 层：所有消息），返回取消函数 */
export function on(handler: (msg: ServerMessage) => void): () => void {
  throw new Error(`not implemented: on(${typeof handler})`)
}
