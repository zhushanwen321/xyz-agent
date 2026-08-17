/**
 * ChatApiPort —— domain/chat 访问后端的唯一通道（IF6 契约）。
 *
 * 端口注入模式（对齐 domain/session/api-port.ts）：core 定义接口，壳层（renderer）
 * 把现 api/domains/chat 适配注入。core 不 import @/api。P1 完成后 api domains 迁
 * core/transport 时只需换注入实现，domain 侧零改动。
 *
 * 契约边界：方法签名严格对齐现 packages/renderer/src/api/domains/chat.ts 导出函数
 * （send/steer/followUp/abort/compact/bash/abortBash/getHistory/getFullHistory/streamSubscribe）。
 * getHistory 返回类型用内联结构（{ messages; historyTruncated }），不依赖 renderer 的
 * HistoryResult（保持 core 平台无关）。
 */
import type { Message, Segment, ServerMessage } from '@xyz-agent/shared'

/**
 * chat 域后端操作端口。
 * 壳侧实现：renderer 现 api/domains/chat（函数集组装成对象注入）。
 */
export interface ChatApiPort {
  /** 发送消息（message.send RPC）*/
  send(sessionId: string, promptText: string): Promise<void>
  /** 追加 steer（message.steer，AI 执行中追加上下文）*/
  steer(sessionId: string, promptText: string): Promise<void>
  /** 追加 follow-up（message.follow_up，当前回合结束后另起一轮）*/
  followUp(sessionId: string, promptText: string): Promise<void>
  /** 中断当前回合（message.abort）*/
  abort(sessionId: string): Promise<void>
  /** 压缩上下文（session.compact）*/
  compact(sessionId: string, customInstructions?: string): Promise<void>
  /** 直接执行 bash 命令（message.bash，不经 LLM turn）*/
  bash(sessionId: string, command: string, excludeFromContext: boolean): Promise<void>
  /** 取消进行中的 bash（message.abortBash）*/
  abortBash(sessionId: string): Promise<void>
  /** 拉取 session 历史（session.history，尾读可能截断）*/
  getHistory(sessionId: string): Promise<{ messages: Message[]; historyTruncated: boolean }>
  /** 全量拉取 session 历史（session.getFullHistory，加载更多用）*/
  getFullHistory(sessionId: string): Promise<Message[]>
  /** 订阅指定 session 的流式消息事件，返回取消函数（handler 收原始 ServerMessage）*/
  streamSubscribe(sessionId: string, handler: (msg: ServerMessage) => void): () => void
}

/**
 * 写 segments.json sidecar（session.writeSegments RPC）。
 *
 * 独立于 ChatApiPort：writeSegments 语义属 session 域（session.writeSegments RPC），
 * useChat 只是消费者。独立类型避免塞进 ChatApiPort 造成域语义混淆。壳侧实现：
 * renderer api/domains/session.writeSegments。
 */
export type WriteSegmentsFn = (payload: {
  sessionId: string
  entry: { clientUuid: string; segments: Segment[]; timestamp: number }
}) => Promise<void>
