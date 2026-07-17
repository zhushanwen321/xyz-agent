/**
 * useVirtualTurnList —— 虚拟滚动核心算法（W1 effects 层，纯逻辑）。
 *
 * 窗口化策略（draft-message-stream SR/INVAR 体系）：
 * - computeWindow 二分查找定位 startIndex，向后累加定位 endIndex（AC-2）
 * - heights 用**首消息 id** 键（`turn.user?.id ?? turn.assistants[0]?.id`），不是 t-${index}
 *   → truncateFrom 重排后老索引键不会张冠李戴（SR1/D7）
 * - offsets 前缀和：offsets[i]=sum(heights[0..i-1])，totalHeight=sum(全部)（INVAR-3 等式守恒）
 * - 估算→实测视口锚定：视口上方 turn 首次实测时 scrollAdjustDelta=measured-estimated，
 *   调用方据此补偿 scrollTop，防用户所见内容跳（SR4/INVAR-2）
 * - 末项钉扎：endIndex=max(computedEnd, lastIndex) 恒成立（SR3/INVAR-10）
 * - editing 钉扎：pinEditing(idx) 后 startIndex 不超过 idx（SR5）
 *
 * ── computeWindow 派生性（INVAR-1a）─────────────────────────────
 * 窗口只依赖 (scrollTop, viewportHeight, offsets, buffer) 这些标量，不依赖 renderItems
 * 的数组身份。renderItems 每 token 重建数组（新对象）本身不触发窗口重算——窗口随
 * scrollTop/heights 变化而变。
 *
 * ── 非响应式 items 适配 ────────────────────────────────────────
 * 测试与部分调用方通过 getter 传入**普通数组**（非 ref/reactive），对其做 splice
 * （truncateFrom / 每 token 重建）Vue 响应式无法感知。故 totalHeight/visibleRange 采用
 * 「每次 .value 访问重读 getter」的 live ref：普通数组 splice 后下次访问即得新值。
 * 生产侧 renderItems 为真正的 computed（MessageStream.vue），live ref 在其 effect
 * 重新运行时同样能读到最新值——响应式不回退。
 */
import { ref, triggerRef, type ComputedRef, type Ref } from 'vue'
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

/** 取 turn 的首消息 id（heights Map 的键）。system 项无 turn，返回 null */
function firstMessageId(item: RenderItem): string | null {
  if (item.kind !== 'turn') return null
  const turn = item.turn
  return turn.user?.id ?? turn.assistants[0]?.id ?? null
}

/**
 * 「活计算 ref」：每次 .value 访问都重跑 fn。
 *
 * 用途：当数据源是普通数组（非响应式）时，computed 会缓存旧值无法感知 splice；
 * live ref 每次 access 重读 getter，保证普通数组变更后立即得到最新结果。
 * 对真正的响应式源（ref/computed）也能正确取值——其依赖在消费方 effect 内被追踪。
 */
function liveComputed<T>(fn: () => T): ComputedRef<T> {
  return { get value(): T { return fn() } } as unknown as ComputedRef<T>
}

export function useVirtualTurnList(options: UseVirtualTurnListOptions) {
  const { items, scrollEl, estimatedHeight, buffer } = options

  /**
   * heights Map：键=turn 首消息 id，值=实测高度。
   * 用 ref 包普通 Map，变更需 triggerRef（reportHeight 内处理）。
   */
  const heights = ref<Map<string, number>>(new Map())
  /** editing 钉扎索引（pinEditing 设置，-1 表示无钉扎） */
  const editingPinIndex = ref(-1)
  /** 视口锚定补偿量：reportHeight 时若该 turn 在视口上方则设为 measured-旧值 */
  const scrollAdjustDelta: Ref<number> = ref(0)

  /** 取某 turn 的当前高度：实测优先，否则估算 */
  function heightForId(id: string): number {
    const measured = heights.value.get(id)
    return measured ?? estimatedHeight()
  }

  /** 取参与虚拟滚动的 turn 项（过滤 system 提示行）+ 对应首消息 id */
  function turnEntries(): Array<{ id: string; item: Extract<RenderItem, { kind: 'turn' }> }> {
    const out: Array<{ id: string; item: Extract<RenderItem, { kind: 'turn' }> }> = []
    for (const item of items()) {
      if (item.kind !== 'turn') continue
      const id = firstMessageId(item)
      if (id !== null) out.push({ id, item })
    }
    return out
  }

  /**
   * 计算各 turn 的 offset（前缀和）与总高（INVAR-3）。
   * 每帧调用——非缓存，因 heights/items 随时变；规模通常 <1000，O(n) 可接受。
   * 返回 { ids, offsets, total }：offsets[i]=sum(heights[0..i-1])，total=sum(全部)。
   */
  function computeLayout(): {
    ids: string[]
    offsets: number[]
    total: number
  } {
    const entries = turnEntries()
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
  }

  /** totalHeight：撑 spacer 高度。空态=0（SR12/INVAR-9，reduce 初值 0 防 NaN） */
  const totalHeight: ComputedRef<number> = liveComputed(() => {
    const { total } = computeLayout()
    // Number.isFinite 兜底：极端情况下（NaN/Infinity）归零，绝不让 spacer NaN/负
    return Number.isFinite(total) && total >= 0 ? total : 0
  })

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
  const visibleRange: ComputedRef<VisibleRange> = liveComputed(() => {
    const el = scrollEl()
    const scrollTop = el?.scrollTop ?? 0
    const viewportHeight = el?.clientHeight ?? 0
    const buf = buffer()
    const estH = estimatedHeight()
    const bufferHeight = buf * estH

    const { ids, offsets } = computeLayout()
    const n = ids.length
    if (n === 0) return { startIndex: 0, endIndex: 0 }

    // 1. 二分：首个 i 使 offsets[i] + heightForId(ids[i]) > scrollTop - bufferHeight
    //    即 turn i 的底边超过 (scrollTop - bufferHeight) —— 它是首个需渲染的 turn
    const top = scrollTop - bufferHeight
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

    // 2. 从 startIndex 向后累加到 sum > scrollTop + viewportHeight + bufferHeight
    const bottom = scrollTop + viewportHeight + bufferHeight
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
    const el = scrollEl()
    const scrollTop = el?.scrollTop ?? 0
    const { ids, offsets } = computeLayout()
    const idx = ids.indexOf(key)
    let delta = 0
    if (idx >= 0) {
      const turnBottom = offsets[idx] + old
      if (turnBottom <= scrollTop) {
        // 视口上方 turn：实测与估算/旧值之差需补偿（防用户所见内容跳）
        delta = h - old
      }
    }
    // 写入实测高度（增量更新单个键，Map 引用不变）
    heights.value.set(key, h)
    // 通知任何把 heights 当真 ref 依赖的消费者（liveComputed 每次 access 自取最新，
    // 不依赖此触发；保留是为兼容未来改成真 computed 的消费路径）
    triggerRef(heights)
    // 暴露补偿量（每次 reportHeight 覆盖；调用方读取后可自行清零）
    scrollAdjustDelta.value = delta
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
    reportHeight,
    scrollAdjustDelta,
    pinEditing,
    resetSession,
  }
}
