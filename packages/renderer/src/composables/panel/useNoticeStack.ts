/**
 * useNoticeStack —— MessageStream 末尾瞬时提示行的垂直堆叠定位（M2，从 MessageStream.vue 拆出）。
 *
 * 职责：单一变化轴「列表末尾瞬时块的 absolute top 计算」，消除 fork notice 基线的
 * 重复计算（reviewer m4：原 dispatchingTop / useForkNoticeStream.forkNoticeBaseTop 两处
 * 都写 `totalHeight + topOffset + (compacting? COMPACTING:0)`；[方案 D] dispatchingTop 已移除）。
 *
 * 计算顺序（垂直堆叠，互不重叠，自上而下）：
 *   renderItems 末项底部（= vlistBottom + topOffset；[方案 D] dispatching 占位已迁入
 *   对话流末尾 turn 的 TurnMeta，其高度已计入 vlistBottom）
 *   → compacting notice（isCompacting 时占 COMPACTING_NOTICE_HEIGHT，仍为 absolute 浮层）
 *   → fork notice 行（自 forkNoticeBaseTop 起按 FORK_NOTICE_HEIGHT 垂直堆叠）
 *
 * 不含：feed 订阅 / DOM 渲染（容器侧）。仅纯定位计算（computed），依赖以 ComputedRef 注入。
 *
 * @param deps 容器侧定位依赖（getter，每次重算读最新值）
 */
import { computed, type ComputedRef } from 'vue'

/** 容器侧定位依赖（getter 注入，避免本 composable 反向依赖虚拟滚动/状态计算） */
export interface NoticeStackDeps {
  /** virtua 末项底部绝对 px（vlist.scrollSize），所有 abs 子项 top 的基线。
   *  [方案 D] dispatching 占位已迁入对话流文档流（末尾空 turn 的 TurnMeta），其高度已计入 vlistBottom。 */
  vlistBottom: ComputedRef<number>
  /** load-more 预留顶部偏移（所有 abs 子项 top 基线） */
  topOffset: ComputedRef<number>
  /** 是否正在压缩（compacting notice 占位高度参与基线计算） */
  isCompacting: ComputedRef<boolean>
  /** compacting notice 占位高度（容器常量） */
  compactNoticeHeight: number
}

/**
 * 末尾瞬时块的 absolute top 堆叠计算。
 * 返回 forkNoticeBaseTop（fork notice 首行基线，自其起按 FORK_NOTICE_HEIGHT 垂直堆叠）。
 *
 * [方案 D] dispatching 占位不再作为独立 absolute 浮层（已迁入对话流末尾 turn 的 TurnMeta），
 * 故 fork notice 基线 = 列表末尾（vlistBottom，已含 dispatching 占位高度）+ topOffset + compacting 占位。
 * compacting 仍是 absolute 浮层（不在文档流），需在 vlistBottom 之上叠加其占位高度。
 */
export function useNoticeStack(deps: NoticeStackDeps): {
  /** fork notice 首行基线：列表末尾 + topOffset + compacting 占位。
   *  useForkNoticeStream 据此按 FORK_NOTICE_HEIGHT 垂直堆叠多条通知。 */
  forkNoticeBaseTop: ComputedRef<number>
} {
  /** fork notice 首行基线：vlistBottom（含文档流内 dispatching 占位）+ topOffset + compacting 占位 */
  const forkNoticeBaseTop = computed(() => {
    let top = deps.vlistBottom.value + deps.topOffset.value
    if (deps.isCompacting.value) top += deps.compactNoticeHeight
    return top
  })

  return { forkNoticeBaseTop }
}
