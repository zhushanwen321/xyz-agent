<!--
  展示组件 · queue_update pending 气泡（spec C10 / FR-4，issues.md #13，code-architecture §4.7b）。
  Composer 上方独立行：按 draft-composer-states queue-bubble 风格，accent 边框 + 蓝点脉冲 +
  分组列表。两队列分色（draft §pending-bubble 同族）：
    - STEERING（accent 蓝）：追加引导当前回合，不打断
    - FOLLOWUP（info 青）：回合结束后开新轮排队

  纯展示型：props.state 由 Composer 从 chatStore.getQueueState(sessionId) 计算传入。
  生命周期绑定 store：message_start 到达 → store queueStates.delete → state=undefined
  → 本组件 v-if 失效自动消失（spec §4.7b 时序图）。

  QueueState 两字段皆可选 string[]；任一非空才渲染（hasAny）。同组多条用「·」连写以保持单行
  紧凑（draft queue-bubble 展开列表是未来增强，#13 验收只要「显示 steering/followUp」）。
-->
<template>
  <div
    v-if="state && hasAny"
    class="mb-1.5 overflow-hidden rounded-md border border-[rgba(79,142,247,0.45)] bg-[rgba(79,142,247,0.06)] text-[12px]"
  >
    <div
      v-for="(group, idx) in groups"
      :key="group.key"
      class="flex items-center gap-2 px-3 py-1.5"
      :class="idx > 0 ? 'border-t border-[rgba(79,142,247,0.18)]' : ''"
    >
      <span
        class="size-[7px] shrink-0 animate-pulse-accent rounded-full"
        :class="group.key === 'followUp' ? 'bg-info' : 'bg-accent'"
      />
      <span
        class="shrink-0 font-mono text-[10px] font-semibold tracking-wider"
        :class="group.key === 'followUp' ? 'text-info' : 'text-accent'"
      >{{ group.key === 'followUp' ? 'FOLLOWUP' : 'STEERING' }}</span>
      <span class="min-w-0 flex-1 truncate text-fg">{{ group.items.join(' · ') }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { QueueState } from '@/stores/chat'

const props = defineProps<{
  state: QueueState | undefined
}>()

interface QueueGroup {
  key: 'steering' | 'followUp'
  items: string[]
}

/** 非空分组（steering 优先于 followUp，对齐 pi 队列消费顺序） */
const groups = computed<QueueGroup[]>(() => {
  const s = props.state
  if (!s) return []
  const list: QueueGroup[] = []
  if (s.steering?.length) list.push({ key: 'steering', items: s.steering })
  if (s.followUp?.length) list.push({ key: 'followUp', items: s.followUp })
  return list
})

const hasAny = computed(() => groups.value.length > 0)
</script>
