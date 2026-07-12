<script setup lang="ts">
/**
 * 统计行组件——替代 TUI 的 "N turns · Nk · Ns"。
 * 水平排列键值对，item 间用 border-l 分隔（首项无分隔线）。
 * value 按 severity 着色，label 可选。
 */
import type { StatItem } from '@xyz-agent/extension-protocol'

defineProps<{
  items: StatItem[]
}>()

const valueClass = (severity?: 'ok' | 'warn' | 'danger') => {
  if (!severity) return 'text-fg'
  const map = { ok: 'text-success', warn: 'text-warning', danger: 'text-danger' } as const
  return map[severity]
}
</script>

<template>
  <div class="stats-line flex flex-wrap items-center gap-0 font-mono text-[12px]" data-testid="gui-stats-line">
    <div
      v-for="(item, i) in items"
      :key="i"
      class="stats-line__item flex items-center gap-1 px-3 first:pl-0"
      :class="{ 'border-l border-border': i > 0 }"
    >
      <span v-if="item.label" class="stats-line__label text-subtle">{{ item.label }}</span>
      <span class="stats-line__value font-medium tabular-nums" :class="valueClass(item.severity)">
        {{ item.value }}
      </span>
    </div>
  </div>
</template>
