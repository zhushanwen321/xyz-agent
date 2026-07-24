
/**
 * 会话状态图标 + 派生逻辑（R2 logic 层 SSOT）。
 *
 * SessionItem（sidebar）、PanelHeader、SessionCard（overview）共用同一 9 态 → 图标/颜色/动画映射，
 * 收敛到此避免多处复制粘贴漂移。语义色取自 design-tokens（CSS 变量），不硬编码十六进制色。
 *
 * deriveStatus（D6 → 方案 C 优化版 9 态）原位于 useSidebar（features 层），
 * 2026-07-02 架构返工 C3 下沉到 logic 层：它是纯函数（读 chat store 分区），
 * 不依赖任何 composable 闭包 / 副作用，放 logic 层与 STATUS_ICON/DOT_CLASS 同源（8 态 SSOT 聚合）。
 * useSidebar 与 useSessionDerivations 都从此 import，避免逻辑两份。
 */
import type { SessionStatus } from '@xyz-agent/shared'
import type { DerivedStatus } from '@/types'
import type { useChatStore } from '@/stores/chat'

export type { DerivedStatus }

/**
 * 状态点语义类：背景色（9 态）。
 * 活跃态在组件层改用语义图标 + 动画，圆点仅作为静态 fallback / overview 等处的点状指示。
 */
export const DOT_CLASS: Record<DerivedStatus, string> = {
  streaming: 'bg-accent',
  pending: 'bg-accent',
  compacting: 'bg-accent',
  working: 'bg-accent',
  waiting: 'bg-warning',
  retrying: 'bg-warning',
  done: 'bg-success',
  stopped: 'bg-subtle opacity-50',
  error: 'bg-danger',
}

/**
 * 状态 → 语义图标配置（方案 C 优化版 v3 + working）。
 * icon: lucide 图标名（与 @lucide/vue 导出同名）。
 * color: Tailwind 语义色类（text-*）。
 * animation: 动画类（'' 表示静态）。
 */
export const STATUS_ICON: Record<
  DerivedStatus,
  { icon: string; color: string; animation: string }
> = {
  streaming: { icon: 'RefreshCw', color: 'text-accent', animation: 'animate-spin' },
  pending: { icon: 'ArrowUpCircle', color: 'text-accent', animation: 'animate-bounce-small' },
  compacting: { icon: 'Hourglass', color: 'text-accent', animation: 'animate-spin' },
  working: { icon: 'RefreshCw', color: 'text-accent', animation: 'animate-spin' },
  waiting: { icon: 'Wrench', color: 'text-warning', animation: 'animate-wiggle' },
  retrying: { icon: 'Zap', color: 'text-warning', animation: 'animate-pulse-strong' },
  done: { icon: 'CheckCircle2', color: 'text-success', animation: '' },
  stopped: { icon: 'Ban', color: 'text-muted', animation: '' },
  error: { icon: 'AlertCircle', color: 'text-danger', animation: '' },
}

/**
 * 取状态点 class（组件 dotClass computed 的纯函数等价物）。
 * 组件可直接 DOT_CLASS[status] 或经此 helper，二者等价；提供 helper 便于未来加 guard / fallback。
 */
export function statusDotClass(status: DerivedStatus): string {
  return DOT_CLASS[status]
}

/**
 * 活跃态用转菊花（Loader2 + animate-spin）替代脉冲圆点的旧行为已迁移到 STATUS_ICON。
 * 以下常量保留仅作向后兼容：历史组件若仍消费 shouldShowSpinner / spinnerTextClass，
 * 行为与旧态一致（running/waiting/working 显示 spinner）。
 * 新组件建议直接消费 STATUS_ICON。
 */
export const SPINNER_STATUSES: ReadonlySet<DerivedStatus> = new Set(['streaming', 'waiting', 'working'])

export function shouldShowSpinner(status: DerivedStatus): boolean {
  return SPINNER_STATUSES.has(status)
}

/** spinner 图标色（streaming/working→accent 蓝，waiting→warning 橙） */
export const SPINNER_TEXT_CLASS: Record<'streaming' | 'waiting' | 'working', string> = {
  streaming: 'text-accent',
  waiting: 'text-warning',
  working: 'text-accent',
}

/** spinner 适用状态联合（用于类型收窄） */
export type SpinnerStatus = 'streaming' | 'waiting' | 'working'

/**
 * 类型守卫：status 是否为 spinner 适用状态（streaming / waiting）。
 * 收窄后可安全索引 SPINNER_TEXT_CLASS。
 */
export function isSpinnerStatus(status: DerivedStatus): status is SpinnerStatus {
  return SPINNER_STATUSES.has(status)
}

/**
 * 取 spinner 图标色 class（类型安全封装）。
 * isSpinnerStatus 收窄后安全索引 SPINNER_TEXT_CLASS，消除组件侧 `as` 断言。
 */
