/**
 * Bash 执行相关 message effect（composer-bash-execute W3）。
 *
 * 从 chat-message-effects.ts 巨石提取（超 500 行 ESLint max-lines）。
 *
 * - message.bashStart：创建 loading 态 system 消息（status='streaming'），承载 command + excludeFromContext。
 * - message.bashResult：锢定唯一的 streaming bash 消息，更新为 complete 态（runtime isBashRunning
 *   互斥保证同时只有一个 streaming bash）。
 *
 * 与 toolCall 互斥（bash 不走工具链，不挂 assistant turn，作独立 system 消息穿插渲染）。
 */
// type-only import：编译期擦除，不构成运行时循环依赖（主文件 runtime import 本文件的 handler 值）
import type { Message, ServerMessage } from '@xyz-agent/shared'
import type { MessageEffectContext, MessageEffectHandler } from './chat-message-effects'
import { readString, readNumber, readBool } from '@xyz-agent/core'
import { commitMessages, type MessagesRef } from '@xyz-agent/core'

/** payload 读取用宽松 record（与主文件其他 effect 一致，readers 安全窄化） */
type Payload = Record<string, unknown>

/**
 * [S7 PR#116 review] 找到 messages 里最后一条 streaming bash 消息的索引（无则 -1）。
 *
 * bash 消息通常在末尾（bashResultEffect/markBashError/finalizeBashOnly 均按此假设从后搜）。
 * 此前三处各自重复 `[...prev].reverse().findIndex(m => m.bashExecution && m.status === 'streaming')`
 * + `prev.length-1-reversedIdx` 算 realIdx，逻辑漂移风险高（任一处漏改即不一致）。抽出复用。
 *
 * 判定条件：`m.bashExecution`（bash 消息标志，由 bashStartEffect 创建时设置）+ `status === 'streaming'`。
 * runtime isBashRunning 互斥保证同一 session 同时只有一个 streaming bash，故 findLast 即唯一目标。
 */
export function findLastStreamingBashIndex(messages: Message[], sessionId?: string): number {
  // sessionId 仅作日志/可读性占位，定位靠 messages 内容（与原三处实现一致）。
  void sessionId
  const reversedIdx = [...messages].reverse().findIndex(m => m.bashExecution && m.status === 'streaming')
  return reversedIdx === -1 ? -1 : messages.length - 1 - reversedIdx
}

/**
 * message.bashStart：append 一条 streaming 态 system 消息，承载 command + excludeFromContext。
 * bashResult 到达后锢定该消息（status==='streaming' + bashExecution）更新为 complete。
 *
 * [W3] 同步挂载 bash 专用超时 timer（防 pi bash RPC 卡死时消息永久 streaming）。
 * 超时后 finalizeSession('timeout') 将 bash 消息推到 error 态。
 */
export const bashStartEffect: MessageEffectHandler = (ctx: MessageEffectContext, sid: string, payload: Payload) => {
  const { messages, armBashTimer } = ctx
  const command = readString(payload, 'command') ?? ''
  const excludeFromContext = readBool(payload, 'excludeFromContext') ?? false
  const timestamp = readNumber(payload, 'timestamp') ?? Date.now()
  const prev = messages.value.get(sid) ?? []
  const bashMsg: Message = {
    id: `bash-${crypto.randomUUID()}`,
    role: 'system',
    content: '',
    status: 'streaming',
    bashExecution: { command, output: '', exitCode: null, cancelled: false, truncated: false, excludeFromContext, timestamp },
    timestamp: Date.now(),
  }
  commitMessages(messages, sid, [...prev, bashMsg])
  // [W3] 挂载 bash 专用超时 timer，防 pi bash RPC 卡死时消息永久 streaming
  armBashTimer(sid)
}

/**
 * message.bashResult：锢定唯一的 streaming bash 消息，更新为 complete 态。
 * abortBash 路径复用此 effect（cancelled=true 自动处理，无独立 abort effect）。
 *
 * [S6] 用 findLastIndex + 单点替换替代 prev.map() 全遍历（bash 消息通常在末尾）。
 */
export const bashResultEffect: MessageEffectHandler = (ctx: MessageEffectContext, sid: string, payload: Payload) => {
  const { messages, clearBashTimer } = ctx
  const prev = messages.value.get(sid) ?? []
  // [S7] 复用 findLastStreamingBashIndex，与 markBashError/finalizeBashOnly 一致。
  const realIdx = findLastStreamingBashIndex(prev, sid)
  if (realIdx === -1) return
  const target = prev[realIdx]
  const updated: Message = {
    ...target,
    status: 'complete' as const,
    bashExecution: {
      ...target.bashExecution!,
      output: readString(payload, 'output') ?? '',
      exitCode: readNumber(payload, 'exitCode') ?? null,
      cancelled: readBool(payload, 'cancelled'),
      truncated: readBool(payload, 'truncated'),
    },
  }
  const next = prev.map((m, i) => i === realIdx ? updated : m)
  commitMessages(messages, sid, next)
  // [W3 遗留 bug] bash 已终态，必须清 bash 超时 timer，否则 300s 后 timer 回调会再次
  // 触发 finalizeBashOnly 误改这条已 complete 的消息。
  clearBashTimer(sid)
}

/** 供 messageEffects 表展开的类型化入口 */
export const bashEffects: Partial<Record<ServerMessage['type'], MessageEffectHandler>> = {
  'message.bashStart': bashStartEffect,
  'message.bashResult': bashResultEffect,
}

/**
 * W2：abortBash RPC 失败时，主动将 streaming bash 消息推到 error 态。
 * bashResult 广播依赖 abortBash RPC 成功，失败时该广播不会到达，
 * bash 消息会永久卡在 streaming。此方法在 useChat.abortBash catch 中调用兜底。
 *
 * 导出为独立函数（非 effect handler），由 useChat 直接调用。
 *
 * [B2 PR#116 review] 调用方必须传入 store 真正的 messages ref（storeToRefs(chat).messages），
 * 不可传 `{ value: chat.messages }` 这样的 plain wrapper——后者只改写临时对象的 .value，
 * store 真正的 shallowRef 不会被更新（catch 形同虚设）。
 */
export function markBashError(
  messages: MessagesRef,
  sessionId: string,
  errorText: string,
  clearBashTimer?: (sid: string) => void,
): void {
  const prev = messages.value.get(sessionId) ?? []
  // [S7] 复用 findLastStreamingBashIndex，与 bashResultEffect/finalizeBashOnly 一致。
  const realIdx = findLastStreamingBashIndex(prev, sessionId)
  if (realIdx === -1) return
  const next = prev.map((m, i) => i === realIdx ? {
    ...m,
    status: 'error' as const,
    error: errorText,
    bashExecution: { ...m.bashExecution!, cancelled: true },
  } : m)
  commitMessages(messages, sessionId, next)
  // [W3 遗留 bug] bash 已 error 态，清 bash 超时 timer 防 300s 后误触发（与 bashResultEffect 一致）。
  clearBashTimer?.(sessionId)
}
