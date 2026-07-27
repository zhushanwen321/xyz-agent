/**
 * useMessageStreamNotices —— MessageStream 末尾瞬时提示块的状态聚合（fast-handoff/compacting/dispatching）。
 *
 * 从 MessageStream.vue 拆出（vue_rules_checker.py 的 script setup ≤300 行规范 + 单一变化轴复用）。
 * 聚合三类瞬时块的「状态 computed + 垂直堆叠定位 + 取消 handler」：
 * - 状态：isCompacting / isHandingOff / isDispatching / hasWorkingTurn（驱动 v-if 显隐）。
 * - 定位：handoffNoticeTop / dispatchingTop（绝对定位 top，委托 useNoticeStack 统一计算）。
 * - 交互：onAbortHandoff（「正在交接…」取消按钮，委托 useSidebar.abortHandoff）。
 *
 * 不含：DOM 渲染（容器模板） / fork notice 定位（useForkNoticeStream）。
 * 定位顺序与占位高度见 useNoticeStack。
 *
 * @param deps 容器侧响应式依赖（totalHeight / topOffset / hasWorkingTurn / sessionId）
 */
import { computed, type ComputedRef } from 'vue'
import { useChatStore } from '@/stores/chat'
import { useSidebar } from '@/composables/features/useSidebar'
import { useNoticeStack } from '@/composables/panel/useNoticeStack'

/**
 * compaction notice 占位高度。
 * 强绑定 DOM：模板 isCompacting 块（`flex items-center gap-2 pt-2.5 pb-5`，含 `size-3` spinner
 *   + `text-[11px] leading-snug` 文本 + 两条 `h-px` 分隔线）。
 *   实际高度 = pt-2.5(10px) + 内容 max(spinner 12px, text≈16px) + pb-5(20px) = 46px。
 *   pb-5 撑出到 composer 的间距（notice 是 absolute 子元素参与 scrollEl scrollHeight，
 *   底部 padding 让块变高 → scrollHeight 增大 → 滚到底时 notice 内容到视口底部的距离
 *   = 到 composer 的间距，对齐末条 turn 的 pb-5 视觉）。
 *   改 padding/字号/icon 必须重测并同步此常量（dev 断言会提醒）。
 *
 * dispatching 占位高度也复用此值（dispatching 文本块尺寸同量级）。
 */
export const COMPACTING_NOTICE_HEIGHT = 46

/**
 * handoff notice 占位高度（强绑定 DOM，与 COMPACTING_NOTICE_HEIGHT 同结构：spinner + 文本 + 分隔线）。
 * 实际高度 = pt-2.5(10px) + 内容 max(spinner 12px, text≈16px) + pb-5(20px) = 46px；
 *   pb-5 撑出到 composer 的间距，与 COMPACTING_NOTICE_HEIGHT 同结构对齐。常量 46 与 compacting 一致。
 *   改 padding/字号/icon 必须重测并同步此常量（dev 断言会提醒）。
 */
export const HANDOFF_NOTICE_HEIGHT = 46

/** 容器侧响应式依赖（getter/ComputedRef 注入，避免本 composable 反向依赖虚拟滚动/状态计算） */
export interface MessageStreamNoticesDeps {
  /** 当前 session id（响应式，状态查询键） */
  sessionId: ComputedRef<string>
  /** virtua 末项底部绝对 px（vlist.scrollSize），所有 abs 子项 top 的基线。 */
  vlistBottom: ComputedRef<number>
  /** load-more 预留顶部偏移（所有 abs 子项 top 基线） */
  topOffset: ComputedRef<number>
  /** 最后一个 turn 是否正在流式生成（dispatching 占位条件之一 + 滚动跟随）。
   *  getter 注入：容器侧 lastRenderTurn 派生，避免循环依赖。 */
  hasWorkingTurn: () => boolean
}

