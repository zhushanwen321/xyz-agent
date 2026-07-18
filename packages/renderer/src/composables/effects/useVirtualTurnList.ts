/**
 * useVirtualTurnList —— 虚拟滚动核心算法（W1 effects 层，纯逻辑）。
 *
 * 窗口化策略（draft-message-stream SR/INVAR 体系）：
 * - computeWindow 二分查找定位 startIndex，向后累加定位 endIndex（AC-2）
 * - heights 用**首消息 id** 键（`turn.user?.id ?? turn.assistants[0]?.id`），不是 t-${index}
 *   → truncateFrom 重排后老索引键不会张冠李戴（SR1/D7）
 * - offsets 前缀和：offsets[i]=sum(heights[0..i-1])，totalHeight=sum(全部)（INVAR-3 等式守恒）
 * - 估算→实测视口锚定：视口上方 turn 首次实测时 scrollAdjustDelta 累加 measured-estimated，
 *   调用方据此补偿 scrollTop（应用后清零），防用户所见内容跳（SR4/INVAR-2）
 * - 末项钉扎：endIndex=max(computedEnd, lastIndex) 恒成立（SR3/INVAR-10）
 * - editing 钉扎：pinEditing(idx) 后 startIndex 不超过 idx（SR5）
 *
 * ── computeWindow 派生性（INVAR-1a）─────────────────────────────
 * 窗口依赖 (scrollTop, viewportHeight, offsets, buffer)，其中 scrollTop/viewportHeight
 * 由 onScrollUpdate 写入响应式 ref（scroll 事件回调内调用），offsets 来自 layout
 * computed（依赖 heights ref + renderItems）。纯滚动场景（messages/heights 不变、只有
 * scrollTop 变）也能触发 visibleRange 失效重算 → 窗口跟随滚动收敛。
 *
 * ── 响应式追踪链路 ──────────────────────────────────────────────
 * - heights 是 shallowRef（Map），reportHeight 内 triggerRef(heights) 触发依赖失效。
 * - scrollTop/viewportHeight 是 ref，onScrollUpdate 写入触发依赖失效。
 * - layout 是真 computed：内部访问 allEntries()（调 items()→读 renderItems.value，追踪
 *   renderItems 这个真 computed）+ heightForId()（读 heights.value，被 triggerRef 失效）。
 * - totalHeight/visibleRange 是真 computed，共享 layout 实例（避免重复 O(n)）。
 */
import { computed, ref, shallowRef, triggerRef, type ComputedRef, type Ref } from 'vue'
import type { RenderItem } from '@/composables/logic/messageTurns'

/** composable 入参：全部 getter，供调用方传 ref/computed/普通值 */
export interface UseVirtualTurnListOptions {
  /** 渲染项列表 getter（turn + system 穿插） */
  items: () => RenderItem[]
  /** 滚动容器 getter（读 scrollTop/clientHeight） */
  scrollEl: () => HTMLElement | null
  /** 未实测 turn 的估算高度 getter（px） */
  estimatedHeight: () => number
  /** 视口上下各 buffer 个 turn 的缓冲量 getter */
  buffer: () => number
}

/** 可见窗口 */
export interface VisibleRange {
  startIndex: number
  endIndex: number
}

/**
 * 取 RenderItem 的虚拟化键（heights Map 的键）。
 * - turn → 首消息 id（turn.user?.id ?? turn.assistants[0]?.id），truncateFrom 后被移除 turn 的 id 自然失效（SR1/D7）
 * - system → s-${message.id}，system 消息（compactionSummary/branchSummary/bashExecution）也参与虚拟化，
 *   不能丢弃（否则从 DOM 消失）。system 高度由 RO 上报（SystemNotice 内部也接 registry）或用估算。
 *
 * null 兜底为 `idx-${数组下标}` / `s-idx-${数组下标}`：itemKey 永不返回 null（防 DOM 仍渲染但 offset
 * 错位）。保留 null 类型签名以兼容未来扩展。
 */
function itemKey(item: RenderItem, idx: number): string | null {
  if (item.kind === 'turn') {
    return item.turn.user?.id ?? item.turn.assistants[0]?.id ?? `idx-${idx}`
  }
  // system 项：用 s-${message.id} 作键；无 id 时兜底 s-idx-${idx}（永不返回 null）
  return item.message.id ? `s-${item.message.id}` : `s-idx-${idx}`
}

