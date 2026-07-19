/**
 * messages ref 的不可变写入 helper（W1 shallowRef 适配）。
 *
 * 背景：chat store 的 messages 改用 shallowRef 后，Map mutation（messages.value.set）不再
 * 触发响应式更新——shallowRef 只对 .value 整体替换敏感。所有 messages 写入必须改为
 * "新 Map → set → 赋值 .value"的不可变范式，才能触发 W2 的 streamingSessionIds computed
 * 重算及所有 messages 消费点的响应式更新。
 *
 * 本 helper 收敛 messages 写入的不可变写法，避免散落的手动 new Map 调用。
 * 与原有的"新对象 → 新数组"不可变范式对齐（数组层早已不可变，Map 层此前靠深 ref 的
 * mutation 触发，shallowRef 下改为整体替换）。
 */

import type { Message } from '@xyz-agent/shared'

/** messages ref 的结构类型（兼容 Vue Ref 与裸 { value } 结构） */
export type MessagesRef = { value: Map<string, Message[]> }

/**
 * 不可变写入：构造新 Map，set 后整体赋值 .value，触发 shallowRef 响应式。
 * 替代 `messages.value.set(sid, next)`（shallowRef 下 Map mutation 不触发）。
 */
export function commitMessages(
  messages: MessagesRef,
  sessionId: string,
  next: Message[],
): void {
  messages.value = new Map(messages.value).set(sessionId, next)
}

/**
 * 不可变删除：构造新 Map，delete 后整体赋值 .value，触发 shallowRef 响应式。
 * 替代 `messages.value.delete(sid)`（shallowRef 下 Map mutation 不触发）。
 *
 * 与 commitMessages 对称的删除入口——所有 messages 写入（含 delete）收敛到本模块，
 * 不再散落 `messages.value = new Map(...)`。LRU 驱逐（chat-lru.deleteMessageKey）经此 helper。
 *
 * 类型参数 V 默认 Message[]，但允许泛化（chat-lru 的 deps 用 Map<string, unknown> 宽类型）。
 */
export function deleteMessages<V = Message[]>(messages: { value: Map<string, V> }, sessionId: string): void {
  const next = new Map(messages.value)
  next.delete(sessionId)
  messages.value = next
}

/**
 * 截断 session 消息到 messageId（模块级，从 chat.ts 移入控制行数）。
 * inclusive=true 含 messageId，false 仅其后。findIndex 定位，slice 不可变更新。
 */
export function truncateMessagesFrom(
  messages: MessagesRef,
  sessionId: string,
  messageId: string,
  inclusive: boolean,
): void {
  const prev = messages.value.get(sessionId) ?? []
  const idx = prev.findIndex((m) => m.id === messageId)
  if (idx === -1) return
  const end = inclusive ? idx : idx + 1
  commitMessages(messages, sessionId, prev.slice(0, end))
}

/**
 * W4 H4：全量历史去重合并到列表头部（模块级，从 chat.ts 移入控制行数）。
 * 按 messageId 去重，幂等（无新消息不触发写入）。
 */
export function prependHistory(
  messages: MessagesRef,
  sessionId: string,
  fullHistory: Message[],
): void {
  const prev = messages.value.get(sessionId) ?? []
  const existingIds = new Set(prev.map((m) => m.id))
  const newMsgs = fullHistory.filter((m) => !existingIds.has(m.id))
  if (newMsgs.length === 0) return
  commitMessages(messages, sessionId, [...newMsgs, ...prev])
}
