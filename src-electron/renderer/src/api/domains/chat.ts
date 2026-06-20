/**
 * Chat 域 —— send/abort/streamSubscribe。
 *
 * 依赖方向：transport（send/abort）+ events（streamSubscribe 路由）。
 *
 * 注意：streamSubscribe 的 handler 参数类型是 ServerMessage（shared 协议类型），
 * 不臆造 StreamChunk。调用方在 handler 内过滤 message.text_delta 等事件。
 * 注：mock 模式下不走本域（api/index 切到 mock 门面）。
 */
import type { ServerMessage } from '@xyz-agent/shared'
import * as transport from '../transport'
import * as pending from '../pending'
import * as events from '../events'

/** 发送消息（mock 不模拟失败，D7） */
export function send(sessionId: string, text: string): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'message.send', id, payload: { sessionId, content: text } })
  return result
}

/** 中断当前回合（DEFERRED 流转，§9 G-025） */
export function abort(sessionId: string): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'message.abort', id, payload: { sessionId } })
  return result
}

/**
 * 订阅指定 session 的流式消息事件，返回取消函数。
 * handler 收到原始 ServerMessage，调用方自行过滤 text_delta/thinking_delta 等 type。
 */
export function streamSubscribe(
  sessionId: string,
  handler: (msg: ServerMessage) => void,
): () => void {
  return events.on(sessionId, handler)
}
