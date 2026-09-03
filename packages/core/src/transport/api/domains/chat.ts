/**
 * Chat 域 —— send/abort/streamSubscribe。
 *
 * 依赖方向：command（RPC，send/abort/steer/followUp/compact/getHistory）+ events（streamSubscribe 路由）。
 *
 * 注意：streamSubscribe 的 handler 参数类型是 ServerMessageUnion（shared 协议类型），
 * 不臆造 StreamChunk。调用方在 handler 内过滤 message.text_delta 等事件。
 * 注：mock 模式下不走本域（api/index 切到 mock 门面）。
 */
import type { Message, ServerMessageUnion } from '@xyz-agent/shared'
import { command as sendCommand } from '../request'
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
  const reply = await sendCommand('session.history', { sessionId })
  return { messages: reply.messages, historyTruncated: reply.historyTruncated }
}

/**
 * W4 H4：全量拉取 session 历史（加载更多 fallback）。
 * 走 session.getFullHistory → runtime getFullHistory（全量文件读取，非尾读）。
 */
export async function getFullHistory(sessionId: string): Promise<Message[]> {
  const reply = await sendCommand('session.getFullHistory', { sessionId })
  return reply.messages
}

/**
 * 发送消息（mock 不模拟失败，D7）。
 *
 * images 是 Cmd+V 富呈现通路的图片数据（base64，不含 data: 前缀），形状对齐
 * shared protocol message.send（protocol.ts:199 images?: Array<{data;mimeType}>）。
 * runtime rpc-client 已守卫空数组（rpc-client.ts:430 images.length>0 才组 piImages），
 * 故此处 images 为 undefined 时直接不传 images 键（保持既有 payload 形态不变）。
 */
export function send(
  sessionId: string,
  text: string,
  images?: Array<{ data: string; mimeType: string }>,
): Promise<void> {
  return sendCommand(
    'message.send',
    images ? { sessionId, content: text, images } : { sessionId, content: text },
  )
}

/** 追加 steer（当前回合工具调用结束后、下次 LLM 调用前投递） */
export function steer(sessionId: string, text: string): Promise<void> {
  return sendCommand('message.steer', { sessionId, content: text })
}

/** 追加 follow-up（当前回合结束后开新轮） */
export function followUp(sessionId: string, text: string): Promise<void> {
  return sendCommand('message.follow_up', { sessionId, content: text })
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
  return sendCommand('session.compact', { sessionId, customInstructions }, COMPACT_TIMEOUT_MS)
}

/** 中断当前回合（DEFERRED 流转，§9 G-025） */
export function abort(sessionId: string): Promise<void> {
  return sendCommand('message.abort', { sessionId })
}

/**
 * 直接执行 bash 命令（composer-bash-execute，不经 LLM turn）。
 *
 * `!`/`!!` 前缀输入的 shell 文本原样透传 pi bash RPC，结果经 message.bashStart/
 * message.bashResult 广播回对话流（不走 segment 提取 / segmentsToPrompt）。
 *
 * excludeFromContext 为 undefined 时只传 {sessionId, command}（与 send 的 images 空数组
 * 归一模式对称，避免 runtime 收到无意义的 excludeFromContext:false 键）。
 */
export function bash(
  sessionId: string,
  command: string,
  excludeFromContext?: boolean,
): Promise<void> {
  return sendCommand(
    'message.bash',
    excludeFromContext !== undefined ? { sessionId, command, excludeFromContext } : { sessionId, command },
  )
}

/** 取消进行中的 bash 执行（调 pi abort_bash） */
export function abortBash(sessionId: string): Promise<void> {
  return sendCommand('message.abortBash', { sessionId })
}

/**
 * 订阅指定 session 的流式消息事件，返回取消函数。
 * handler 收到分发联合形态的 ServerMessageUnion（type↔payload 配对由 ServerMessageMap 契约保证），
 * 调用方 switch on msg.type 即自动收窄 payload，无需 `as`。
 */
export function streamSubscribe(
  sessionId: string,
  handler: (msg: ServerMessageUnion) => void,
): () => void {
  // 类型边界转换（R1 type-safety S5）：events 层存储统一宽 ServerMessage（wire 入口
  // isServerMessage 守卫的下游），本域出口收窄为分发联合。二者是同一 wire 形状的两种 TS
  // 表达（值域相同），type↔payload 配对由 runtime 构造侧按 ServerMessageMap 契约构造 +
  // shared 登记静态校验保证——消费端从此不再散点 as payload。
  return events.on(sessionId, (msg) => handler(msg as ServerMessageUnion))
}
