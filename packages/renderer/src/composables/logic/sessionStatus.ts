/**
 * 会话状态点配色 + 派生逻辑（R2 logic 层 SSOT）。
 *
 * SessionItem（sidebar）与 SessionCard（overview）共用同一 5 态 → Tailwind 语义类映射，
 * 收敛到此避免两处复制粘贴漂移。语义色取自 design-tokens（CSS 变量），不硬编码十六进制色。
 *
 * running/waiting 用同心环 pulse 动画（@keyframes 收敛在 tailwind.config）；
 * done/stopped/error 静态色。
 *
 * deriveStatus（D6 5 态纯派生）原位于 useSidebar（features 层），
 * 2026-07-02 架构返工 C3 下沉到 logic 层：它是纯函数（读 chat store 分区末尾消息），
 * 不依赖任何 composable 闭包 / 副作用，放 logic 层与 DOT_CLASS 同源（5 态 SSOT 聚合）。
 * useSidebar 与 useSessionDerivations 都从此 import，避免逻辑两份。
 */
import type { DerivedStatus } from '@/types'
import type { useChatStore } from '@/stores/chat'

export type { DerivedStatus }

/**
 * 状态点语义类：背景色 + 脉冲动画（D6 五态）。
 * 与 tailwind.config 的 keyframes（pulse-accent / pulse-warn）配合。
 */
export const DOT_CLASS: Record<DerivedStatus, string> = {
  running: 'bg-accent animate-pulse-accent',
  waiting: 'bg-warning animate-pulse-warn',
  done: 'bg-success',
  stopped: 'bg-subtle opacity-50',
  error: 'bg-danger',
}

/**
 * 取状态点 class（组件 dotClass computed 的纯函数等价物）。
 * 组件可直接 DOT_CLASS[status] 或经此 helper，二者等价；提供 helper 便于未来加 guard / fallback。
 */
export function statusDotClass(status: DerivedStatus): string {
  return DOT_CLASS[status]
}

/**
 * 活跃态用转菊花（Loader2 + animate-spin）替代脉冲圆点。
 * running（文本流式/pendingSend/compact）+ waiting（tool 执行中/待审批）
 * 都是 turn 活跃期，转菊花比 box-shadow 脉冲在密集列表里更醒目。
 * done/stopped/error 保持静态圆点。
 */
export const SPINNER_STATUSES: ReadonlySet<DerivedStatus> = new Set(['running', 'waiting'])

export function shouldShowSpinner(status: DerivedStatus): boolean {
  return SPINNER_STATUSES.has(status)
}

/** spinner 图标色（running→accent 蓝，waiting→warning 橙） */
export const SPINNER_TEXT_CLASS: Record<'running' | 'waiting', string> = {
  running: 'text-accent',
  waiting: 'text-warning',
}

/**
 * 派生信号 → DerivedStatus 映射依据（D6，spec §5 D6 + §会话项）。
 * - toolCall.status 'running' → waiting（tool 执行中/待审批，agent 暂停）
 * - isStreaming 或 Message.status 'streaming' → running（文本流式）
 * - Message.status 'error' → error
 * - Message.isInterrupted → stopped（用户 abort / 进程退出）
 */
const ERROR_STATUS = 'error'
const STREAMING_STATUS = 'streaming'
const TOOL_RUNNING = 'running'

/**
 * 派生 session 5 态（D6）。
 * 优先级：waiting > running > error > stopped > done。
 * waiting 优先于 running：turn 活跃期 tool 执行属 waiting（无文本流），spec 区分二者。
 * 空消息（无回合）→ done。
 *
 * [W1] isActive 作为 UI 层 SSOT：消除提交后到 message_start 之间空窗期的状态不一致。
 * isActive 包含 pendingSend（用户已提交但 pi 未确认）+ isGenerating（streaming 实体存在）。
 * 取代原 isStreaming 参数，不再受 activeId 限定。
 *
 * @param sessionId 目标 session
 * @param chat chat store 实例（读 getMessages 分区）
 * @param isActive 该 session 是否活跃（pendingSend ∨ isGenerating）
 * @param isCompacting 该 session 是否处于 compact 互斥态（独立于 isActive，视觉态属 running）
 */
export function deriveStatus(
  sessionId: string,
  chat: ReturnType<typeof useChatStore>,
  isActive: boolean,
  isCompacting = false,
): DerivedStatus {
  const msgs = chat.getMessages(sessionId)
  const last = msgs[msgs.length - 1]
  if (last?.role === 'assistant') {
    const tools = last.toolCalls ?? []
    if (tools.length > 0 && tools[tools.length - 1].status === TOOL_RUNNING) {
      return 'waiting'
    }
  }
  if (isActive || isCompacting || last?.status === STREAMING_STATUS) return 'running'
  if (!last) return 'done'
  if (last.status === ERROR_STATUS) return 'error'
  if (last.role === 'assistant' && last.isInterrupted) return 'stopped'
  return 'done'
}
