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
import type { Message, Segment, ServerMessageUnion } from '@xyz-agent/shared'

/**
 * chat 域后端操作端口。
 * 壳侧实现：renderer 现 api/domains/chat（函数集组装成对象注入）。
 */
export interface ChatApiPort {
  /** 发送消息（message.send RPC）*/
  send(sessionId: string, promptText: string): Promise<void>
  /**
   * subagent 定向消息 / 生命周期操作（session.subagentAction RPC，composer 四符号 `@` 发送分流）。
   * 契约对齐 renderer api/domains/session.subagentAction（U5 扩签名）：action='message' 带
   * subagentId+text（已开 subagent 追问），'start' 带 slug+task（新建占位 chip），'cancel' 本域
   * 不消费（stores/subagent.ts 直调，此处不省略联合成员以保持 wire 协议单点）。
   * 实现在 session 域（语义归属 session.subagentAction），经本端口暴露给 chat 域发送链路
   * （useChat 分流点），与 writeSegments 的跨域注入同理。
   */
  subagentAction(
    sessionId: string,
    action: 'cancel' | 'message' | 'start',
    params: { subagentId?: string; text?: string; slug?: string; task?: string },
  ): Promise<void>
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
  /** 订阅指定 session 的流式消息事件，返回取消函数。
   *  handler 收分发联合形态的 ServerMessageUnion——switch on msg.type 自动收窄 payload，
   *  ServerMessageMap 登记缺口变编译错误（R1 type-safety S4/S5，消费侧不再 as）。*/
  streamSubscribe(sessionId: string, handler: (msg: ServerMessageUnion) => void): () => void
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
