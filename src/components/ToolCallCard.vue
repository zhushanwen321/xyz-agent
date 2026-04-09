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
    case 'running': return '执行中...'
    case 'error': return '失败'
    case 'completed': return '完成'
  }
})
</script>

<template>
  <div
    class="my-1.5 rounded-lg border px-3 py-2 text-sm"
    :class="{
      'border-blue-300/60 bg-blue-50/50 dark:bg-blue-950/20': toolCall.status === 'running',
      'border-green-300/60 bg-green-50/50 dark:bg-green-950/20': toolCall.status === 'completed',
      'border-red-300/60 bg-red-50/50 dark:bg-red-950/20': toolCall.status === 'error',
    }"
  >
    <!-- 工具名 + 状态 -->
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-2">
        <!-- spinner -->
        <span
          v-if="toolCall.status === 'running'"
          class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-blue-400 border-t-transparent"
        />
        <!-- check / cross -->
        <span v-else class="text-xs font-bold" :class="toolCall.status === 'error' ? 'text-red-500' : 'text-green-600'">
          {{ toolCall.status === 'error' ? 'x' : '✓' }}
        </span>
        <span class="font-medium">{{ toolCall.tool_name }}</span>
      </div>
      <span class="text-xs opacity-50">{{ statusLabel }}</span>
    </div>

    <!-- 参数摘要 -->
    <pre v-if="inputSummary" class="mt-1 whitespace-pre-wrap text-xs opacity-70 font-mono">{{ inputSummary }}</pre>

    <!-- 结果折叠面板 -->
    <div v-if="toolCall.output !== undefined && toolCall.status !== 'running'" class="mt-1.5">
      <button
        class="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
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
        {{ isExpanded ? '收起结果' : '查看结果' }}
      </button>
      <div v-if="isExpanded" class="mt-1 max-h-[300px] overflow-y-auto rounded bg-background/50 p-2">
        <pre class="whitespace-pre-wrap text-xs font-mono">{{ toolCall.output }}</pre>
      </div>
    </div>
  </div>
</template>
