/**
 * useStreamingPin —— streaming turn 钉扎（W3，bash↔streaming 共存防护）。
 *
 * 背景（对齐 editing 钉扎 SR5 模式）：w2 放开 bash↔streaming 并发后，共存场景下 bash 消息
 * append 到 messages 末尾成为虚拟列表末项（system item），streaming assistant turn 变成倒数第二项。
 * 用户向上滚动时 streaming turn 可能滚出视口顶部被卸载 → ResizeObserver 断开 → 高度不再更新 →
 * 布局错乱。本 composable watch 最后一个 turn 的 isStreaming 标志，true 时 pinStreaming(idx)
 * 钉住该 turn 恒在窗口内，false 时释放（pinStreaming(-1)）。
 *
 * 抽出独立 composable 的原因：MessageStream.vue `<script setup>` 行数规范上限 300，
 * 内联 watch 会超限。逻辑自洽（仅依赖 renderItems + pinStreaming），适合独立封装。
 *
 * [PR#116 review M3] watch 必须满足三点才不漏钉：
 * 1. `{ immediate: true }` —— 挂载时若末 turn 已 streaming（boolean 之后无变化），非 immediate
 *    watch 永不触发 → pinStreaming 保持 -1 → 用户上滚时 streaming turn 可被卸载（RO 断开）。
 * 2. watch 源包含 sessionId —— 跨 session 切换 streaming→streaming 时派生布尔值不变，若不追踪
 *    session 信号则 watch 不触发 → 钉扎不重新施加。sessionId getter 由 MessageStream 传入
 *    （最可靠：items.length 不一定随 session 变化，lastTurnIdx 也不保证变）。
 * 3. `{ flush: 'post' }` —— MessageStream 的 resetSession watch（line ~429，default pre flush，
 *    注册在 useStreamingPin 之后）会清 streamingPinIndex=-1。pre-flush watch 按注册顺序触发，
 *    reset 后跑会覆盖本 composable 重新施加的 pin。flush:post 让本 watch 在 DOM 更新后（reset
 *    之后）跑，保证重钉生效。immediate 回调在 setup 同步执行（与 flush 无关），挂载场景不受影响。
 */
import { computed, watch, type ComputedRef, type Ref } from 'vue'
import type { RenderItem } from '@/composables/logic/messageTurns'

export interface UseStreamingPinOptions {
  /** 渲染项列表 getter（turn + system 穿插），用于定位最后一个 turn 的数组下标 */
  items: ComputedRef<RenderItem[]>
  /** pinStreaming 入口（来自 useVirtualTurnList），idx>=0 钉扎、-1 释放 */
  pinStreaming: (idx: number) => void
  /** 当前 session id getter（捕获跨 session 切换，streaming→streaming 时强制重钉，M3） */
  sessionId: () => string
  /** [cw wave w2] 编辑中的 turn 下标（-1 表示无编辑），用于 virtua 多项钉扎（pinnedIndexes 输出）。
   *  w2 由 MessageStream.vue 不传（仍仅用 pinStreaming 单钉），w3 切换到 virtua 后传入。 */
  editingTurnIdx?: ComputedRef<number> | Ref<number>
}

/**
 * @param items 渲染项列表（含末尾可能排着的 bash system item）
 * @param pinStreaming useVirtualTurnList 的 pinStreaming
 * @param sessionId 当前 session id getter
 * @param editingTurnIdx 编辑中的 turn 下标（可选，virtua 多项钉扎用）
 *
 * watch 最后一个 turn 的 isStreaming：true 钉住该 turn 在窗口内，false 释放。
 * lastTurnIdx 是 items 里最后一个 turn 的数组下标（bash system item 排在其后），
 * 钉扎逻辑作用于 startIndex（startIndex 不超过 lastTurnIdx），保证 streaming turn 不滚出视口顶部。
 *
 * [cw wave w2] 新增返回 pinnedIndexes（virtua 多项钉扎输出）：聚合「streaming turn idx」+
 * 「editing turn idx」去重过滤。保留 pinStreaming 调用（旧路径单钉，w2 MessageStream.vue 仍用），
 * w3 切换到 virtua 后消费 pinnedIndexes（virtualList.pinIndexes 数组入口）。
 */
export function useStreamingPin(options: UseStreamingPinOptions): {
  /** 需要钉扎在窗口内的项下标数组（streaming turn idx + editing turn idx，去重过滤 < 0）。
   *  w3 virtua 路径消费（virtualList.pinIndexes）；w2 旧路径忽略此返回值。 */
  pinnedIndexes: ComputedRef<number[]>
} {
  const { items, pinStreaming, sessionId } = options

  /** items 里最后一个 turn 的数组下标（跳过末尾 system item，如 bash 消息） */
  const lastTurnIdx = computed(() => {
    const list = items.value
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const item = list[i]
      if (item && item.kind === 'turn') return i
    }
    return -1
  })

  /** 最后一个 turn（已跳过末尾 system item），用于读 isStreaming（避免对联合类型用可选链不收窄） */
  const lastTurn = computed(() => {
    const idx = lastTurnIdx.value
    if (idx < 0) return null
    const item = items.value[idx]
    return item && item.kind === 'turn' ? item.turn : null
  })

  /** 当前 streaming turn 的数组下标（末 turn isStreaming 时 = lastTurnIdx，否则 -1）。
   *  pinnedIndexes 与 pinStreaming watch 共用此派生，避免两处重复判定。 */
  const streamingTurnIdx = computed(() =>
    lastTurn.value?.isStreaming && lastTurnIdx.value >= 0 ? lastTurnIdx.value : -1,
  )

  // watch 源用 [isStreaming, sessionId] 数组：sessionId 变化时强制重算（M3 跨 session streaming→streaming）。
  // immediate: 挂载时已 streaming 也施加 pin（M3 挂载场景）。
  // flush:post: 在 resetSession(pre flush) 之后跑，保证重钉不被覆盖（详见文件头注释 M3-3）。
  watch(
    [() => lastTurn.value?.isStreaming ?? false, sessionId],
    ([streaming]) => {
      pinStreaming(streaming && lastTurnIdx.value >= 0 ? lastTurnIdx.value : -1)
    },
    { immediate: true, flush: 'post' },
  )

  /**
   * [cw wave w2] virtua 多项钉扎：聚合需恒在窗口内的项下标。
   * - streaming turn idx（streamingTurnIdx，末 turn isStreaming 时有值，否则 -1）
   * - editing turn idx（editingTurnIdx，可选；-1 表示无编辑）
   * 去重 + 过滤 < 0。w3 virtua 路径消费（virtualList.pinIndexes 数组入口）。
   */
  const pinnedIndexes = computed<number[]>(() => {
    const idxs: number[] = []
    const streamIdx = streamingTurnIdx.value
    if (streamIdx >= 0) idxs.push(streamIdx)
    const editIdx = options.editingTurnIdx?.value ?? -1
    if (editIdx >= 0 && !idxs.includes(editIdx)) idxs.push(editIdx)
    return idxs
  })

  return { pinnedIndexes }
}
