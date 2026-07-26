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
import type { MessageTurn, RenderItem } from '@/composables/logic/messageTurns'
import { useTurnExpansion } from '@/composables/panel/useTurnExpansion'

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
}

export function useMessageStreamRail(deps: UseMessageStreamRailDeps): {
  railTurns: ComputedRef<MessageTurn[]>
  activeTurnIndex: Ref<number>
  panelRightEdge: Ref<number>
  updateActiveTurnIndex: () => void
  onJump: (idx: number) => void
  onToggle: (idx: number) => void
  onExpandAll: () => void
  onCollapseAll: () => void
} {
  const { sessionId, renderItems, scrollEl, offsetOf, topOffset } = deps

  /** rail 状态接入 useTurnExpansion（与 Turn.vue 共享同一 session Map）。 */
  const { toggle, expandAll, collapseAll } = useTurnExpansion(sessionId)

  /** rail 节点数据源：renderItems 中所有 turn（rail 列表渲染 + jump/toggle 索引空间）。 */
  const railTurns = computed<MessageTurn[]>(() =>
    renderItems.value.filter((item) => item.kind === 'turn').map((item) => item.turn),
  )

  /** 当前激活 turn 在 railTurns 中的下标（viewport indicator 位置 + active 节点高亮）。 */
  const activeTurnIndex = ref(0)

  /** 面板右边缘 px（rail 横向定位：贴面板左侧 8px，避免压住 composer/侧栏）。 */
  const panelRightEdge = ref(0)

  /**
   * 按 scrollTop 比例推算当前激活 turn 下标。
   * railTurns 为空时跳过（模板 v-if turns.length>0 守卫，但 computed ref 仍需防除零）。
   */
  function updateActiveTurnIndex(): void {
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
   */
  function onJump(idx: number): void {
    if (!scrollEl.value) return
    // 扫描 renderItems 跳过 system 项累计 turn 数，定位 railTurns[idx] 对应的 renderItems 下标。
    let turnCount = 0
    let renderIdx = 0
    for (let i = 0; i < renderItems.value.length; i += 1) {
      if (renderItems.value[i].kind === 'turn') {
        if (turnCount === idx) {
          renderIdx = i
          break
        }
        turnCount += 1
      }
    }
    scrollEl.value.scrollTop = offsetOf(renderIdx) + topOffset.value
  }

  /** rail toggle：切该 turn 的展开态。
   *  idx 是 railTurns 下标 → 转成 MessageTurn.index（与 Turn.vue 用的 props.turn.index 对齐）。 */
  function onToggle(idx: number): void {
    const turnIdx = railTurns.value[idx]?.index
    if (turnIdx != null) toggle(turnIdx)
  }

  /** rail unfold-all：批量展开全部 rail turns（用 MessageTurn.index 作 key） */
  function onExpandAll(): void {
    expandAll(railTurns.value.map((t) => t.index))
  }

  /** rail fold-all：批量折叠全部 rail turns（用 MessageTurn.index 作 key） */
  function onCollapseAll(): void {
    collapseAll(railTurns.value.map((t) => t.index))
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
    updateActiveTurnIndex,
    onJump,
    onToggle,
    onExpandAll,
    onCollapseAll,
  }
}
