/**
 * useMessageStreamNotices —— MessageStream 末尾瞬时提示块的状态聚合。
 *
 * [u6a / D7 展示统一] compacting / executing bash / dispatching（思考中）三处对话流内
 * 「进行中」指示已收编 ActivityStrip 组件（message-stream/ActivityStrip.vue，数据源
 * sessionPhase occupancy 投影）——本 composable 不再产出渲染文案（compactingText 退役，
 * 文案逻辑迁入 ActivityStrip），仅保留：
 * - 状态：isCompacting（驱动 useMessageStreamScroll 滚动跟随 + fork 基线兜底参数）。
 * - 定位：forkNoticeBaseTop（委托 useNoticeStack 统一计算）。
 * - isDispatching / hasWorkingTurn：仅供 useForkNoticeStream 兜底 deps（生产路径经
 *   forkNoticeBaseTop 短路不触发）。
 * - COMPACTING_NOTICE_HEIGHT / EXECUTING_BASH_NOTICE_HEIGHT 像素常量：dev 断言已随行迁入
 *   ActivityStrip 内部（useConstantHeightAssert），常量本体保留在此供 ActivityStrip 与
 *   useNoticeStack 消费。
 *
 * 从 MessageStream.vue 拆出（vue_rules_checker.py 的 script setup ≤300 行规范 + 单一变化轴复用）。
 *
 * 不含：DOM 渲染（容器模板）/ fork notice 定位（useForkNoticeStream）。
 * 定位顺序与占位高度见 useNoticeStack。
 *
 * @param deps 容器侧响应式依赖（totalHeight / topOffset / hasWorkingTurn / sessionId）
 */
import { computed, type ComputedRef } from 'vue'
import { useChatStore } from '@/stores/chat'
import { useNoticeStack } from '@/composables/panel/useNoticeStack'

/**
 * compaction notice 占位高度。
 * 强绑定 DOM：ActivityStrip compacting 行（`system-notice content-col flex items-center gap-2 py-1`，
 * 含 `size-3` spinner + `text-[length:var(--text-xs)] leading-snug` 文本 + 两条 `h-px` 分隔线）。
 *   实际高度 = py-1(4px×2) + 内容 max(spinner 12px, text≈16px) ≈ 24px。
 *   [u6a] 行已从本文件模板迁入 ActivityStrip（文档流 block，Virtualizer 之后），行 DOM 结构
 *   逐 class 等价 → 高度语义不变；此常量现仅供 useNoticeStack 的 forkNoticeBaseTop 兜底计算
 *   与 ActivityStrip 内的 dev 断言（useConstantHeightAssert）消费。
 *   改 padding/字号/icon 必须重测并同步此常量（dev 断言会提醒）。
 */
export const COMPACTING_NOTICE_HEIGHT = 24

/**
 * executing bash 瞬时行占位高度（W4 完整形态）。
 * 强绑定 DOM：ActivityStrip bash 行（与 compacting 行同结构：`system-notice flex items-center
 * gap-2 py-1`，`size-3` spinner + `text-[length:var(--text-xs)] leading-snug` 文本 + 两条
 * `h-px` 分隔线）→ 实际高度同 COMPACTING_NOTICE_HEIGHT ≈ 24px。
 * [u6a] 行 DOM 已迁入 ActivityStrip（文档流 block），不参与 absolute 定位基线——此常量仅供
 * ActivityStrip 内 dev 断言（useConstantHeightAssert）监测高度漂移。改 padding/字号/icon
 * 必须重测并同步（dev 断言会提醒）。
 */
export const EXECUTING_BASH_NOTICE_HEIGHT = 24

/**
 * 像素常量（design §4.1 附录 A）：itemSize 是 virta 的初始估算 hint（非强制，virta 自动从
 * 实测项重估）。与原手写虚拟滚动的 ESTIMATED_TURN_HEIGHT 一致，平滑迁移期减少首屏估算误差。
 * （[cw wave w3] 自 MessageStream.vue 随 ≤300 行拆分迁入——virta 布局常量族同源聚拢。）
 */
