<!--
  展示组件 · queue_update 待发送队列（draft-composer-states S8）。
  v6 §8.5：内嵌 composer-box 顶部（不再独立卡片）——去独立 border/bg-accent-soft、
  去 PENDING/N排队中 标签和计数 badge、去 chevron（不支持收起）、去 pulse-accent 闪烁动画。
  仅 border-b 与下方输入区分隔，融入 composer-box bg-input 背景。
  内容：每条一行，Zap（steer，accent）/ Clock（followup，info）icon + truncate 文本；
  多条显前 3 条 + 「+N」。只读（入队后不可改/撤，pi 无 clear_queue RPC）。
  生命周期绑定 store：message_start 到达 → store queueStates.delete → v-if 消失。

  [M4 queue 子域] 数据源唯一：纯 props 展示（state 由 Composer 经 chatStore.getQueueState
  读 core queueStates，core/domain/chat/store.ts），组件内不取数不持状态。
-->
<template>
  <div
    v-if="state && hasAny"
    class="qb-inline border-b border-[color-mix(in_oklch,var(--accent)_18%,transparent)] px-3.5 pt-2 pb-1.5"
    data-testid="queue-bubble"
  >
    <div
      v-for="(item, i) in visibleItems"
      :key="i"
      class="qb-item flex items-center gap-1.5 py-0.5 text-[12px]"
    >
      <component
        :is="item.type === 'followUp' ? Clock : Zap"
        class="size-[13px] shrink-0"
        :class="item.type === 'followUp' ? 'text-info' : 'text-accent'"
      />
      <span class="qb-item-text min-w-0 flex-1 truncate text-neutral-fg">{{ item.text }}</span>
    </div>
    <div
      v-if="overflowCount > 0"
      class="mt-0.5 pl-[21px] text-[11px] text-neutral-dim"
    >
      +{{ overflowCount }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Clock, Zap } from '@lucide/vue'
import type { QueueState } from '@/stores/chat'

const props = defineProps<{
  state: QueueState | undefined
}>()

interface FlatItem {
  type: 'steering' | 'followUp'
  text: string
}

/** steering 优先于 followUp（对齐 pi 队列消费顺序），展平为单列表 */
const flatItems = computed<FlatItem[]>(() => {
  const s = props.state
  if (!s) return []
  const list: FlatItem[] = []
  if (s.steering?.length) list.push(...s.steering.map((text) => ({ type: 'steering' as const, text })))
  if (s.followUp?.length) list.push(...s.followUp.map((text) => ({ type: 'followUp' as const, text })))
  return list
})

const hasAny = computed(() => flatItems.value.length > 0)

/** 前 3 条可见（v6 §8.5：多条显前 2-3 条 + 「+N」） */
const VISIBLE_MAX = 3
const visibleItems = computed(() => flatItems.value.slice(0, VISIBLE_MAX))
const overflowCount = computed(() => Math.max(0, flatItems.value.length - VISIBLE_MAX))
</script>
