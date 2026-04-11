<script setup lang="ts">
import { ref, computed } from 'vue'
import type { TaskNode } from '../types'

const props = defineProps<{ task: TaskNode }>()
const isExpanded = ref(false)

const statusIcon = computed(() => {
  switch (props.task.status) {
    case 'running': return 'spinner'
    case 'completed': return 'check'
    case 'failed': return 'x'
    case 'budget_exhausted': return 'zap'
    default: return 'clock'
  }
})

const statusColor = computed(() => {
  switch (props.task.status) {
    case 'running': return 'text-blue-400'
    case 'completed': return 'text-green-400'
    case 'failed': return 'text-red-400'
    case 'budget_exhausted': return 'text-yellow-400'
    case 'killed': return 'text-zinc-500'
    case 'paused': return 'text-yellow-500'
    default: return 'text-zinc-400'
  }
})

const borderColor = computed(() => {
  switch (props.task.status) {
    case 'running': return 'border-l-blue-500'
    case 'completed': return 'border-l-green-500'
    case 'failed': return 'border-l-red-500'
    default: return 'border-l-zinc-600'
  }
})

const progressPercent = computed(() =>
  Math.min(100, (props.task.usage.total_tokens / props.task.budget.max_tokens) * 100)
)

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

const statusLabel = computed(() => {
  if (props.task.status === 'running') return 'running...'
  if (props.task.status === 'completed') return 'done'
  if (props.task.status === 'failed') return 'failed'
  if (props.task.status === 'killed') return 'killed'
  if (props.task.status === 'paused') return 'paused'
  if (props.task.status === 'budget_exhausted') return 'budget exhausted'
  return props.task.status
})

const emit = defineEmits<{
  openTab: [id: string]
  kill: []
}>()
</script>

<template>
  <div
    class="rounded-md border border-border-default border-l-[3px] bg-bg-elevated text-[13px]"
    :class="borderColor"
  >
    <!-- 头部：类型 + 描述 + token + 状态 -->
    <div
      class="flex items-center justify-between px-2.5 py-1.5 cursor-pointer select-none"
      @click="isExpanded = !isExpanded"
    >
      <div class="flex items-center gap-2 min-w-0">
        <!-- 运行中显示 spinner，否则显示状态图标 -->
        <span
          v-if="statusIcon === 'spinner'"
          class="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-blue-400 border-t-transparent"
        />
        <span v-else class="font-mono text-[10px] font-bold" :class="statusColor">
          {{ statusIcon === 'check' ? '\u2713' : statusIcon === 'x' ? '\u2717' : statusIcon === 'zap' ? '\u26A1' : '\u23F0' }}
        </span>
        <span class="text-text-secondary font-mono text-[10px]">λ</span>
        <span class="font-mono font-semibold text-text-primary truncate">
          {{ task.subagent_type ?? 'agent' }}
        </span>
        <span class="text-text-secondary truncate text-[11px]">
          {{ task.description.length > 40 ? task.description.slice(0, 40) + '...' : task.description }}
        </span>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <span class="font-mono text-[10px] text-text-secondary">
          {{ formatTokens(task.usage.total_tokens) }}tok
        </span>
        <span class="font-mono text-[10px]" :class="statusColor">{{ statusLabel }}</span>
      </div>
    </div>

    <!-- 进度条 -->
    <div v-if="task.status === 'running'" class="mx-2.5 mb-1.5 h-1 bg-zinc-700 rounded-full overflow-hidden">
      <div class="h-full bg-blue-500 rounded-full transition-all duration-300" :style="{ width: `${progressPercent}%` }" />
    </div>

    <!-- 展开详情 -->
    <div v-if="isExpanded" class="border-t border-border-default px-2.5 py-2 space-y-1">
      <div class="flex justify-between text-[11px]">
        <span class="text-text-secondary">tool calls</span>
        <span class="text-text-primary font-mono">{{ task.usage.tool_uses }}</span>
      </div>
      <div class="flex justify-between text-[11px]">
        <span class="text-text-secondary">duration</span>
        <span class="text-text-primary font-mono">{{ (task.usage.duration_ms / 1000).toFixed(1) }}s</span>
      </div>
      <div class="flex justify-between text-[11px]">
        <span class="text-text-secondary">mode</span>
        <span class="text-text-primary font-mono">{{ task.mode }}</span>
      </div>
      <div class="flex justify-between text-[11px]">
        <span class="text-text-secondary">budget</span>
        <span class="text-text-primary font-mono">{{ formatTokens(task.budget.max_tokens) }} / {{ task.budget.max_turns }} turns</span>
      </div>
    </div>
  </div>
</template>
