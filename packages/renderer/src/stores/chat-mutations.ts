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
