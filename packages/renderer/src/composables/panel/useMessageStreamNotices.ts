/**
 * useMessageStreamNotices —— MessageStream 末尾瞬时提示块的状态聚合（compacting）。
 *
 * [方案 D] dispatching 占位已迁入对话流末尾空 turn 的 TurnMeta（不再独立浮层）。本 composable
 * 现仅聚合 compacting 浮层状态 + fork notice 基线定位；isDispatching/hasWorkingTurn 仍返回供
 * useForkNoticeStream 兜底（生产路径用 forkNoticeBaseTop 短路，兜底不触发）。
 *
 * 从 MessageStream.vue 拆出（vue_rules_checker.py 的 script setup ≤300 行规范 + 单一变化轴复用）。
 * - 状态：isCompacting（驱动 compacting 浮层显隐）。
 * - 定位：forkNoticeBaseTop（委托 useNoticeStack 统一计算）。
 *
 * 不含：DOM 渲染（容器模板） / fork notice 定位（useForkNoticeStream）。
 * 定位顺序与占位高度见 useNoticeStack。
 *
 * @param deps 容器侧响应式依赖（totalHeight / topOffset / hasWorkingTurn / sessionId）
 */
import { computed, type ComputedRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useChatStore } from '@/stores/chat'
import { useNoticeStack } from '@/composables/panel/useNoticeStack'

/**
 * compaction notice 占位高度。
 * 强绑定 DOM：模板 isCompacting 块（`system-notice flex items-center gap-2 py-1`，含 `size-3` spinner
 *   + `text-[length:var(--text-xs)] leading-snug` 文本 + 两条 `h-px` 分隔线）。
 *   实际高度 = py-1(4px×2) + 内容 max(spinner 12px, text≈16px) ≈ 24px。
 *   notice 已从 absolute 浮层改为文档流 block（Virtualizer 之后），宽度随对话流对齐；
 *   此常量现仅供 useNoticeStack 的 forkNoticeBaseTop 兜底计算，dev 断言仍监测高度漂移。
 *   改 padding/字号/icon 必须重测并同步此常量（dev 断言会提醒）。
 */
export const COMPACTING_NOTICE_HEIGHT = 24

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
  /** 是否正在压缩（驱动 compacting 浮层显隐） */
  isCompacting: ComputedRef<boolean>
  /** compacting 浮层文案（M4：按 reason 区分手动/自动） */
  compactingText: ComputedRef<string>
  /** dispatching 空窗期（已发送 prompt 但 message_start 未到）。
   *  [方案 D] 不再驱动独立浮层——占位已迁入末尾空 turn 的 TurnMeta；此值仅供 useForkNoticeStream 兜底。 */
  isDispatching: ComputedRef<boolean>
  /** 最后一个 turn 是否正在流式生成。供 useForkNoticeStream 兜底用。 */
  hasWorkingTurn: ComputedRef<boolean>
  /** fork notice 首行基线（自其起按 FORK_NOTICE_HEIGHT 垂直堆叠，供 useForkNoticeStream 注入） */
  forkNoticeBaseTop: ComputedRef<number>
  } {
  const chat = useChatStore()
  const { t } = useI18n()

  /** 当前 session 是否正在压缩（session.compacting → true，compacted → false）。
   *  完成后 interpreter 发 message.compactionSummary（M4 事件驱动），插入持久化 system 消息，isCompacting 同步复位。 */
  const isCompacting = computed(() => chat.isCompacting(deps.sessionId.value))

  /** compacting 浮层文案（M4：按 reason 区分手动/自动，事件驱动核心价值）。
   *  reason='manual' 或未知/空 → 手动文案（compressing）；'threshold'|'overflow' → 自动文案（autoCompressing）。
   *  未在压缩时返回空串（模板 v-if=isCompacting 已守卫，不会渲染）。 */
  const compactingText = computed(() => {
    if (!chat.isCompacting(deps.sessionId.value)) return ''
    const reason = chat.getCompactingReason(deps.sessionId.value)
    return reason === 'threshold' || reason === 'overflow'
      ? t('panel.message.autoCompressing')
      : t('panel.message.compressing')
  })

  /** dispatching 空窗期：已发送 prompt 但 message_start 未到（无 streaming assistant，占位行给「思考中…」提示）。 */
  const isDispatching = computed(
    () => chat.isActive(deps.sessionId.value) && !chat.isGenerating(deps.sessionId.value),
  )

  /** 容器传入的 hasWorkingTurn getter 包成 ComputedRef（[方案 D] useForkNoticeStream 兜底用）。 */
  const hasWorkingTurn = computed(() => deps.hasWorkingTurn())

  /** 末尾瞬时块的垂直堆叠定位（M2，委托 useNoticeStack）：消除占位叠加的重复计算。
   *  [cw wave w4] vlistBottom 必填（virtua 单一滚动 owner，末项底部统一由 vlistBottom 提供）。
   *  [方案 D] dispatching 占位迁入对话流文档流，useNoticeStack 只算 compacting 浮层 + fork 基线。 */
  const { forkNoticeBaseTop } = useNoticeStack({
    vlistBottom: deps.vlistBottom,
    topOffset: deps.topOffset,
    isCompacting,
    compactNoticeHeight: COMPACTING_NOTICE_HEIGHT,
  })

  return {
    isCompacting,
    compactingText,
    isDispatching,
    hasWorkingTurn,
    forkNoticeBaseTop,
  }
}
