/**
 * useForkNoticeStream —— ForkNotice 反馈行的消费 + 交互编排（从 MessageStream.vue 拆出）。
 *
 * 职责（单一变化轴「ForkNotice 反馈行渲染数据」，原 misplaced 在容器组件 MessageStream.vue 内）：
 * - forkNotices：当前 session 的 ForkNotice 列表（响应式，读 useForkNoticeFeed 的模块级单例 feed）。
 * - onView(newSessionId)：点击「查看」→ 跳转到分支 session（selectSession 载入 panel）。
 * - onDismiss(noticeId)：点击关闭 × → 移除该条通知。
 *
 * 不含：feed 推送/订阅（bindForkNoticeEffect 负责，App.vue 全局注册）、ForkNotice 渲染 DOM（模板）。
 *
 * [D6 死路径清理 2026-09-09] absolute 定位链已整体删除：原 forkNoticeTop(idx) /
 * forkNoticeBaseTop / injectedBaseTop 注入 / 占位 deps（vlistBottom/topOffset/isCompacting/
 * isDispatching/hasWorkingTurn/compactNoticeHeight）——生产双重不触发（forkNoticeTop 不被
 * 模板消费 + injectedBaseTop 短路），ForkNotice 实为文档流 block，定位由文档序自然堆叠
 * （见 MessageStream.vue tailEl 容器）。消费方接线相应收窄为单 sessionId 参数。
 *
 * @param sessionId 当前 session id（forkNotices 过滤 + onDismiss 路由键）
 */
import { computed, type ComputedRef, type DeepReadonly } from 'vue'
import { useForkNoticeFeed, type ForkNoticeEntry } from '@/composables/effects/useForkNoticeEffect'
import { useSidebar } from '@/composables/features/sidebar/useSidebar'

/**
 * ForkNotice 反馈行消费 + 交互编排。
 * 读 useForkNoticeFeed 的模块级单例 feed（bindForkNoticeEffect 推送，跨 MessageStream 实例共享）。
 */
export function useForkNoticeStream(
  sessionId: () => string,
): {
  /** 当前 session 的 ForkNotice 列表（响应式，feed 变化自动更新） */
  forkNotices: ComputedRef<DeepReadonly<ForkNoticeEntry[]>>
  /** 点击查看 → 跳转到分支 session（selectSession 载入 panel） */
  onView: (newSessionId: string) => void
  /** 点击关闭 × → 移除该条通知 */
  onDismiss: (noticeId: number) => void
  } {
  const { notices: forkNoticeFeed, dismissNotice: dismissForkNotice } = useForkNoticeFeed()
  // [W6] 顶层实例化 useSidebar：避免在 onView 回调内每次新建实例（composable 工厂模式反模式）。
  const { selectSession } = useSidebar()

  /** 当前 session 的 ForkNotice 列表（响应式，feed 变化自动更新） */
  const forkNotices = computed(() => forkNoticeFeed(sessionId()))

  /** 点击查看 → 跳转到分支 session（selectSession 载入 panel） */
  function onView(newSessionId: string): void {
    void selectSession(newSessionId)
  }

  /** 点击关闭 × → 移除该条通知 */
  function onDismiss(noticeId: number): void {
    dismissForkNotice(sessionId(), noticeId)
  }

  return { forkNotices, onView, onDismiss }
}
