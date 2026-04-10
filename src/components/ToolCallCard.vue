<script setup lang="ts">
import { computed } from 'vue'
import type { ToolCallDisplay } from '../types'
import { getToolDangerLevel } from '../types'

const props = defineProps<{
  toolCall: ToolCallDisplay
}>()

const dangerLevel = computed(() => getToolDangerLevel(props.toolCall.tool_name))

// error 状态优先于 dangerLevel，强制使用红色
const activeColor = computed(() =>
  props.toolCall.status === 'error' ? 'error' : dangerLevel.value
)

// 颜色映射：border / text / bg（带 08 透明度）
const colorMap = {
  safe:   { border: 'border-l-[#22c55e]', text: 'text-[#22c55e]', bg: 'bg-[#22c55e08]', spin: 'border-[#22c55e] border-t-transparent' },
  caution:{ border: 'border-l-[#eab308]', text: 'text-[#eab308]', bg: 'bg-[#eab30808]', spin: 'border-[#eab308] border-t-transparent' },
  error:  { border: 'border-l-[#ef4444]', text: 'text-[#ef4444]', bg: 'bg-[#ef444408]', spin: 'border-[#ef4444] border-t-transparent' },
}

const colors = computed(() => colorMap[activeColor.value])

function truncate(str: string, max: number): string {
  if (str.length <= max) return str
  return str.slice(0, max) + '...'
}

const inputSummary = computed(() => {
  const input = props.toolCall.input
  if (!input || typeof input !== 'object') return ''
  const entries = Object.entries(input as Record<string, unknown>).slice(0, 3)
  return entries.map(([k, v]) => `${k}: ${truncate(String(v), 60)}`).join('\n')
})

const statusLabel = computed(() => {
  switch (props.toolCall.status) {
    case 'running': return 'running...'
    case 'error': return 'failed'
    case 'completed': return 'done'
    default: return 'unknown'
  }
})
</script>

<template>
  <div
    class="rounded-md border border-border-default border-l-[3px] bg-bg-elevated text-sm"
    :class="colors.border"
  >
    <!-- Header -->
    <div class="flex items-center justify-between px-3 py-2" :class="colors.bg">
      <div class="flex items-center gap-2">
        <span
          v-if="toolCall.status === 'running'"
          class="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2"
          :class="colors.spin"
        />
        <span v-else class="font-mono text-xs font-bold" :class="colors.text">
          {{ toolCall.status === 'error' ? '\u2717' : '\u2713' }}
        </span>
        <span class="font-mono font-semibold text-text-primary">{{ toolCall.tool_name }}</span>
      </div>
      <span class="font-mono text-[11px]" :class="colors.text">{{ statusLabel }}</span>
    </div>

    <!-- 参数摘要 -->
    <pre
      v-if="inputSummary"
      class="px-3 mt-1.5 whitespace-pre-wrap font-mono text-xs text-text-secondary"
    >{{ inputSummary }}</pre>

    <!-- 输出区：默认展开 -->
    <div
      v-if="toolCall.output !== undefined && toolCall.status !== 'running'"
      class="mx-3 mt-2 mb-3 max-h-[300px] overflow-y-auto rounded-md border border-border-default bg-bg-inset p-2.5"
    >
      <pre class="whitespace-pre-wrap font-mono text-xs text-text-secondary">{{ toolCall.output }}</pre>
    </div>
  </div>
</template>
