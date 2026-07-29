/**
 * useNoticeStack —— MessageStream 末尾瞬时提示行的垂直堆叠定位（M2，从 MessageStream.vue 拆出）。
 *
 * 职责：单一变化轴「列表末尾瞬时块的 absolute top 计算」，消除 compacting 占位叠加的
 * 重复计算（reviewer m4：dispatchingTop / useForkNoticeStream.forkNoticeBaseTop 两处
 * 都写 `totalHeight + topOffset + (compacting? COMPACTING:0)`）。
 *
 * 计算顺序（垂直堆叠，互不重叠，自上而下）：
 *   renderItems 末项底部（= totalHeight + topOffset）
 *   → compacting notice（isCompacting 时占 COMPACTING_NOTICE_HEIGHT）
 *   → dispatching 占位（isDispatching && !hasWorkingTurn 时占 COMPACTING_NOTICE_HEIGHT）
 *   → fork notice 行（自 forkNoticeBaseTop 起按 FORK_NOTICE_HEIGHT 垂直堆叠）
 *
 * 不含：feed 订阅 / DOM 渲染（容器侧）。仅纯定位计算（computed），依赖以 ComputedRef 注入。
 *
 * @param deps 容器侧定位依赖（getter，每次重算读最新值）
 */
import { computed, type ComputedRef } from 'vue'

/** 容器侧定位依赖（getter 注入，避免本 composable 反向依赖虚拟滚动/状态计算） */
export interface NoticeStackDeps {
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
  /** compacting notice 占位高度（容器常量） */
  compactNoticeHeight: number
  /** dispatching 占位高度（容器常量；与 compacting 同量级，容器侧传入） */
  dispatchingNoticeHeight: number
}

/**
 * 末尾瞬时块的 absolute top 堆叠计算。
 * 返回 dispatchingTop（dispatching 块 top）/ forkNoticeBaseTop
 * （fork notice 首行基线，自其起按 FORK_NOTICE_HEIGHT 垂直堆叠）。
 */
export function useNoticeStack(deps: NoticeStackDeps): {
  /** dispatching 块 top：列表末尾 + topOffset + compacting 占位（compacting → dispatching 顺序）。 */
  dispatchingTop: ComputedRef<number>
  /** fork notice 首行基线：列表末尾 + topOffset + compacting + dispatching 占位。
   *  useForkNoticeStream 据此按 FORK_NOTICE_HEIGHT 垂直堆叠多条通知。 */
  forkNoticeBaseTop: ComputedRef<number>
} {
  /**
   * 末项底部基线 px：直接读 vlistBottom（virtua scrollSize）。
   * [cw wave w4] 删 totalHeight 旧路径：virtua 是单一滚动 owner，末项底部统一由 vlistBottom 提供。
   */
  function resolveBase(): number {
    return deps.vlistBottom.value
  }

  /** 列表末尾 + topOffset + compacting 占位（dispatching 块的基线） */
  const dispatchingTop = computed(() => {
    let top = resolveBase() + deps.topOffset.value
    if (deps.isCompacting.value) top += deps.compactNoticeHeight
    return top
  })

  /** dispatching 基线 + dispatching 占位（fork notice 首行的基线） */
  const forkNoticeBaseTop = computed(() => {
    let top = dispatchingTop.value
    if (deps.isDispatching.value && !deps.hasWorkingTurn.value) top += deps.dispatchingNoticeHeight
    return top
  })

  return { dispatchingTop, forkNoticeBaseTop }
}
