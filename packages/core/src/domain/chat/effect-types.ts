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
  Message,
  SteerFollowUpMode,
} from '@xyz-agent/shared'
import type { RetryState, QueueState, FinalizeReason } from './store-types'

/**
 * message.* 事件副作用上下文（store refs + 跨方法回调，模块级函数据此更新）。
 *
 * - messages/retryStates/queueStates：原 ChunkContext，chunk 状态写入目标。
 * - applyFileChanges/markChangeSetsSuperseded：原 ChunkContext 回调（store 内合并逻辑）。
 * - finalizeSession + clearPendingSend：统一收口出口（替代 setStreaming flag 翻转）。
 */
export interface MessageEffectContext {
  messages: { value: Map<string, Message[]> }
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
  /** queue_update 投递信号 */
  markPendingDelivered: (sessionId: string, text: string, sendMode?: SteerFollowUpMode) => void
  /**
   * 首个 todo/goal 数据写入 tasks store 后触发 panel 打开编排（renderer 注入实现）。
   *
   * renderer 实现衔接 useSideDrawer().open('tasks') / usePanelStore().focusedSessionId /
   * setPendingOpenForSid（原 chat-message-effects.openTasksDrawerOnFirstData 逐字逻辑）。
   * core effects 仅负责「写入前快照 hadDataBefore + 写入 tasks store + 调本回调」，
   * panel/sideDrawer/focused 判断全在 renderer 侧（保持 pendingOpenMap 单一，避免 core/renderer
   * Map 分裂）。PanelOrchestrationPort 的统一接线属 session/sidebar 域 wave。
   *
   * hadDataBefore：core 写入 tasks store 前快照（hadDataBefore=true → 非首次 → 不弹）。
   */
  openTasksPanelOnFirstData: (sessionId: string, hadDataBefore: boolean) => void
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