export const ESTIMATED_TURN_HEIGHT = 200

/**
 * load-more 按钮预留高度（B2 强绑 DOM：Button h-8 + py-2 ≈ 48px，取 44 为历史值，避免定位回归）。
 * [cw wave w3] 通过 <Virtualizer :startMargin> 喂入 virta（design §4.11）：virta getItemOffset 已含 startMargin。
 */
export const LOAD_MORE_RESERVED_HEIGHT = 44

/** 容器侧响应式依赖（getter/ComputedRef 注入，避免本 composable 反向依赖虚拟滚动/状态计算） */
export interface MessageStreamNoticesDeps {
  /** 当前 session id（响应式，状态查询键） */
  sessionId: ComputedRef<string>
  /** virtua 末项底部绝对 px（vlist.scrollSize），所有 abs 子项 top 的基线。 */
  vlistBottom: ComputedRef<number>
  /** load-more 预留顶部偏移（所有 abs 子项 top 基线） */
  topOffset: ComputedRef<number>
  /** 最后一个 turn 是否正在流式生成（fork 兜底 deps 之一 + 滚动跟随）。
   *  getter 注入：容器侧 lastRenderTurn 派生，避免循环依赖。 */
  hasWorkingTurn: () => boolean
}

/**
 * 末尾瞬时块的状态 + 定位聚合（[u6a] 渲染文案已收编 ActivityStrip，仅剩状态与定位）。
 * 返回值供 useForkNoticeStream deps / useMessageStreamScroll 消费。
 */
export function useMessageStreamNotices(deps: MessageStreamNoticesDeps): {
  /** 是否正在压缩（occupancy compacting 维度派生；驱动滚动跟随 + fork 基线兜底参数） */
  isCompacting: ComputedRef<boolean>
  /** dispatching 空窗期（已发送 prompt 但 message_start 未到）。
   *  [u6a] 思考中指示已迁 ActivityStrip thinking 行；此值仅供 useForkNoticeStream 兜底。 */
  isDispatching: ComputedRef<boolean>
  /** 最后一个 turn 是否正在流式生成。供 useForkNoticeStream 兜底用。 */
  hasWorkingTurn: ComputedRef<boolean>
  /** fork notice 首行基线（自其起按 FORK_NOTICE_HEIGHT 垂直堆叠，供 useForkNoticeStream 注入） */
  forkNoticeBaseTop: ComputedRef<number>
  } {
  const chat = useChatStore()

  /** 当前 session 是否正在压缩（occupancy compacting 维度派生，单一来源；
   *  完成后 interpreter 发 message.compactionSummary（M4 事件驱动），插入持久化 system 消息。 */
  const isCompacting = computed(() => chat.isCompacting(deps.sessionId.value))

  /** dispatching 空窗期：已发送 prompt 但 message_start 未到（无 streaming assistant）。
   *  [u6a] 不再驱动「思考中」渲染（ActivityStrip thinking 行按 sessionPhase.turn==='dispatching'
   *  判定）；此值仅供 useForkNoticeStream 兜底 deps（签名不变，生产 forkNoticeBaseTop 短路）。 */
  const isDispatching = computed(
    () => chat.isActive(deps.sessionId.value) && !chat.isGenerating(deps.sessionId.value),
  )

  /** 容器传入的 hasWorkingTurn getter 包成 ComputedRef（useForkNoticeStream 兜底用）。 */
  const hasWorkingTurn = computed(() => deps.hasWorkingTurn())

  /** 末尾瞬时块的垂直堆叠定位（M2，委托 useNoticeStack）：消除占位叠加的重复计算。
   *  [u6a] 全部指示行已收编 ActivityStrip 文档流 block，useNoticeStack 只剩 fork 基线兜底。 */
  const { forkNoticeBaseTop } = useNoticeStack({
    vlistBottom: deps.vlistBottom,
    topOffset: deps.topOffset,
    isCompacting,
    compactNoticeHeight: COMPACTING_NOTICE_HEIGHT,
  })

  return {
    isCompacting,
    isDispatching,
    hasWorkingTurn,
    forkNoticeBaseTop,
  }
}
