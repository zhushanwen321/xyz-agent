<template>
  <div class="border border-border rounded-sm bg-surface my-2 overflow-hidden">
    <Button variant="ghost" class="flex items-center gap-1.5 px-2.5 py-1.5 cursor-pointer text-[11px] leading-snug font-mono select-none transition-colors duration-150 ease-ease w-full text-left justify-start !rounded-none hover:bg-accent-light focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2" @click="expanded = !expanded">
      <span v-if="isRunning" class="inline-block w-2.5 h-2.5 border-2 border-warning border-t-transparent rounded-full animate-spin shrink-0"></span>
      <svg v-else :class="['transition-transform duration-150 ease-ease shrink-0', { '-rotate-90': !expanded }]" xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
      <span class="font-semibold text-accent">{{ toolCall.toolName }}</span>
      <span v-if="filePathHint" class="text-muted truncate min-w-0">{{ truncate(filePathHint, 50) }}</span>
      <span :class="['ml-auto text-[10px] shrink-0', { 'text-warning': statusClass === 'running', 'text-success': statusClass === 'done', 'text-danger': statusClass === 'error' }]">{{ statusLabel }}</span>
    </Button>
    <div v-if="expanded" class="px-2.5 py-2 text-[11px] leading-normal max-h-40 overflow-y-auto border-t border-border font-mono text-muted">
      <component v-if="rendererComp" :is="rendererComp" :tool-call="toolCall" />
      <DefaultToolRenderer v-else :tool-call="toolCall" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, shallowRef, computed, onMounted, type Component } from 'vue'
import type { ToolCall } from '@xyz-agent/shared'
import { getToolRenderer } from '../../lib/tool-renderer-registry'
import { Button } from '../../design-system'
import DefaultToolRenderer from './ToolRenderers/DefaultToolRenderer.vue'

const props = defineProps<{ toolCall: ToolCall }>()
const expanded = ref(false)
// Vue 组件定义不能被 reactive 包裹，用 shallowRef 避免性能开销
const rendererComp = shallowRef<Component | null>(null)

onMounted(() => {
  const r = getToolRenderer(props.toolCall.toolName)
  if (r) rendererComp.value = r
})

const isRunning = computed(() => props.toolCall.status === 'running')
const isError = computed(() => props.toolCall.status === 'error')
const statusClass = computed(() => isRunning.value ? 'running' : isError.value ? 'error' : 'done')
const statusLabel = computed(() => isRunning.value ? 'running...' : isError.value ? 'failed' : 'done')

const PATH_HINT_MAX = 50

const filePathHint = computed(() => {
  const input = props.toolCall.input
  if (!input) return ''
  try {
    const obj = typeof input === 'string' ? JSON.parse(input) : input
    return String((obj as Record<string, unknown>).path ?? (obj as Record<string, unknown>).file_path ?? (obj as Record<string, unknown>).command ?? '')
  } catch { return String(input).slice(0, PATH_HINT_MAX) }
})

function truncate(str: string, max: number): string {
  return str.length <= max ? str : str.slice(0, max) + '...'
}
</script>


