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
 */
import { computed, watch } from 'vue'
import type { ComputedRef } from 'vue'
import type { RenderItem } from '@/composables/logic/messageTurns'

export interface UseStreamingPinOptions {
  /** 渲染项列表 getter（turn + system 穿插），用于定位最后一个 turn 的数组下标 */
  items: ComputedRef<RenderItem[]>
  /** pinStreaming 入口（来自 useVirtualTurnList），idx>=0 钉扎、-1 释放 */
  pinStreaming: (idx: number) => void
}

/**
 * @param items 渲染项列表（含末尾可能排着的 bash system item）
 * @param pinStreaming useVirtualTurnList 的 pinStreaming
 *
 * watch 最后一个 turn 的 isStreaming：true 钉住该 turn 在窗口内，false 释放。
 * lastTurnIdx 是 items 里最后一个 turn 的数组下标（bash system item 排在其后），
 * 钉扎逻辑作用于 startIndex（startIndex 不超过 lastTurnIdx），保证 streaming turn 不滚出视口顶部。
 */
export function useStreamingPin(options: UseStreamingPinOptions): void {
  const { items, pinStreaming } = options

  /** items 里最后一个 turn 的数组下标（跳过末尾 system item，如 bash 消息） */
  const lastTurnIdx = computed(() => {
    const list = items.value
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i]!.kind === 'turn') return i
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

  watch(
    () => lastTurn.value?.isStreaming ?? false,
    (streaming) => {
      pinStreaming(streaming && lastTurnIdx.value >= 0 ? lastTurnIdx.value : -1)
    },
  )
}
