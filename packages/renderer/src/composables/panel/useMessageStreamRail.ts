/**
 * useMessageStreamRail —— TurnRail（w4 wave IF4）的 per-session 状态 + 事件路由。
 *
 * 职责：
 * - railTurns：派生 renderItems 中所有 turn（rail 节点列表数据源）。
 * - activeTurnIndex：按 virta scrollOffset 精确定位当前激活 turn 下标（viewport indicator 跟随滚动）。
 * - panelRightEdge：ResizeObserver 跟踪 panel 根 section 右边缘（rail 横向定位贴面板左侧）。
 * - 事件路由：onJump（滚动定位）/ onToggle / onExpandAll / onCollapseAll，全部经 useTurnExpansion
 *   与 Turn.vue 共享同一 session 展开态（同一 session Map key）。
 *
 * 索引空间注意：rail 内部用 railTurns 数组下标（0-based），Turn.vue 用 props.turn（稳定 key
 * 经 turnStableId 派生，M5 stable-key）。toggle/expandAll/collapseAll 把下标转 turn 稳定 key
 * 再传 useTurnExpansion，保证 Map key 一致（string key 不随消息插删漂移）。
 *
 * 提取至此（composables/panel 既有范式）：MessageStream.vue script setup ≤300 行规范 + rail 关注点单一可复用。
 */
import { computed, onMounted, onScopeDispose, ref, type ComputedRef, type Ref } from 'vue'
import type { VirtualizerHandle } from 'virtua/vue'
import type { MessageTurn, RenderItem } from '@/composables/logic/messageTurns'
import { turnStableId } from '@xyz-agent/core/domain/chat'
import { useTurnExpansion } from '@/composables/panel/useTurnExpansion'
import { useTurnExpansionStore } from '@/stores/turn-expansion'

/**
 * 空集合单例（expandedTurns 的 null-sid / 无展开分支复用）。
 * 复用同一引用避免每次响应式触发 new Set()，减少下游（TurnRail 经 props 接收）
 * 因 Set 引用变更触发的无谓重渲染（W3 性能优化）。
 * frozen 保证不被外部 mutate 污染——expandedTurns 的契约是只读 Set。
 */
const EMPTY_SET: ReadonlySet<string> = Object.freeze(new Set<string>()) as ReadonlySet<string>

/** useMessageStreamRail 依赖（由 MessageStream.vue 注入，避免重复读取 store/props）。 */
export interface UseMessageStreamRailDeps {
  sessionId: ComputedRef<string>
  /** 完整渲染项列表（turn + system 穿插），railTurns 派生自此。 */
  renderItems: ComputedRef<RenderItem[]>
  /** 滚动容器 el（closest('section') 算 panelRightEdge + ResizeObserver 横向重定位）。 */
  scrollEl: Ref<HTMLElement | null>
  /** [cw wave w4] virtua VirtualizerHandle ref（单一 virtua 路径：rail jump/active 都走 virta API）。
   *  vlistRef 必填：onJump 调 scrollToIndex，updateActiveTurnIndex 调 findItemIndex。 */
  vlistRef: Ref<VirtualizerHandle | null>
}

