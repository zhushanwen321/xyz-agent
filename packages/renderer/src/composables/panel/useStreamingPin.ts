/**
 * useStreamingPin —— streaming turn 钉扎（W3，bash↔streaming 共存防护）。
 *
 * 背景（对齐 editing 钉扎 SR5 模式）：w2 放开 bash↔streaming 并发后，共存场景下 bash 消息
 * append 到 messages 末尾成为虚拟列表末项（system item），streaming assistant turn 变成倒数第二项。
 * 用户向上滚动时 streaming turn 可能滚出视口顶部被卸载 → ResizeObserver 断开 → 高度不再更新 →
 * 布局错乱。本 composable 输出 pinnedIndexes（含 streaming turn idx + editing turn idx），
 * 供 virtua <Virtualizer :keepMounted> 消费，恒挂该项的 RO，从根上消除滚出视口致 RO 断开、
 * 高度不更新的隐患。
 *
 * 抽出独立 composable 的原因：MessageStream.vue `<script setup>` 行数规范上限 300，
 * 内联会超限。逻辑自洽（仅依赖 renderItems），适合独立封装。
 *
 * [cw wave w4 + cr-fix] 钉扎统一由 computed pinnedIndexes 输出（喂 virtua :keepMounted）。
 * [PR#116 review M3] 跨 session 重钉由 computed pinnedIndexes 自动承接：pinnedIndexes 依赖
 * streamingTurnIdx（派生自 items / sessionId），session 切换导致 items 重建时 computed 自动重算，
 * 无需 watch 副作用驱动（旧的空 watch 已删）。
 */
import { computed, type ComputedRef, type Ref } from 'vue'
import type { RenderItem } from '@/composables/logic/messageTurns'

export interface UseStreamingPinOptions {
  /** 渲染项列表 getter（turn + system 穿插），用于定位最后一个 turn 的数组下标 */
  items: ComputedRef<RenderItem[]>
  /** 当前 session id getter（捕获跨 session 切换，streaming→streaming 时强制重钉，M3） */
  sessionId: () => string
  /** 编辑中的 turn 下标（-1 表示无编辑），用于 virtua 多项钉扎（pinnedIndexes 输出）。 */
  editingTurnIdx?: ComputedRef<number> | Ref<number>
}

/**
 * @param items 渲染项列表（含末尾可能排着的 bash system item）
 * @param sessionId 当前 session id getter
 * @param editingTurnIdx 编辑中的 turn 下标（可选，virtua 多项钉扎用）
 *
 * watch 最后一个 turn 的 isStreaming：true 时该 turn idx 进入 pinnedIndexes，false 时移除。
 * （当前钉扎由 computed pinnedIndexes 派生，无 watch 副作用。）
 * lastTurnIdx 是 items 里最后一个 turn 的数组下标（bash system item 排在其后），
 * 钉扎逻辑作用于 startIndex（startIndex 不超过 lastTurnIdx），保证 streaming turn 不滚出视口顶部。
 *
 * [cw wave w4] 返回 pinnedIndexes（virtua 多项钉扎输出）：聚合「streaming turn idx」+
 * 「editing turn idx」去重过滤，喂 virtua <Virtualizer :keepMounted>（旧 pinStreaming 入参已于 w4 删除）。
 */
export function useStreamingPin(options: UseStreamingPinOptions): {
  /** 需要钉扎在窗口内的项下标数组（streaming turn idx + editing turn idx，去重过滤 < 0）。
   *  virtua 路径消费（<Virtualizer :keepMounted>）。 */
  pinnedIndexes: ComputedRef<number[]>
} {
  const { items } = options

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
   *  pinnedIndexes 消费此派生。 */
  const streamingTurnIdx = computed(() =>
    lastTurn.value?.isStreaming && lastTurnIdx.value >= 0 ? lastTurnIdx.value : -1,
  )

  /**
   * virtua 多项钉扎：聚合需恒在窗口内的项下标。
   * - streaming turn idx（streamingTurnIdx，末 turn isStreaming 时有值，否则 -1）
   * - editing turn idx（editingTurnIdx，可选；-1 表示无编辑）
   * 去重 + 过滤 < 0。virtua 路径消费（<Virtualizer :keepMounted>）。
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
