/**
 * useMessageStreamRail —— TurnRail（w4 wave IF4）的 per-session 状态 + 事件路由。
 *
 * 职责：
 * - railTurns：派生 renderItems 中所有 turn（rail 节点列表数据源）。
 * - activeTurnIndex：按 scrollTop 比例推算当前激活 turn 下标（viewport indicator 跟随滚动）。
 * - panelRightEdge：ResizeObserver 跟踪 panel 根 section 右边缘（rail 横向定位贴面板左侧）。
 * - 事件路由：onJump（滚动定位）/ onToggle / onExpandAll / onCollapseAll，全部经 useTurnExpansion
 *   与 Turn.vue 共享同一 session 展开态（同一 session Map key）。
 *
 * 索引空间注意：rail 内部用 railTurns 数组下标（0-based），Turn.vue 用 MessageTurn.index（1-based 序列）。
 * toggle/expandAll/collapseAll 把下标转 MessageTurn.index 再传 useTurnExpansion，保证 Map key 一致。
 *
 * 提取至此（composables/panel 既有范式）：MessageStream.vue script setup ≤300 行规范 + rail 关注点单一可复用。
 */
import { computed, onMounted, onScopeDispose, ref, type ComputedRef, type Ref } from 'vue'
import type { VirtualizerHandle } from 'virtua/vue'
import type { MessageTurn, RenderItem } from '@/composables/logic/messageTurns'
import { useTurnExpansion } from '@/composables/panel/useTurnExpansion'
import { useTurnExpansionStore } from '@/stores/turn-expansion'

/**
 * 空集合单例（expandedTurns 的 null-sid / 无展开分支复用）。
 * 复用同一引用避免每次响应式触发 new Set()，减少下游（TurnRail 经 props 接收）
 * 因 Set 引用变更触发的无谓重渲染（W3 性能优化）。
 * frozen 保证不被外部 mutate 污染——expandedTurns 的契约是只读 Set。
 */
const EMPTY_SET: ReadonlySet<number> = Object.freeze(new Set<number>()) as ReadonlySet<number>

/** useMessageStreamRail 依赖（由 MessageStream.vue 注入，避免重复读取 store/props）。 */
export interface UseMessageStreamRailDeps {
  sessionId: ComputedRef<string>
  /** 完整渲染项列表（turn + system 穿插），railTurns 派生自此。 */
  renderItems: ComputedRef<RenderItem[]>
  /** 滚动容器 el（读 scrollTop/scrollHeight 算 activeTurnIndex + closest('section') 算 panelRightEdge）。 */
  scrollEl: Ref<HTMLElement | null>
  /** 虚拟列表 offsetOf(idx) —— rail jump 定位用（renderItems 下标 → absolute top px）。 */
  offsetOf: (idx: number) => number
  /** 顶部预留高度（load-more 占位），rail jump top = offsetOf(idx) + topOffset。 */
  topOffset: ComputedRef<number>
  /** [cw wave w2] virtua VirtualizerHandle ref（双轨：有则走 virtua API，无则走 scrollEl+offsetOf 旧路径）。
   *  w2 由 MessageStream.vue 不传（仍走旧路径），w3 切换到 virtua 后传入。 */
  vlistRef?: Ref<VirtualizerHandle | null>
}

