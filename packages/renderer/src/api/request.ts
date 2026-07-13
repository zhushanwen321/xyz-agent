/**
 * RPC 泛型 helper —— 收敛 pending.create + register + transport.send 的 4 行模板。
 *
 * api/domains/ 下每个 RPC 函数原本手动展开：
 *   const id = pending.create()
 *   const result = pending.register<TReply>(id)
 *   transport.send({ type, id, payload })
 *   return await result
 *
 * 收敛为单次 request<TReply>(type, payload) 调用。调用方自己从 reply 解包字段。
 */
import type { ClientMessage, ClientMessageType } from '@xyz-agent/shared'
import * as transport from './transport'
import * as pending from './pending'

/**
 * 发送 RPC 请求并等待 reply。
 *
 * @param type ClientMessageType 字面量（协议层 SSOT 定义）
 * @param payload 请求 payload（类型由 protocol ClientMessageMap 约束，此处宽松以避免泛型穿透）
 * @returns reply payload（调用方自行解包字段）
 *
 * @example
 *   // 解包型：reply 是 { subagents: SubagentRecord[] }
 *   const reply = await request('session.getSubagents', { sessionId })
 *   return reply.subagents
 *
 *   // void 型：reply 无 payload
 *   await request('session.switch', { sessionId })
 */
export async function request<TReply = void>(
  type: ClientMessageType,
  payload: Record<string, unknown> = {},
): Promise<TReply> {
  const id = pending.create()
  const result = pending.register<TReply>(id)
  // ClientMessage 是 discriminated union（type ↔ payload 对应），helper 的泛型 payload
  // 无法满足精确联合约束，用断言绕过——type 字面量已由 ClientMessageType 约束，安全。
  transport.send({ type, id, payload } as ClientMessage)
  return result
}
