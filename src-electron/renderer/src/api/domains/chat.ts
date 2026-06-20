/**
 * Chat 域 —— send/abort/streamSubscribe。
 *
 * 依赖方向：transport（send/abort）+ events（streamSubscribe 路由）。
 * 骨架阶段：签名完整，体 throw。
 *
 * 注意：streamSubscribe 的 handler 参数类型是 ServerMessage（shared 协议类型），
 * 不臆造 StreamChunk。调用方在 handler 内过滤 message.text_delta 等事件。
 */
import type { ServerMessage } from '@xyz-agent/shared'

/** 发送消息（mock 不模拟失败，D7） */
export function send(sessionId: string, text: string): Promise<void> {
  throw new Error(`not implemented: send(${sessionId}, ${text})`)
}

/** 中断当前回合（DEFERRED 流转，§9 G-025） */
export function abort(sessionId: string): Promise<void> {
  throw new Error(`not implemented: abort(${sessionId})`)
}

/**
 * 订阅指定 session 的流式消息事件，返回取消函数。
 * handler 收到原始 ServerMessage，调用方自行过滤 text_delta/thinking_delta 等 type。
 */
export function streamSubscribe(
  sessionId: string,
  handler: (msg: ServerMessage) => void,
): () => void {
  throw new Error(`not implemented: streamSubscribe(${sessionId}, ${typeof handler})`)
}