export function useMessageStreamRail(deps: UseMessageStreamRailDeps): {
  railTurns: ComputedRef<MessageTurn[]>
  activeTurnIndex: Ref<number>
  panelRightEdge: Ref<number>
  /** 当前 session 已展开的 turn index 集合（TurnRail toggle 图标方向依据）。
   *  ReadonlySet：消费方只读（TurnRail 用 .has 查询），空态复用 EMPTY_SET 单例（W3）。 */
  expandedTurns: ComputedRef<ReadonlySet<number>>
  updateActiveTurnIndex: () => void
  onJump: (idx: number) => void
  onToggle: (idx: number) => void
} {
  const { sessionId, renderItems, scrollEl, offsetOf, topOffset } = deps

  /** rail 状态接入 useTurnExpansion（与 Turn.vue 共享同一 session Map）。 */
  const { toggle } = useTurnExpansion(sessionId)

  /** rail 节点数据源：renderItems 中所有 turn（rail 列表渲染 + jump/toggle 索引空间）。 */
  const railTurns = computed<MessageTurn[]>(() =>
    renderItems.value.filter((item) => item.kind === 'turn').map((item) => item.turn),
  )

  /**
   * 派生当前 session 已展开的 turn index 集合（TurnRail toggle 图标方向依据）。
   *
   * 响应式追踪关键：用 store.isExpanded(sid, idx) 逐个查 railTurns 的 index，
   * 不直接遍历 store.partitions.entries()。原因：
   * - 外层 partitions 是 plain Map（非响应式），遍历/读它都不建立依赖；
   *   真正的依赖通过内层 reactive Map.get(idx) 建立（store.isExpanded 内部走 getPartition
   *   惰性创建分区 + 读 reactive Map.get(idx)），故必须逐个查 isExpanded 才能让
   *   toggle/expand/collapse mutate 时正确失效。
   * - 直接读 entries() 还会把 partition 误当响应式源，但 partition 引用本身不变（只 mutate 内容），
   *   不会触发 computed 重算——必须通过 get(idx) 建立 per-key 依赖。
   *
   * 与 Turn.vue 读 isExpanded 的追踪链路一致（同一 store 同一分区同一 idx 依赖）。
   */
  const store = useTurnExpansionStore()
  const expandedTurns = computed<ReadonlySet<number>>(() => {
    const sid = sessionId.value
    if (!sid) return EMPTY_SET
    const expanded = new Set<number>()
    for (const turn of railTurns.value) {
      if (store.isExpanded(sid, turn.index)) {
        expanded.add(turn.index)
      }
    }
    return expanded.size === 0 ? EMPTY_SET : expanded
  })

  /** 当前激活 turn 在 railTurns 中的下标（viewport indicator 位置 + active 节点高亮）。 */
  const activeTurnIndex = ref(0)

  /** 面板右边缘 px（rail 横向定位：贴面板左侧 8px，避免压住 composer/侧栏）。 */
  const panelRightEdge = ref(0)

  /**
   * 按 scrollTop 比例推算当前激活 turn 下标。
   * railTurns 为空时跳过（模板 v-if turns.length>0 守卫，但 computed ref 仍需防除零）。
   *
   * [cw wave w2] 双轨：有 vlistRef 时走 virtua findItemIndex(scrollOffset) 精确定位当前项，
   * 无则走旧路径（scrollTop 比例推算）。w3 切换到 virtua 后用精确路径，比例推算仅在旧路径保留。
   */
  function updateActiveTurnIndex(): void {
    const v = deps.vlistRef?.value
    if (v) {
      activeTurnIndex.value = v.findItemIndex(v.scrollOffset)
      return
    }
    const el = scrollEl.value
    if (!el || railTurns.value.length === 0) return
    const max = el.scrollHeight - el.clientHeight || 1
    const ratio = el.scrollTop / max
    activeTurnIndex.value = Math.min(
      railTurns.value.length - 1,
      Math.max(0, Math.floor(ratio * railTurns.value.length)),
    )
  }

  /**
   * rail jump：滚动到对应 turn 的 absolute offset（+ topOffset 预留 load-more 空间）。
   * idx 是 railTurns 数组下标，需映射回 renderItems 下标（系统提示行穿插使两者不一致）。
   * railTurns[idx] 已持有目标 turn 对象，直接用引用相等 findIndex（无需 O(n) 累计 turnCount）。
   *
   * [cw wave w2] 双轨：有 vlistRef 时走 virtua scrollToIndex(renderIdx, {align:'start'})，
   * 无则走旧路径（scrollEl.scrollTop = offsetOf(renderIdx) + topOffset）。
   */
  function onJump(idx: number): void {
    const targetTurn = railTurns.value[idx]
    if (!targetTurn) return
    const renderIdx = renderItems.value.findIndex(
      (item) => item.kind === 'turn' && item.turn === targetTurn,
    )
    if (renderIdx < 0) return
    const v = deps.vlistRef?.value
    if (v) {
      v.scrollToIndex(renderIdx, { align: 'start' })
      return
    }
    if (!scrollEl.value) return
    scrollEl.value.scrollTop = offsetOf(renderIdx) + topOffset.value
  }

  /** rail toggle：切该 turn 的展开态。
   *  idx 是 railTurns 下标 → 转成 MessageTurn.index（与 Turn.vue 用的 props.turn.index 对齐）。 */
  function onToggle(idx: number): void {
    const turnIdx = railTurns.value[idx]?.index
    if (turnIdx != null) toggle(turnIdx)
  }

  /**
   * panelRightEdge 跟踪：ResizeObserver 监听 panel 根 section 宽度变化 + window resize 兜底。
   * rail 用此值横向定位（贴面板左侧），窗口缩放时 rail 跟随重定位。onScopeDispose 清理防泄漏。
   */
  let resizeObserver: ResizeObserver | null = null
  function refreshPanelRightEdge(): void {
    const section = scrollEl.value?.closest('section')
    if (section) panelRightEdge.value = section.getBoundingClientRect().right
  }
  onMounted(() => {
    refreshPanelRightEdge()
    const section = scrollEl.value?.closest('section')
    if (section && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(refreshPanelRightEdge)
      resizeObserver.observe(section)
    }
    window.addEventListener('resize', refreshPanelRightEdge)
  })
  onScopeDispose(() => {
    resizeObserver?.disconnect()
    resizeObserver = null
    window.removeEventListener('resize', refreshPanelRightEdge)
  })

  return {
    railTurns,
    activeTurnIndex,
    panelRightEdge,
    expandedTurns,
    updateActiveTurnIndex,
    onJump,
    onToggle,
  }
}
