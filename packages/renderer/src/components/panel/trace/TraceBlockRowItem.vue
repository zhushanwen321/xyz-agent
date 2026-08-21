<template>
  <!--
    展示组件 · trace-block-row-item（assistant 聚合行展开后的子 block 行，纯展示层派生）。
    缩进 + block 类型 badge（BLOCK_BADGE_CLASS）+ 首行摘要（core blockHeadline）；
    点击选中该 block（selectedKey = traceBlockKey(parent.key, index)）→ inspector
    显示 block 全文。headline 空时以 badge 标签兜底（与行 headline 契约同款）。
  -->
  <div
    class="flex cursor-pointer items-center gap-2 rounded-sm py-[5px] pl-11 pr-2 transition-colors duration-[var(--duration-fast)] ease-[var(--ease)] hover:bg-surface-2"
    :class="selected ? 'bg-surface-hover hover:bg-surface-hover' : ''"
    :data-testid="`trace-block-row-${parent.seq}-${index}`"
    :data-block-kind="blockBadgeLabel(block)"
    :title="headline || blockBadgeLabel(block)"
    @click="emit('select', traceBlockKey(parent.key, index))"
  >
    <span
      class="w-14 flex-shrink-0 rounded px-1.5 py-px font-mono text-[10px] tracking-wide"
      :class="BLOCK_BADGE_CLASS[block.kind]"
    >{{ blockBadgeLabel(block) }}</span>
    <span
      class="min-w-0 flex-1 truncate text-[12px]"
      :class="[
        selected ? 'text-accent' : block.kind === 'thinking' ? 'text-neutral-mid' : 'text-neutral-fg',
      ]"
    >{{ headline || blockBadgeLabel(block) }}</span>
  </div>
</template>

<script setup lang="ts">
/**
 * 子 block 行渲染。headline 纯数据展示（trace-display-items 派生产物），
 * 选中 key 经 traceBlockKey 组装（展示层 block 寻址 SSOT）。
 */
import type { TraceContentBlock, TraceRow } from '@xyz-agent/core/domain/session-trace'
import { traceBlockKey } from '@/composables/features/trace/trace-display-items'
import { BLOCK_BADGE_CLASS, blockBadgeLabel } from './trace-kind-style'

defineProps<{
  parent: TraceRow
  index: number
  block: TraceContentBlock
  headline: string
  selected: boolean
}>()

const emit = defineEmits<{ select: [key: string] }>()
</script>