export function useVirtualTurnList(options: UseVirtualTurnListOptions) {
  const { items, scrollEl, estimatedHeight, buffer } = options

  /**
   * heights Map：键=turn 首消息 id，值=实测高度。
   * 用 shallowRef 包（整体替换/触发语义），单键 set 后需显式 triggerRef（reportHeight 内处理）。
   */
  const heights = shallowRef<Map<string, number>>(new Map())
  /** editing 钉扎索引（pinEditing 设置，-1 表示无钉扎） */
  const editingPinIndex = ref(-1)
  /** 视口锚定补偿量：reportHeight 时若该 turn 在视口上方则累加 measured-旧值（调用方应用后清零） */
  const scrollAdjustDelta: Ref<number> = ref(0)

  /**
   * 响应式 scrollTop/viewportHeight：由 onScrollUpdate（调用方在 scroll 事件回调内调）
   * 写入，驱动 visibleRange 在纯滚动场景下失效重算（DOM scrollTop 本身非 reactive）。
   * 初始 0；scrollEl 挂载后调用方应立即调一次 onScrollUpdate 同步真值。
   */
  const scrollTop = ref(0)
  const viewportHeight = ref(0)

  /**
   * scroll 事件同步入口：调用方在 scroll handler 内调用，读取 DOM scrollTop/clientHeight
   * 写入响应式 ref，触发 visibleRange 失效重算。scrollEl 不存在时 no-op。
   */
  function onScrollUpdate(): void {
    const el = scrollEl()
    if (!el) return
    scrollTop.value = el.scrollTop
    viewportHeight.value = el.clientHeight
  }

  /** 取某 turn 的当前高度：实测优先，否则估算 */
  function heightForId(id: string): number {
    const measured = heights.value.get(id)
    return measured ?? estimatedHeight()
  }

  /**
   * 取参与虚拟滚动的所有项（turn + system，不丢弃 system 消息）+ 对应键。
   * system 消息（compactionSummary/branchSummary/bashExecution/bgNotify）也占高度，
   * 必须纳入 offset 计算和窗口判定，否则虚拟化后从 DOM 消失。
   * itemKey 带数组下标做兜底（永不返回 null），但保留 null 类型签名兼容未来扩展。
   */
  function allEntries(): Array<{ id: string; item: RenderItem }> {
    const out: Array<{ id: string; item: RenderItem }> = []
    const list = items()
    for (let i = 0; i < list.length; i++) {
      const id = itemKey(list[i], i)
      if (id !== null) out.push({ id, item: list[i] })
    }
    return out
  }

  /**
   * layout 真 computed：各 turn 的 offset（前缀和）与总高（INVAR-3）。
   * 依赖：allEntries()→items()→renderItems.value（真 computed，被追踪）+
   * heightForId()→heights.value（ref，被 triggerRef 失效）。heights/items 变化自动重算。
   * totalHeight/visibleRange/offsetOf 共享此实例，避免重复 O(n) computeLayout 调用。
   */
  const layout: ComputedRef<{ ids: string[]; offsets: number[]; total: number }> = computed(() => {
    const entries = allEntries()
    const n = entries.length
    const ids: string[] = new Array(n)
    const offsets: number[] = new Array(n)
    let total = 0
    for (let i = 0; i < n; i++) {
      ids[i] = entries[i].id
      offsets[i] = total
      total += heightForId(entries[i].id)
    }
    return { ids, offsets, total }
  })

  /** totalHeight：撑 spacer 高度。空态=0（SR12/INVAR-9，reduce 初值 0 防 NaN） */
  const totalHeight: ComputedRef<number> = computed(() => {
    const { total } = layout.value
    // Number.isFinite 兜底：极端情况下（NaN/Infinity）归零，绝不让 spacer NaN/负
    return Number.isFinite(total) && total >= 0 ? total : 0
  })

  /**
   * 取某 index 项的 offset（top 偏移），供 template absolute 定位（W3）。
   * 读 layout computed（heights/items 变化后自动最新）。
   */
  function offsetOf(idx: number): number {
    return layout.value.offsets[idx] ?? 0
  }

  /**
   * 可见窗口 { startIndex, endIndex }（AC-2 + INVAR-1a 纯派生）。
   *
   * 算法：
   * 1. 二分查找找首个 offset[i+1] > scrollTop - bufferHeight 的 i 作 startIndex
   *    （即 turn i 的底边超过「视口顶 - 上 buffer」）—— 视口上 buffer 区起点
   * 2. 从 startIndex 向后累加 heights 到累加和 > scrollTop + viewportHeight + bufferHeight
   *    作 computedEnd —— 视口下 buffer 区终点
   * 3. 末项钉扎（SR3/INVAR-10）：endIndex = max(computedEnd, lastIndex)
   * 4. editing 钉扎（SR5）：startIndex = min(startIndex, editingPinIndex) 若已钉
   */
  const visibleRange: ComputedRef<VisibleRange> = computed(() => {
    const st = scrollTop.value
    const vh = viewportHeight.value
    const buf = buffer()
    const estH = estimatedHeight()
    const bufferHeight = buf * estH

    const { ids, offsets } = layout.value
    const n = ids.length
    // 空态返回 endIndex=-1：调用方 `i <= endIndex` 自然空循环（i(0) <= -1 为 false），
    // 与 n=1 正常路径（endIndex 也=0）区分开，语义清晰。
    if (n === 0) return { startIndex: 0, endIndex: -1 }

    // 1. 二分：首个 i 使 offsets[i] + heightForId(ids[i]) > st - bufferHeight
    //    即 turn i 的底边超过 (st - bufferHeight) —— 它是首个需渲染的 turn
    const top = st - bufferHeight
    let lo = 0
    let hi = n - 1
    let startIndex = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const midBottom = offsets[mid] + heightForId(ids[mid])
      if (midBottom > top) {
        startIndex = mid
        hi = mid - 1 // 尝试更小
      } else {
        lo = mid + 1
      }
    }

    // 2. 从 startIndex 向后累加到 sum > st + vh + bufferHeight
    const bottom = st + vh + bufferHeight
    let acc = offsets[startIndex]
    let computedEnd = startIndex
    for (let i = startIndex; i < n; i++) {
      acc += heightForId(ids[i])
      computedEnd = i
      if (acc >= bottom) break
    }

    // 3. 末项钉扎（SR3/INVAR-10）：末项恒在窗口内
    let endIndex = Math.max(computedEnd, n - 1)
    if (endIndex >= n) endIndex = n - 1

    // 4. editing 钉扎（SR5）：startIndex 不超过 editingPinIndex
    if (editingPinIndex.value >= 0 && startIndex > editingPinIndex.value) {
      startIndex = editingPinIndex.value
      // 钉扎 startIndex 前移后，endIndex 至少要到 startIndex
      if (endIndex < startIndex) endIndex = startIndex
    }

    return { startIndex, endIndex }
  })

  /**
   * RO 上报实测高度入口（key=turn 首消息 id）。
   *
   * 视口锚定（SR4/INVAR-2）：该 turn 若在视口上方（offset + 旧高 <= scrollTop），
   * 则实测后内容会相对上移/下移 (measured - 旧高)，需补偿 scrollTop 同向移动。
   * scrollAdjustDelta 暴露本次补偿量；视口内/下方的 turn delta=0（视口内跳跃可接受）。
   */
  function reportHeight(key: string, h: number): void {
    const old = heights.value.get(key) ?? estimatedHeight()
    // 判定该 turn 是否在视口上方：用当前 offsets 找它的位置
    const st = scrollTop.value
    const { ids, offsets } = layout.value
    const idx = ids.indexOf(key)
    let delta = 0
    if (idx >= 0) {
      const turnBottom = offsets[idx] + old
      if (turnBottom <= st) {
        // 视口上方 turn：实测与估算/旧值之差需补偿（防用户所见内容跳）
        delta = h - old
      }
    }
    // 写入实测高度（增量更新单个键，Map 引用不变）
    heights.value.set(key, h)
    // 触发依赖失效：layout/totalHeight/visibleRange 内访问 heights.value，会被此处 trigger
    triggerRef(heights)
    // 累积补偿量（同帧多次视口上方 turn 上报时累加，防末次覆盖中间值；调用方读取应用后清零）
    scrollAdjustDelta.value += delta
  }

  /** editing 钉扎：startIndex 不超过 idx（防 lastUserTurn 滚出视口 draftText 丢失，SR5） */
  function pinEditing(idx: number): void {
    editingPinIndex.value = idx
  }

  /** session 切换重置：清空 heights，totalHeight 回全估算（SR10/INVAR-8） */
  function resetSession(): void {
    heights.value = new Map()
    scrollAdjustDelta.value = 0
    editingPinIndex.value = -1
  }

  return {
    totalHeight,
    visibleRange,
    offsetOf,
    reportHeight,
    scrollAdjustDelta,
    pinEditing,
    resetSession,
    onScrollUpdate,
  }
}
