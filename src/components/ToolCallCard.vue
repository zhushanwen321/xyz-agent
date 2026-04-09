<script setup lang="ts">
import { ref, computed } from 'vue'
import type { ToolCallDisplay } from '../types'

const props = defineProps<{
  toolCall: ToolCallDisplay
}>()

const isExpanded = ref(false)

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

/* 左边框颜色随状态变化 */
const borderClass = computed(() => {
  switch (props.toolCall.status) {
    case 'running': return 'border-l-accent'
    case 'completed': return 'border-l-accent'
    case 'error': return 'border-l-accent-red'
  }
})
</script>

<template>
  <div
    class="rounded-md border border-border-default border-l-[3px] bg-bg-elevated px-3 py-2 text-sm"
    :class="borderClass"
  >
    <!-- 标题行: 工具名 + 状态 -->
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-2">
        <!-- 状态图标 -->
        <span
          v-if="toolCall.status === 'running'"
          class="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-accent border-t-transparent"
        />
        <span
          v-else
          class="font-mono text-xs font-bold"
          :class="toolCall.status === 'error' ? 'text-accent-red' : 'text-accent'"
        >
          {{ toolCall.status === 'error' ? 'x' : 'ok' }}
        </span>

        <!-- 工具名 -->
        <span class="font-mono font-semibold text-text-primary">{{ toolCall.tool_name }}</span>
      </div>

      <span class="font-mono text-[11px] text-text-tertiary">{{ statusLabel }}</span>
    </div>

    <!-- 参数摘要 -->
    <pre
      v-if="inputSummary"
      class="mt-1.5 whitespace-pre-wrap font-mono text-xs text-text-secondary"
    >{{ inputSummary }}</pre>

    <!-- 结果折叠面板 -->
    <div v-if="toolCall.output !== undefined && toolCall.status !== 'running'" class="mt-2">
      <button
        class="flex items-center gap-1 font-mono text-[11px] text-text-tertiary transition-colors hover:text-text-primary"
        @click="isExpanded = !isExpanded"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          class="h-3 w-3 transition-transform"
          :class="{ 'rotate-90': isExpanded }"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
        {{ isExpanded ? 'hide output' : 'show output' }}
      </button>
      <div
        v-if="isExpanded"
        class="mt-1.5 max-h-[300px] overflow-y-auto rounded-md border border-border-default bg-bg-inset p-2.5"
      >
        <pre class="whitespace-pre-wrap font-mono text-xs text-text-secondary">{{ toolCall.output }}</pre>
      </div>
    </div>
  </div>
</template>
