<template>
  <div class="p-0" :data-status="toolCall.status">
  <!-- Summary -->
  <div v-if="renderDesc?.summary" class="px-2.5 py-1.5 text-xs text-muted border-b border-border">
    {{ renderDesc.summary }}
  </div>

  <!-- task-list -->
  <div v-if="renderType === 'task-list'" class="px-2.5 py-1.5">
    <div v-for="item in taskItems" :key="item.id" class="mb-1 last:mb-0">
      <div class="flex items-start gap-1.5 text-xs leading-relaxed">
        <span class="shrink-0 mt-px" :class="statusColor(item.status)">{{ statusIcon(item.status) }}</span>
        <span class="text-fg">{{ item.text }}</span>
      </div>
      <!-- sub-items -->
      <div v-if="item.subItems?.length" class="ml-4 mt-0.5">
        <div v-for="sub in item.subItems" :key="sub.id" class="flex items-start gap-1.5 text-xs leading-relaxed">
          <span class="shrink-0 mt-px text-muted">-</span>
          <span :class="statusColor(sub.status)">{{ sub.text }}</span>
        </div>
      </div>
      <!-- evidence -->
      <div v-if="item.evidence && item.status === 'completed'" class="ml-4 mt-0.5 text-[11px] text-muted italic">
        {{ item.evidence }}
      </div>
    </div>
    <!-- meta -->
    <div v-if="taskMeta" class="mt-1.5 pt-1.5 border-t border-border flex gap-3 text-[10px] text-muted">
      <span v-for="(val, key) in taskMeta" :key="key">{{ key }}: {{ val }}</span>
    </div>
  </div>

  <!-- summary-table -->
  <div v-else-if="renderType === 'summary-table'" class="px-2.5 py-1.5 overflow-x-auto">
    <!-- eslint-disable-next-line taste/no-native-html-elements -- xyz-ui has no Table component -->
    <table class="w-full text-xs border-collapse">
      <thead>
        <tr class="border-b border-border">
          <th v-for="col in tableColumns" :key="col" class="text-left py-1 pr-3 text-muted font-medium whitespace-nowrap">{{ col }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, i) in tableRows" :key="i" class="border-b border-border last:border-b-0">
          <td v-for="col in tableColumns" :key="col" class="py-1 pr-3 text-fg whitespace-nowrap">{{ row[col] ?? '' }}</td>
        </tr>
      </tbody>
    </table>
  </div>

  <!-- progress -->
  <div v-else-if="renderType === 'progress'" class="px-2.5 py-1.5">
    <div class="flex items-center justify-between text-xs mb-1">
      <span class="text-fg">{{ progressData?.label }}</span>
      <span class="text-muted">{{ progressData?.current }}/{{ progressData?.total }}{{ progressData?.unit ?? '' }}</span>
    </div>
    <div class="w-full h-1.5 bg-bg border border-border rounded-none overflow-hidden">
      <div class="h-full bg-accent transition-all duration-300" :style="{ width: progressPercent + '%' }"></div>
    </div>
  </div>

  <!-- code-block -->
  <div v-else-if="renderType === 'code-block'" class="mx-2.5 my-2 border border-border bg-bg p-2 max-h-[180px] overflow-auto">
    <pre class="whitespace-pre-wrap text-xs text-fg leading-relaxed m-0">{{ codeContent }}</pre>
  </div>

  <!-- fallback: plain output -->
  <div v-else-if="toolCall.output" class="mx-2.5 my-2 max-h-[180px] overflow-y-auto border border-border bg-bg p-2">
    <pre class="whitespace-pre-wrap text-xs text-fg leading-relaxed m-0">{{ toolCall.output }}</pre>
  </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { ToolCall } from '@xyz-agent/shared'

interface RenderDescriptor {
  type: 'task-list' | 'summary-table' | 'progress' | 'code-block'
  summary?: string
  data: unknown
}

interface TaskItem {
  id: number
  text: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  evidence?: string
  subItems?: Array<{ id: number; text: string; status: string }>
}

const props = defineProps<{ toolCall: ToolCall }>()

const renderDesc = computed<RenderDescriptor | null>(() => {
  const details = props.toolCall.details
  if (!details || typeof details !== 'object') return null
  const r = (details as Record<string, unknown>)._render
  if (!r || typeof r !== 'object') return null
  return r as RenderDescriptor
})

const renderType = computed(() => renderDesc.value?.type ?? null)

const taskItems = computed<TaskItem[]>(() => {
  const data = renderDesc.value?.data as { items?: TaskItem[] } | undefined
  return data?.items ?? []
})

const taskMeta = computed<Record<string, string> | null>(() => {
  const data = renderDesc.value?.data as { meta?: Record<string, string> } | undefined
  return data?.meta ?? null
})

const tableColumns = computed<string[]>(() => {
  const data = renderDesc.value?.data as { columns?: string[] } | undefined
  return data?.columns ?? []
})

const tableRows = computed<Record<string, string>[]>(() => {
  const data = renderDesc.value?.data as { rows?: Record<string, string>[] } | undefined
  return data?.rows ?? []
})

const progressData = computed(() => {
  return renderDesc.value?.data as { label: string; current: number; total: number; unit?: string } | null
})

const PERCENT_MULTIPLIER = 100
const PERCENT_ROUND_DIVISOR = 100

const progressPercent = computed(() => {
  const d = progressData.value
  if (!d || d.total <= 0) return 0
  return Math.min(PERCENT_MULTIPLIER, Math.round((d.current / d.total) * PERCENT_ROUND_DIVISOR))
})

const codeContent = computed(() => {
  const data = renderDesc.value?.data as { content?: string } | undefined
  return data?.content ?? ''
})

function statusIcon(status: string): string {
  switch (status) {
    case 'completed': return '\u2713'
    case 'in_progress': return '\u25CF'
    case 'cancelled': return '\u2717'
    default: return '\u2610'
  }
}

function statusColor(status: string): string {
  switch (status) {
    case 'completed': return 'text-success'
    case 'in_progress': return 'text-warning'
    case 'cancelled': return 'text-error'
    default: return 'text-muted'
  }
}
</script>
