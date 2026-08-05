/**
 * useForkNoticeStream —— ForkNotice 反馈行的消费 + 定位编排（从 MessageStream.vue 拆出）。
 *
 * 职责（单一变化轴「ForkNotice 反馈行渲染数据」，原 misplaced 在容器组件 MessageStream.vue 内）：
 * - forkNotices：当前 session 的 ForkNotice 列表（响应式，读 useForkNoticeFeed 的模块级单例 feed）。
 * - forkNoticeTop(idx)：第 idx 条反馈行的 absolute top（列表末尾 + compacting/dispatching 占位 + 堆叠偏移）。
 * - onView(newSessionId)：点击「查看」→ 跳转到分支 session（selectSession 载入 panel）。
 * - onDismiss(noticeId)：点击关闭 × → 移除该条通知。
 *
 * 不含：feed 推送/订阅（bindForkNoticeEffect 负责，App.vue 全局注册）、ForkNotice 渲染 DOM（模板）。
 * 定位依赖（totalHeight/topOffset/isCompacting/isDispatching/hasWorkingTurn）以 getter 注入，
 * 避免与容器虚拟滚动/状态计算耦合（同 useTurnElapsed 的 getIsWorking getter 注入模式）。
 *
 * @param sessionId 当前 session id（forkNotices 过滤 + onDismiss 路由键）
 * @param deps 容器侧定位依赖（getter，每次重算读最新值）
 */
import { computed, type ComputedRef, type DeepReadonly } from 'vue'
import { useForkNoticeFeed, type ForkNoticeEntry } from '@/composables/effects/useForkNoticeEffect'
import { useSidebarNew } from '@/composables/features/sidebar/useSidebarNew'

/** ForkNotice 每条高度估算（absolute 定位 top 计算用，与 ForkNotice.vue 实际高度对齐） */
const FORK_NOTICE_HEIGHT = 40

/** 容器侧定位依赖（getter 注入，避免本 composable 反向依赖虚拟滚动/状态计算） */
export interface ForkNoticeStreamDeps {
  /** virtua 末项底部绝对 px（vlist.scrollSize），所有 abs 子项 top 的基线。 */
  vlistBottom: ComputedRef<number>
  /** load-more 预留顶部偏移（所有 abs 子项 top 基线） */
  topOffset: ComputedRef<number>
  /** 是否正在压缩（compacting notice 占位高度参与基线计算） */
  isCompacting: ComputedRef<boolean>
  /** dispatching 空窗期（dispatching 占位高度参与基线计算） */
  isDispatching: ComputedRef<boolean>
  /** 最后一个 turn 是否 working（dispatching 占位条件之一） */
  hasWorkingTurn: ComputedRef<boolean>
  /** compacting notice 占位高度（容器常量，compacting/dispatching 占位偏移量） */
  compactNoticeHeight: number
  /** [M2] 注入的 fork notice 首行基线（由 useNoticeStack 计算）。
   *  传入时跳过内部 baseTop 计算（消除 compacting/dispatching 占位叠加的重复计算，reviewer m4）。
   *  优先级高于 isCompacting/isDispatching 等占位依赖（后者降级为兜底）。 */
  injectedBaseTop?: ComputedRef<number>
}

/**
 * ForkNotice 反馈行消费 + 定位编排。
 * 读 useForkNoticeFeed 的模块级单例 feed（bindForkNoticeEffect 推送，跨 MessageStream 实例共享）。
 */
export function useForkNoticeStream(
  sessionId: () => string,
  deps: ForkNoticeStreamDeps,
): {
  /** 当前 session 的 ForkNotice 列表（响应式，feed 变化自动更新） */
  forkNotices: ComputedRef<DeepReadonly<ForkNoticeEntry[]>>
  /** 第 idx 条 ForkNotice 的 absolute top（自 baseTop 起按 FORK_NOTICE_HEIGHT 垂直堆叠） */
  forkNoticeTop: (idx: number) => number
  /** 点击查看 → 跳转到分支 session（selectSession 载入 panel） */
  onView: (newSessionId: string) => void
  /** 点击关闭 × → 移除该条通知 */
  onDismiss: (noticeId: number) => void
  } {
  const { notices: forkNoticeFeed, dismissNotice: dismissForkNotice } = useForkNoticeFeed()
  // [W6] 顶层实例化 useSidebarNew：避免在 onView 回调内每次新建实例（composable 工厂模式反模式）。
  const { selectSession } = useSidebarNew()

  /** 当前 session 的 ForkNotice 列表（响应式，feed 变化自动更新） */
  const forkNotices = computed(() => forkNoticeFeed(sessionId()))

  /**
   * ForkNotice 起始 top：列表末尾 + topOffset + compacting/dispatching 占位高度。
   * compacting / dispatching 各预留对应 notice 高度量级的占位（与容器占位块对齐）。
   * 顺序：compacting → dispatching（垂直堆叠，互不重叠）。
   *
   * [M2] 若注入 injectedBaseTop（来自 useNoticeStack），直接采用——消除占位叠加的重复计算
   * （dispatchingTop / 此 baseTop，reviewer m4）。未注入时兜底内部计算。
   *
   * [cw wave w4] 基线优先级简化为 injectedBaseTop > vlistBottom（删 totalHeight 旧路径）。
   * MessageStream.vue 注入 injectedBaseTop 短路；未注入时 base = vlistBottom（virtua 单一滚动 owner）。
   */
  const forkNoticeBaseTop = computed(() => {
    if (deps.injectedBaseTop) return deps.injectedBaseTop.value
    const base = deps.vlistBottom.value
    let top = base + deps.topOffset.value
    if (deps.isCompacting.value) top += deps.compactNoticeHeight
    if (deps.isDispatching.value && !deps.hasWorkingTurn.value) top += deps.compactNoticeHeight
    return top
  })

  /** 第 idx 条 ForkNotice 的 top（自 baseTop 起按 FORK_NOTICE_HEIGHT 垂直堆叠） */
  function forkNoticeTop(idx: number): number {
    return forkNoticeBaseTop.value + idx * FORK_NOTICE_HEIGHT
  }

  /** 点击查看 → 跳转到分支 session（selectSession 载入 panel） */
  function onView(newSessionId: string): void {
    void selectSession(newSessionId)
  }

  /** 点击关闭 × → 移除该条通知 */
  function onDismiss(noticeId: number): void {
    dismissForkNotice(sessionId(), noticeId)
  }

  return { forkNotices, forkNoticeTop, onView, onDismiss }
}
