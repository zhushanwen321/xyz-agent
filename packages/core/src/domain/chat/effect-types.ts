/**
 * message.* 事件 effect 类型（从 renderer chat-message-effects.ts 提前抽取，IF2）。
 *
 * 抽取动机：bash-effects.ts 的 bashStartEffect/bashResultEffect 参数依赖
 * MessageEffectContext/MessageEffectHandler，原定义在 renderer chat-message-effects.ts
 * （w3 才拆）。为让 bash-effects.ts 能迁入 core 且单一来源，把这两个类型提前抽到此文件。
 * renderer chat-message-effects.ts 改 import type from '@xyz-agent/core' + re-export。
 *
 * 内容原样搬迁（含注释），零语义改动。
 */
import type {
  ChangeSetStatus,
  FileChange,
  PiEntry,
  Segment,
  SteerFollowUpMode,
} from '@xyz-agent/shared'
import type { RetryState, QueueState, FinalizeReason } from './store-types'
import type { MessagesRef } from './mutations'

/**
 * message.* 事件副作用上下文（store refs + 跨方法回调，模块级函数据此更新）。
 *
 * - messages/retryStates/queueStates：原 ChunkContext，chunk 状态写入目标。
 * - applyFileChanges/markChangeSetsSuperseded：原 ChunkContext 回调（store 内合并逻辑）。
 * - finalizeSession + clearPendingSend：统一收口出口（替代 setStreaming flag 翻转）。
 */
export interface MessageEffectContext {
  /** D-1 容器范式：读数组需 `.value.get(sid)?.value ?? []`（内层是 per-session ShallowRef） */
  messages: MessagesRef
  retryStates: { value: Map<string, RetryState> }
  queueStates: { value: Map<string, QueueState> }
  /** file_changes case 调 store.applyFileChanges（合并逻辑在 store 内） */
  applyFileChanges: (
    sessionId: string,
    messageId: string,
    changes: FileChange[],
    changeSetStatus: ChangeSetStatus,
    isFullSet: boolean,
  ) => void
  /** changeSetInvalidated case 调 store.markChangeSetsSuperseded（commit 后旧卡片过期） */
  markChangeSetsSuperseded: (sessionId: string) => void
  /** 统一收口出口（替代 setStreaming）。终态 handler 调。
   *  reason 决定终态映射；handler 自己改 entity status 后调此方法（幂等：entity 已终态则 no-op，
   *  只清 pendingSend + timer）。errorText 可选：error/stream_error 时写入。 */
  finalizeSession: (sessionId: string, reason: FinalizeReason, errorText?: string) => void
  /** message_start 清空窗（替代 setStreaming 隐式清 dispatching）。 */
  clearPendingSend: (sessionId: string) => void
  /** message_start 挂载 streaming 超时兜底 timer（防 complete 永不到的 pi 静默卡死）。 */
  armStreamingTimer: (sessionId: string) => void
  /** bashStartEffect 挂载 bash 专用超时 timer（防 bash RPC 卡死永久 streaming）。 */
  armBashTimer: (sessionId: string) => void
  /** bashResultEffect/markBashError 终态时清 bash 超时 timer（防 300s 后误触发，W3 遗留 bug）。 */
  clearBashTimer: (sessionId: string) => void
  /**
   * 追加 user 消息（Segment[]，ADR-0043）。
   * m2 阶段 queue_update 投递时经 drainPending 取 segments 后 appendUser 进对话流。
   */
  appendUser: (sessionId: string, segments: Segment[]) => string
  /**
   * queue_update 投递信号：FIFO 取出匹配 pending segments（m1 数据层）。
   * queue_update handler 经 drainPending 取 segments + appendUser 进对话流。
   */
  drainPending: (sessionId: string, text: string, sendMode?: SteerFollowUpMode) => Segment[] | undefined
  /**
   * [W21] 重构 entry 喂 store 内 per-session reducer state（applyEntry）。
   * message_end / tool_call_end 等 entry 载体帧的 handler 经此把实时 feed 喂入与文件重放
   * （get_entries → replayEntries）同一个 reducer——effects 退化为 reducer 薄封装（状态类
   * 全走 reducer，副作用类保留 effect）。实现在 store.applyEntryFrame。
   */
  applyEntryFrame: (sessionId: string, entry: PiEntry) => void
}

/**
 * 单个 message.* type 的 effect handler。
 *
 * 签名约定：接收上下文 + sessionId + payload，内部执行该 type 的全部副作用
 * （chunk 状态更新 + lifecycle flag）。返回值无意义（统一 void）。
 *
 * payload 类型：ADR-0016 类型基础。ServerMessageMap 对多数 message.* 用
 * Record<string, unknown> 占位（未收紧），handler 内用 readString 等安全窄化，
 * 与原 applyChunk 完全一致（不引入 any）。
 */
export type MessageEffectHandler = (
  ctx: MessageEffectContext,
  sessionId: string,
  payload: Record<string, unknown>,
) => void
