/**
 * Chat 域 —— send/abort/streamSubscribe。
 *
 * 依赖方向：command（RPC，send/abort/steer/followUp/compact/getHistory）+ events（streamSubscribe 路由）。
 *
 * 注意：streamSubscribe 的 handler 参数类型是 ServerMessage（shared 协议类型），
 * 不臆造 StreamChunk。调用方在 handler 内过滤 message.text_delta 等事件。
 * 注：mock 模式下不走本域（api/index 切到 mock 门面）。
 */
import type { Message, ServerMessage } from '@xyz-agent/shared'
import { command } from '../request'
import * as events from '../events'

/** compact 超时（ms）：对齐 runtime rpc-client COMPACT_TIMEOUT_MS，大上下文压缩需数分钟 */
const COMPACT_TIMEOUT_MS = 300_000

/** getHistory 返回结构（含 historyTruncated 标志，N1 修复） */
export interface HistoryResult {
  messages: Message[]
  historyTruncated: boolean
}

/**
 * 拉取 session 历史（UC-2 切换 session 时回填 message-stream）。
 * runtime reply envelope 是 `{ sessionId, messages, historyTruncated }`，
 * historyTruncated=true 表示文件尾读截断了早期 turn（前端据此显隐「加载更多」）。
 */
export async function getHistory(sessionId: string): Promise<HistoryResult> {
  const reply = await command('session.history', { sessionId })
  return { messages: reply.messages, historyTruncated: reply.historyTruncated }
}

/**
 * W4 H4：全量拉取 session 历史（加载更多 fallback）。
 * 走 session.getFullHistory → runtime getFullHistory（全量文件读取，非尾读）。
 */
export async function getFullHistory(sessionId: string): Promise<Message[]> {
  const reply = await command('session.getFullHistory', { sessionId })
  return reply.messages
}

/** 发送消息（mock 不模拟失败，D7） */
export function send(sessionId: string, text: string): Promise<void> {
  return command('message.send', { sessionId, content: text })
}

/** 追加 steer（当前回合工具调用结束后、下次 LLM 调用前投递） */
export function steer(sessionId: string, text: string): Promise<void> {
  return command('message.steer', { sessionId, content: text })
}

/** 追加 follow-up（当前回合结束后开新轮） */
export function followUp(sessionId: string, text: string): Promise<void> {
  return command('message.follow_up', { sessionId, content: text })
}

/**
 * 压缩上下文（#6：触发 runtime session.compact）。
 * runtime 生命周期推送：session.compacting（开始）→ session.compacted（完成/失败）。
 * 这些广播走 session 通道，由 useChat 的会话级订阅消费，驱动 store 的 isCompacting 状态。
 *
 * 超时 300s：对齐 runtime rpc-client 的 COMPACT_TIMEOUT_MS（大上下文压缩需数分钟），
 * 默认 65s 超时会在大 session 压缩时误 reject。
 */
export function compact(sessionId: string, customInstructions?: string): Promise<void> {
  return command('session.compact', { sessionId, customInstructions }, COMPACT_TIMEOUT_MS)
}

/** 中断当前回合（DEFERRED 流转，§9 G-025） */
export function abort(sessionId: string): Promise<void> {
  return command('message.abort', { sessionId })
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