/**
 * 末尾瞬时块的状态 + 定位 + 取消 handler 聚合。
 * 返回值供 MessageStream.vue 模板 v-if / :style / @click 直接使用。
 */
export function useMessageStreamNotices(deps: MessageStreamNoticesDeps): {
  /** 是否正在压缩（驱动「--- 压缩中 ---」瞬时提示显隐） */
  isCompacting: ComputedRef<boolean>
  /** 是否正在交接（驱动「正在交接…」瞬时提示显隐，fast-handoff） */
  isHandingOff: ComputedRef<boolean>
  /** dispatching 空窗期（已发送 prompt 但 message_start 未到，占位行「思考中…」） */
  isDispatching: ComputedRef<boolean>
  /** 最后一个 turn 是否正在流式生成（dispatching 占位显隐条件，模板 v-if 用） */
  hasWorkingTurn: ComputedRef<boolean>
  /** 「正在交接」块 absolute top：列表末尾 + topOffset + compacting 占位（compacting → handoff 顺序） */
  handoffNoticeTop: ComputedRef<number>
  /** dispatching 块 absolute top：列表末尾 + topOffset + compacting + handoff 占位 */
  dispatchingTop: ComputedRef<number>
  /** fork notice 首行基线（自其起按 FORK_NOTICE_HEIGHT 垂直堆叠，供 useForkNoticeStream 注入） */
  forkNoticeBaseTop: ComputedRef<number>
  /** 取消进行中的 handoff（「正在交接…」取消按钮） */
  onAbortHandoff: () => void
  } {
  const chat = useChatStore()

  /** 当前 session 是否正在压缩（session.compacting → true，compacted → false）。
   *  完成后 dispatcher 广播 message.compactionSummary，插入持久化 system 消息，isCompacting 同步复位。 */
  const isCompacting = computed(() => chat.isCompacting(deps.sessionId.value))

  /** 当前 session 是否正在交接（fast-handoff：session.handoff 触发→true，handoffComplete/abort→false）。 */
  const isHandingOff = computed(() => chat.isHandingOff(deps.sessionId.value))

  /** dispatching 空窗期：已发送 prompt 但 message_start 未到（无 streaming assistant，占位行给「思考中…」提示）。 */
  const isDispatching = computed(
    () => chat.isActive(deps.sessionId.value) && !chat.isGenerating(deps.sessionId.value),
  )

  /** 容器传入的 hasWorkingTurn getter 包成 ComputedRef（useNoticeStack 需要 ComputedRef 依赖）。 */
  const hasWorkingTurn = computed(() => deps.hasWorkingTurn())

  /** 末尾瞬时块的垂直堆叠定位（M2，委托 useNoticeStack）：消除占位叠加的重复计算。
   *  [cw wave w4] vlistBottom 必填（virtua 单一滚动 owner，末项底部统一由 vlistBottom 提供）。 */
  const { handoffNoticeTop, dispatchingTop, forkNoticeBaseTop } = useNoticeStack({
    vlistBottom: deps.vlistBottom,
    topOffset: deps.topOffset,
    isCompacting,
    isDispatching,
    hasWorkingTurn,
    isHandingOff,
    compactNoticeHeight: COMPACTING_NOTICE_HEIGHT,
    handoffNoticeHeight: HANDOFF_NOTICE_HEIGHT,
    dispatchingNoticeHeight: COMPACTING_NOTICE_HEIGHT,
  })

  /** 取消进行中的 handoff（乐观清 handingOff + abortHandoff RPC）。委托 useSidebar.abortHandoff。 */
  const { abortHandoff } = useSidebar()
  function onAbortHandoff(): void {
    void abortHandoff(deps.sessionId.value)
  }

  return {
    isCompacting,
    isHandingOff,
    isDispatching,
    hasWorkingTurn,
    handoffNoticeTop,
    dispatchingTop,
    forkNoticeBaseTop,
    onAbortHandoff,
  }
}