export function spinnerTextClass(status: DerivedStatus): string | null {
  return isSpinnerStatus(status) ? SPINNER_TEXT_CLASS[status] : null
}

/**
 * 派生信号 → DerivedStatus 映射依据（9 态）。
 * 优先级：waiting > retrying > compacting > streaming > working > pending > error > stopped > done。
 *
 * - toolCall.status 'running' → waiting（tool 执行中/待审批，agent 暂停）
 * - hasAskUserPending → waiting（ask-user 富交互等用户输入，agent 阻塞；走 extension.ui_request
 *   通道不产生 toolCall running，需独立判定，与 toolCall waiting 并列最高优先级）
 * - chat.retryStates 存在 → retrying（自动重试中）
 * - isCompacting → compacting（上下文压缩中）
 * - isGenerating 或 Message.status 'streaming' → streaming（文本流式）
 * - hasBackgroundWork → working（主 turn 结束但有 background subagent/workflow 仍在跑）
 * - isActive（仅 pendingSend）→ pending（已提交待确认）
 * - Message.status 'error' → error
 * - Message.isInterrupted → stopped（用户 abort / 进程退出）
 */
const ERROR_STATUS = 'error'
const STREAMING_STATUS = 'streaming'
const TOOL_RUNNING = 'running'

/**
 * 派生 session 9 态。
 *
 * [W1] isActive 作为 UI 层 SSOT：消除提交后到 message_start 之间空窗期的状态不一致。
 * isActive 包含 pendingSend（用户已提交但 pi 未确认）+ isGenerating（streaming 实体存在）。
 * 取代原 isStreaming 参数，不再受 activeId 限定。
 *
 * [W6] metaStatus：未 hydrate session（messages 为空）的终态兜底。去全量预 hydrate 后，
 * 侧栏未访问的 session 无消息历史，靠 runtime session_end 元数据（done/error/stopped）兜底。
 * 瞬态（streaming/compacting/waiting/...）由 chat store 的 Set 派生，不依赖 metaStatus。
 *
 * @param sessionId 目标 session
 * @param chat chat store 实例（读 getMessages / getRetryState / isGenerating 分区）
 * @param isActive 该 session 是否活跃（pendingSend ∨ isGenerating）
 * @param isCompacting 该 session 是否处于 compact 互斥态
 * @param hasBackgroundWork 该 session 是否有 background subagent/workflow 仍在 running/paused
 * @param metaStatus runtime session 元数据 status（未 hydrate 兜底用，W6）
 * @param hasAskUserPending 该 session 是否有 ask-user 富交互请求 pending（CW wave
 *   `session-active-ssot` T3）。ask-user 走 extension.ui_request 通道，不产生 toolCall
 *   running，故需独立于 toolCall 的 waiting 判定；优先级最高（agent 阻塞等用户输入）。
 */
export function deriveStatus(
  sessionId: string,
  chat: ReturnType<typeof useChatStore>,
  isActive: boolean,
  isCompacting = false,
  hasBackgroundWork = false,
  metaStatus?: SessionStatus,
  hasAskUserPending = false,
): DerivedStatus {
  const msgs = chat.getMessages(sessionId)
  const last = msgs[msgs.length - 1]

  // 等待工具执行/审批（最优先：工具阻塞时即使后面有流式也不应显示 streaming）
  if (last?.role === 'assistant') {
    const tools = last.toolCalls ?? []
    if (tools.length > 0 && tools[tools.length - 1].status === TOOL_RUNNING) {
      return 'waiting'
    }
  }

  // ask-user pending → waiting（与 toolCall waiting 并列最高优先级）。
  // ask-user 走 extension.ui_request 通道不产生 toolCall running，需独立判定：
  // agent 阻塞等待用户回答期间，即使后续有流式文本/重试态也不应脱离 waiting（用户输入优先）。
  if (hasAskUserPending) return 'waiting'

  // 自动重试中
  if (chat.getRetryState?.(sessionId)) {
    return 'retrying'
  }

  // 上下文压缩中
  if (isCompacting) return 'compacting'

  // 文本流式生成中
  if (chat.isGenerating(sessionId) || last?.status === STREAMING_STATUS) return 'streaming'

  // 主 turn 结束但有 background subagent/workflow 仍在 running/paused
  if (hasBackgroundWork) return 'working'

  // 已提交、等待 pi 确认（pendingSend 空窗期）
  if (isActive) return 'pending'

  // W6：未 hydrate（messages 为空）→ 用元数据终态兜底，无则 done。
  // 瞬态（streaming/compacting/waiting/retrying/pending）已在上方分支处理，
  // 此处仅处理无消息历史的终态显示。
  if (!last) {
    if (metaStatus === 'error') return 'error'
    if (metaStatus === 'stopped') return 'stopped'
    return 'done'
  }
  if (last.status === ERROR_STATUS) return 'error'
  if (last.role === 'assistant' && last.isInterrupted) return 'stopped'
  return 'done'
}
