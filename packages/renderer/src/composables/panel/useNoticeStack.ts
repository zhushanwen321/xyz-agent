/**
 * useNoticeStack —— MessageStream 末尾瞬时提示行的垂直堆叠定位（M2，从 MessageStream.vue 拆出）。
 *
 * 职责：单一变化轴「列表末尾瞬时块的 absolute top 计算」，消除 fork notice 基线的
 * 重复计算（reviewer m4：原 dispatchingTop / useForkNoticeStream.forkNoticeBaseTop 两处
 * 都写 `totalHeight + topOffset + (compacting? COMPACTING:0)`；[方案 D] dispatchingTop 已移除）。
 *
 * [u6a / D7 展示统一] 基线语义实测核对结论（设计 §5 待验证点「fork notice 定位基线迁移」）：
 * - TurnMeta dispatching「思考中」占位已删除（迁 ActivityStrip thinking 行）：dispatching
 *   空窗期空 turn 不再渲染 TurnMeta 行，其高度（~30px）退出 vlistBottom；等量高度由
 *   ActivityStrip thinking 行（COMPACTING_NOTICE_HEIGHT=24，文档流）在 Virtualizer 之后承接，
 *   fork notice 与 ActivityStrip 同为文档流 block，按文档序自然堆叠——**生产路径 fork
 *   notice 的定位正确性由文档流顺序保证，不依赖本计算**（MessageStream 模板不消费
 *   forkNoticeTop，ForkNotice 无 absolute 定位）。
 * - compacting / executing bash / thinking 行均为 ActivityStrip 文档流行（非 absolute 浮层），
 *   其高度体现在文档序而非本基线；下方 compacting 叠加分支是历史「浮层形态」语义的兜底
 *   保留（生产由 injectedBaseTop 短路 + forkNoticeTop 不被模板消费，双重不触发）。
 * - 本计算（vlistBottom + topOffset + compacting 叠加）仅服务 useForkNoticeStream 的
 *   兜底通路（未注入 injectedBaseTop 的历史调用方），单测锁定公式防漂移。
 *
 * 不含：feed 订阅 / DOM 渲染（容器侧）。仅纯定位计算（computed），依赖以 ComputedRef 注入。
 *
 * @param deps 容器侧定位依赖（getter，每次重算读最新值）
 */
import { computed, type ComputedRef } from 'vue'

/** 容器侧定位依赖（getter 注入，避免本 composable 反向依赖虚拟滚动/状态计算） */
export interface NoticeStackDeps {
  /** virtua 末项底部绝对 px（vlist.scrollSize），所有 abs 子项 top 的基线。
   *  [方案 D] dispatching 占位已迁入对话流文档流（末尾空 turn 的 TurnMeta），其高度已计入 vlistBottom。
   *  [u6a] TurnMeta dispatching 占位已删除，空 turn 高度由 ActivityStrip thinking 行在文档流承接。 */
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
 * 公式：forkNoticeBaseTop = vlistBottom + topOffset + (isCompacting ? compactNoticeHeight : 0)
 * （兜底通路专用，见文件头 [u6a] 结论；生产 fork notice 定位 = 文档流自然堆叠。）
 */
export function useNoticeStack(deps: NoticeStackDeps): {
  /** fork notice 首行基线：列表末尾 + topOffset + compacting 占位。
   *  useForkNoticeStream 据此按 FORK_NOTICE_HEIGHT 垂直堆叠多条通知。 */
  forkNoticeBaseTop: ComputedRef<number>
} {
  /** fork notice 首行基线：vlistBottom + topOffset + compacting 占位（兜底通路，生产不消费） */
  const forkNoticeBaseTop = computed(() => {
    let top = deps.vlistBottom.value + deps.topOffset.value
    if (deps.isCompacting.value) top += deps.compactNoticeHeight
    return top
  })

  return { forkNoticeBaseTop }
}
