<script setup lang="ts">
import { computed } from 'vue'
import type { TaskNode } from '../types'
import { formatTokensAlways as formatTokens } from '../lib/format'
import { getTaskStatusColor, getTaskBorderColor } from '../lib/status'
import { Button } from '@/components/ui/button'

const props = defineProps<{ task: TaskNode }>()

const statusIcon = computed(() => {
  switch (props.task.status) {
    case 'running': return 'spinner'
    case 'completed': return 'check'
    case 'failed': return 'x'
    case 'budget_exhausted': return 'zap'
    default: return 'clock'
  }
})

const statusChar = computed(() => {
  switch (statusIcon.value) {
    case 'check': return '\u2713'
    case 'x': return '\u2717'
    case 'zap': return '\u26A1'
    default: return '\u23F0'
  }
})

const statusColor = computed(() => getTaskStatusColor(props.task.status))
const borderColor = computed(() => getTaskBorderColor(props.task.status))

const progressPercent = computed(() =>
  props.task.budget.max_tokens > 0
    ? Math.min(100, (props.task.usage.total_tokens / props.task.budget.max_tokens) * 100)
    : 0
)

const statusLabel = computed(() => {
  switch (props.task.status) {
    case 'running': return 'running...'
    case 'completed': return 'done'
    case 'failed': return 'failed'
    case 'killed': return 'killed'
    case 'paused': return 'paused'
    case 'budget_exhausted': return 'budget exhausted'
    default: return props.task.status
  }
})

const emit = defineEmits<{
  openTab: [id: string]
  kill: []
}>()
</script>

<template>
  <div
    class="group rounded-md border border-border-default border-l-[3px] bg-elevated text-[13px] cursor-pointer transition-colors hover:border-[#3b82f6] hover:bg-[#18181b]"
    :class="borderColor"
    @click="emit('openTab', task.task_id)"
  >
    <!-- 头部：类型 + 描述 + token + 状态 -->
    <div class="flex items-center justify-between px-2.5 py-1.5 select-none">
      <div class="flex items-center gap-2 min-w-0">
        <!-- 运行中显示 spinner，否则显示状态图标 -->
        <span
          v-if="statusIcon === 'spinner'"
          class="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-semantic-blue border-t-transparent"
        />
        <span v-else class="font-mono text-[10px] font-bold" :class="statusColor">
          {{ statusChar }}
        </span>
        <span class="text-muted-foreground font-mono text-[10px]">&#x03BB;</span>
        <span class="font-mono font-semibold text-foreground truncate">
          {{ task.subagent_type ?? 'agent' }}
        </span>
        <span class="text-muted-foreground truncate text-[11px]">
          {{ task.description.length > 40 ? task.description.slice(0, 40) + '...' : task.description }}
        </span>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <span class="font-mono text-[10px] text-muted-foreground">
          {{ formatTokens(task.usage.total_tokens) }}tok
        </span>
        <span class="font-mono text-[10px]" :class="statusColor">{{ statusLabel }}</span>
        <!-- Kill 按钮：仅 running 状态显示 -->
        <Button
          v-if="task.status === 'running'"
          variant="ghost"
          size="icon-sm"
          class="shrink-0 text-muted-foreground hover:text-red-400"
          title="Kill"
          @click.stop="emit('kill')"
        >
          <span class="text-[10px]">&#x2715;</span>
        </Button>
      </div>
    </div>

    <!-- 进度条 -->
    <div v-if="task.status === 'running'" class="mx-2.5 mb-1.5 h-1 bg-elevated rounded-full overflow-hidden">
      <div class="h-full bg-semantic-blue rounded-full transition-all duration-300" :style="{ width: `${progressPercent}%` }" />
    </div>

    <!-- Hover hint -->
    <div class="px-2.5 pb-1.5 text-[10px] text-semantic-blue opacity-0 group-hover:opacity-100 transition-opacity">
      Click to open tab &rarr;
    </div>
  </div>
</template>