export function useMessageStreamRail(deps: UseMessageStreamRailDeps): {
  railTurns: ComputedRef<MessageTurn[]>
  activeTurnIndex: Ref<number>
  panelRightEdge: Ref<number>
  /** 当前 session 已展开的 turn 稳定 key 集合（TurnRail toggle 图标方向依据）。
   *  ReadonlySet：消费方只读（TurnRail 用 .has 查询），空态复用 EMPTY_SET 单例（W3）。 */
  expandedTurns: ComputedRef<ReadonlySet<string>>
  updateActiveTurnIndex: () => void
  onJump: (idx: number) => void
  onToggle: (idx: number) => void
} {
  const { sessionId, renderItems, scrollEl } = deps

  /** rail 状态接入 useTurnExpansion（与 Turn.vue 共享同一 session Map）。 */
  const { toggle } = useTurnExpansion(sessionId)

  /** rail 节点数据源：renderItems 中所有 turn（rail 列表渲染 + jump/toggle 索引空间）。 */
  const railTurns = computed<MessageTurn[]>(() =>
    renderItems.value.filter((item) => item.kind === 'turn').map((item) => item.turn),
  )

  /**
   * 派生当前 session 已展开的 turn 稳定 key 集合（TurnRail toggle 图标方向依据）。
   *
   * [M5 stable-key] key 从 MessageTurn.index 改为 turnStableId(turn)（首条消息 id）：
   * 消息插删（load-more/streaming）时 index 漂移，展开态会错绑到别的 turn；
   * string 稳定 key 随 turn 首条消息 id 不变（消息 id 创建时生成，全局唯一）。
   *
   * 响应式追踪关键：用 store.isExpanded(sid, key) 逐个查 railTurns 的稳定 key，
   * 不直接遍历 store.partitions.entries()。原因：
   * - 外层 partitions 是 plain Map（非响应式），遍历/读它都不建立依赖；
   *   真正的依赖通过内层 reactive Map.get(key) 建立（store.isExpanded 内部走 getPartition
   *   惰性创建分区 + 读 reactive Map.get(key)），故必须逐个查 isExpanded 才能让
   *   toggle/expand/collapse mutate 时正确失效。
   * - 直接读 entries() 还会把 partition 误当响应式源，但 partition 引用本身不变（只 mutate 内容），
   *   不会触发 computed 重算——必须通过 get(key) 建立 per-key 依赖。
   *
   * 与 Turn.vue 读 isExpanded 的追踪链路一致（同一 store 同一分区同一 key 依赖）。
   */
  const store = useTurnExpansionStore()
  const expandedTurns = computed<ReadonlySet<string>>(() => {
    const sid = sessionId.value
    if (!sid) return EMPTY_SET
    const expanded = new Set<string>()
    for (const turn of railTurns.value) {
      const key = turnStableId(turn)
      if (store.isExpanded(sid, key)) {
        expanded.add(key)
      }
    }
    return expanded.size === 0 ? EMPTY_SET : expanded
  })

  /** 当前激活 turn 在 railTurns 中的下标（viewport indicator 位置 + active 节点高亮）。 */
  const activeTurnIndex = ref(0)

  /** 面板右边缘 px（rail 横向定位：贴面板左侧 8px，避免压住 composer/侧栏）。 */
  const panelRightEdge = ref(0)

  /**
   * 按 virtua scrollOffset 精确定位当前激活 turn 下标（viewport indicator 跟随滚动）。
   * [cw wave w4] 单一 virtua 路径：vlistRef.findItemIndex(scrollOffset) 反查当前可见首项。
   */
  function updateActiveTurnIndex(): void {
    const v = deps.vlistRef.value
    if (!v) return
    const renderIdx = v.findItemIndex(v.scrollOffset)
    // findItemIndex 返回 renderItems 空间下标（含 system 条目），
    // 需映射回 railTurns 空间（仅 turn），与 onJump 的映射对称。
    // 若 renderItems[renderIdx] 是 system 项，保持上次 activeTurnIndex 不变。
    const item = renderItems.value[renderIdx]
    if (item?.kind === 'turn') {
      activeTurnIndex.value = railTurns.value.findIndex((t) => t === item.turn)
    }
  }

  /**
   * rail jump：滚动到对应 turn 的 renderItems 下标。
   * idx 是 railTurns 数组下标，需映射回 renderItems 下标（系统提示行穿插使两者不一致）。
   * railTurns[idx] 已持有目标 turn 对象，直接用引用相等 findIndex（无需 O(n) 累计 turnCount）。
   *
   * [cw wave w4] 单一 virtua 路径：vlistRef.scrollToIndex(renderIdx, {align:'start'})。
   */
  function onJump(idx: number): void {
    const targetTurn = railTurns.value[idx]
    if (!targetTurn) return
    const renderIdx = renderItems.value.findIndex(
      (item) => item.kind === 'turn' && item.turn === targetTurn,
    )
    if (renderIdx < 0) return
    const v = deps.vlistRef.value
    if (!v) return
    v.scrollToIndex(renderIdx, { align: 'start' })
  }

  /** rail toggle：切该 turn 的展开态。
   *  idx 是 railTurns 下标 → 转成 turn 稳定 key（turnStableId，M5 stable-key；
   *  与 Turn.vue/TurnMeta 用的 key 派生一致，同 store 同分区）。 */
  function onToggle(idx: number): void {
    const turn = railTurns.value[idx]
    if (turn) toggle(turnStableId(turn))
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
