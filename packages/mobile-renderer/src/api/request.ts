/**
 * RPC 类型化 helper —— 收敛 pending.create + register + transport.send 的 4 行模板。
 *
 * api/domains/ 下每个 RPC 函数原本手动展开：
 *   const id = pending.create()
 *   const result = pending.register<TReply>(id)
 *   transport.send({ type, id, payload })
 *   return await result
 *
 * 收敛为单次 command<K>(type, payload) 调用。K 经 ReplyPayloadMap 推导出 reply payload 类型，
 * payload 经 ClientMessageMap[K] 约束——调用方无需手写泛型实参，request/reply 双向类型安全。
 * 调用方自己从 reply 解包字段（如 `.subagents`）。
 */
import type { ClientMessage, ClientMessageMap, ReplyPayloadMap } from '@xyz-agent/shared'
import * as transport from './transport'
import * as pending from './pending'

/**
 * 发送 RPC 请求并等待 reply（类型化原语）。
 *
 * @param type ClientMessageType 字面量（须是 ReplyPayloadMap 的 key，即 RPC 型）
 * @param payload 请求 payload，类型由 ClientMessageMap[K] 约束
 * @param timeoutMs 可选超时
 * @returns reply payload，类型由 ReplyPayloadMap[K] 推导（ack 型为 void，payload 消费型为具体字段）
 *
 * @example
 *   // payload 消费型：reply 类型是 ReplyPayloadMap['session.getSubagents']，即 { sessionId, subagents }
 *   const reply = await command('session.getSubagents', { sessionId })
 *   return reply.subagents
 *
 *   // ack 型：reply 类型是 void（ReplyPayloadMap['session.switch']）
 *   await command('session.switch', { sessionId })
 */
export async function command<K extends keyof ReplyPayloadMap>(
  type: K,
  payload: ClientMessageMap[K],
  timeoutMs?: number,
): Promise<ReplyPayloadMap[K]> {
  const id = pending.create()
  const result = pending.register<ReplyPayloadMap[K]>(id, timeoutMs)
  // ClientMessage 是 discriminated union（type ↔ payload 对应），helper 的泛型 payload
  // 无法满足精确联合约束，用断言绕过——type 字面量已由 ReplyPayloadMap key 约束，安全。
  transport.send({ type, id, payload } as ClientMessage)
  return result
}
