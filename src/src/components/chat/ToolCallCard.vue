<template>
  <div :class="['tool', { collapsed: !expanded }]">
    <Button variant="ghost" class="tool__hd" @click="expanded = !expanded">
      <span v-if="isRunning" class="tool-spinner"></span>
      <svg v-else class="tool__chevron" xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
      <span class="tool__name">{{ toolCall.toolName }}</span>
      <span v-if="filePathHint" class="tool__path">{{ truncate(filePathHint, 50) }}</span>
      <span :class="['tool__status', `tool__status--${statusClass}`]">{{ statusLabel }}</span>
    </Button>
    <div v-if="expanded" class="tool__bd">
      <component v-if="rendererComp" :is="rendererComp" :tool-call="toolCall" />
      <DefaultToolRenderer v-else :tool-call="toolCall" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, type Component } from 'vue'
import type { ToolCall } from '@xyz-agent/shared'
import { getToolRenderer } from '../../lib/tool-renderer-registry'
import { Button } from '../../design-system'
import DefaultToolRenderer from './ToolRenderers/DefaultToolRenderer.vue'

const props = defineProps<{ toolCall: ToolCall }>()
const expanded = ref(false)
const rendererComp = ref<Component | null>(null)

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

<style scoped>
.tool { border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg); margin: 6px 0; overflow: hidden; }
.tool__hd { display: flex; align-items: center; gap: 6px; padding: 6px 10px; cursor: pointer; font-size: 11px; font-family: var(--font-mono); color: var(--muted); user-select: none; transition: background 0.15s var(--ease); width: 100%; text-align: left; background: none; border: none; color: inherit; font: inherit; }
.tool__hd:hover { background: var(--accent-light); }
.tool__chevron { transition: transform 0.15s var(--ease); font-size: 9px; flex-shrink: 0; }
.tool.collapsed .tool__chevron { transform: rotate(-90deg); }
.tool__name { font-weight: 600; color: var(--accent); }
.tool__path { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.tool__status { margin-left: auto; font-size: 10px; flex-shrink: 0; }
.tool__status--running { color: var(--warning); }
.tool__status--done { color: var(--success); }
.tool__status--error { color: var(--danger); }
.tool__bd { padding: 6px 10px 10px; font-size: 11px; line-height: 1.5; max-height: 160px; overflow-y: auto; border-top: 1px solid var(--border); font-family: var(--font-mono); color: var(--muted); }
.tool-spinner { display: inline-block; width: 10px; height: 10px; border: 2px solid var(--warning); border-top-color: transparent; border-radius: 50%; animation: spin 0.6s linear infinite; flex-shrink: 0; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
