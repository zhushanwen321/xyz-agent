/**
 * code-skeleton: shared/protocol.ts —— send.rejected WS 类型契约（#1）
 *
 * 对应 packages/shared/src/protocol.ts 改动：
 * - ServerMessageType union 追加 'send.rejected'
 * - ServerMessageMapBase 追加 'send.rejected': SendRejectedPayload
 *
 * 接线层级：跨模块 port（runtime 构造 / renderer 消费）。
 * 这是契约层，无运行时逻辑，骨架即终态类型定义。
 *
 * 编译说明：本骨架镜像真实 protocol.ts 的类型结构。落地时把 SendRejectedPayload
 * 与 'send.rejected' 枚举值合并进真实 ServerMessageType / ServerMessageMapBase。
 */
export type { ServerMessageType } from '@xyz-agent/shared'

// ── 新增：send.rejected 类型契约（#1 AC-1.1）──

/** 拒绝原因。当前仅 'busy'（agent 正在生成）。终态操作反馈，不再扩展。 */
export type SendRejectedReason = 'busy'

/**
 * send.rejected payload（runtime → renderer 防御性反馈通道）。
 *
 * 语义：操作拒绝（busy 时发送），区别于 message.error（流终止）。
 * 不进对话流（effects 注册表无 send.rejected 映射），不翻流式态（isGenerating 不变）。
 * useChat 收到后回滚 pendingSend + toast。
 */
export interface SendRejectedPayload {
  /** 路由用 sessionId（必填，dispatchSession 按 payload.sessionId 路由到 session 通道） */
  sessionId: string
  /** 拒绝原因（D-009 runtime 预检命中 = 'busy'） */
  reason: SendRejectedReason
  /** 人类可读反馈（toast 文案，如「Agent 正在处理」） */
  message: string
}

// 落地说明：在真实 ServerMessageType union 末尾追加：
//   | 'send.rejected'
// 在真实 ServerMessageMapBase 追加精确条目（非 Record<string,unknown> 占位）：
//   'send.rejected': SendRejectedPayload
