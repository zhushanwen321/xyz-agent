<script setup lang="ts">
import { computed } from 'vue'
import type { ToolCallDisplay, TaskNode } from '../types'
import { getToolDangerLevel } from '../types'
import SubAgentCard from './SubAgentCard.vue'

const props = defineProps<{
  toolCall: ToolCallDisplay
  taskNodes: Map<string, TaskNode>
  toolUseToTaskId: Map<string, string>
  taskId?: string
  onOpenTab?: (taskId: string) => void
}>()

// Subagent 工具调用时显示 SubAgentCard 替代默认渲染
const isDispatchAgent = computed(() => props.toolCall.tool_name === 'Subagent')
const dispatchTask = computed(() => {
  if (!isDispatchAgent.value) return null
  // 通过 tool_use_id -> task_id 映射查找对应的 TaskNode
  const taskId = props.toolUseToTaskId.get(props.toolCall.tool_use_id)
  if (taskId) return props.taskNodes.get(taskId) ?? null
  return null
})

const dangerLevel = computed(() => getToolDangerLevel(props.toolCall.tool_name))

// error 状态优先于 dangerLevel，强制使用红色
const activeColor = computed(() =>
  props.toolCall.status === 'error' ? 'error' : dangerLevel.value
)

const colorMap = {
  safe:   { border: 'border-l-[#22c55e]', text: 'text-[#22c55e]', bg: 'bg-[#22c55e08]', spin: 'border-[#22c55e]' },
  caution:{ border: 'border-l-[#eab308]', text: 'text-[#eab308]', bg: 'bg-[#eab30808]', spin: 'border-[#eab308]' },
  error:  { border: 'border-l-[#ef4444]', text: 'text-[#ef4444]', bg: 'bg-[#ef444408]', spin: 'border-[#ef4444]' },
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
  <!-- dispatch_agent：用 SubAgentCard 替代默认渲染 -->
  <SubAgentCard v-if="isDispatchAgent && dispatchTask" :task="dispatchTask" />

  <!-- 其他工具调用：保持原有渲染 -->
  <div
    v-else
    class="rounded-md border border-border-default border-l-[3px] bg-bg-elevated text-[13px]"
    :class="colors.border"
  >
    <!-- Header -->
    <div class="flex items-center justify-between px-2.5 py-1" :class="colors.bg">
      <div class="flex items-center gap-2">
        <span
          v-if="toolCall.status === 'running'"
          class="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-t-transparent"
          :class="colors.spin"
        />
        <span v-else class="font-mono text-[10px] font-bold" :class="colors.text">
          {{ toolCall.status === 'error' ? '\u2717' : '\u2713' }}
        </span>
        <span class="font-mono font-semibold text-text-primary">{{ toolCall.tool_name }}</span>
      </div>
      <span class="font-mono text-[10px]" :class="colors.text">{{ statusLabel }}</span>
    </div>

    <!-- 参数摘要 -->
    <pre
      v-if="inputSummary"
      class="px-2.5 mt-1 whitespace-pre-wrap font-mono text-[11px] text-text-secondary"
    >{{ inputSummary }}</pre>

    <!-- 输出区：默认展开 -->
    <div
      v-if="toolCall.output !== undefined && toolCall.status !== 'running'"
      class="mx-2.5 mt-1.5 mb-2 max-h-[200px] overflow-y-auto rounded-md border border-border-default bg-bg-inset p-2"
    >
      <pre class="whitespace-pre-wrap font-mono text-[11px] text-text-secondary">{{ toolCall.output }}</pre>
    </div>

    <!-- 子 Agent Tab 跳转提示 -->
    <button
      v-if="taskId && onOpenTab"
      class="mt-1 text-[10px] text-[#3b82f6] hover:underline cursor-pointer"
      @click.stop="onOpenTab(taskId)"
    >Click to view &rarr;</button>
  </div>
</template>
