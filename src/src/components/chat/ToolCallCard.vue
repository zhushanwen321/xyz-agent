<template>
  <div :class="['tool-card', `tool-card--${statusClass}`]">
    <button class="tool-header" @click="expanded = !expanded">
      <div class="tool-header-left">
        <span v-if="isRunning" class="tool-spinner"></span>
        <span v-else :class="['tool-status-icon', statusClass]">{{ isError ? '✗' : '✓' }}</span>
        <span class="tool-name">{{ toolCall.toolName }}</span>
        <span v-if="filePathHint" class="tool-hint">{{ truncate(filePathHint, 50) }}</span>
      </div>
      <div class="tool-header-right">
        <span :class="['tool-status', `tool-status--${statusClass}`]">{{ statusLabel }}</span>
        <svg class="tool-chevron" :class="{ rotated: expanded }" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
      </div>
    </button>
    <div v-if="expanded" class="tool-body">
      <component v-if="rendererComp" :is="rendererComp" :tool-call="toolCall" />
      <DefaultToolRenderer v-else :tool-call="toolCall" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, type Component } from 'vue'
import type { ToolCall } from '@xyz-agent/shared'
import { getToolRenderer } from '../../lib/tool-renderer-registry'
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
.tool-card { overflow: hidden; border-radius: var(--radius-md); border: 1px solid var(--color-border); border-left: 3px solid var(--color-border); background: var(--color-surface); }
.tool-card--running { border-left-color: var(--color-warning, #f59e0b); }
.tool-card--done { border-left-color: var(--color-success, #10b981); }
.tool-card--error { border-left-color: var(--color-danger, #ef4444); }
.tool-header { display: flex; width: 100%; align-items: center; justify-content: space-between; padding: 6px 10px; text-align: left; cursor: pointer; transition: background 0.15s; background: none; border: none; color: inherit; font: inherit; }
.tool-header:hover { background: var(--color-bg-base); }
.tool-header-left { display: flex; align-items: center; gap: 8px; min-width: 0; }
.tool-header-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.tool-spinner { display: inline-block; width: 10px; height: 10px; border: 2px solid var(--color-warning, #f59e0b); border-top-color: transparent; border-radius: 50%; animation: spin 0.6s linear infinite; }
.tool-status-icon { font-size: 12px; font-family: var(--font-mono); }
.tool-status-icon.done { color: var(--color-success, #10b981); }
.tool-status-icon.error { color: var(--color-danger, #ef4444); }
.tool-name { font-family: var(--font-mono); font-weight: 600; font-size: 13px; color: var(--color-text-primary); }
.tool-hint { font-family: var(--font-mono); font-size: 11px; color: var(--color-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tool-status { font-family: var(--font-mono); font-size: 11px; }
.tool-status--running { color: var(--color-warning, #f59e0b); }
.tool-status--done { color: var(--color-success, #10b981); }
.tool-status--error { color: var(--color-danger, #ef4444); }
.tool-chevron { color: var(--color-text-muted); transition: transform 0.2s; }
.tool-chevron.rotated { transform: rotate(180deg); }
.tool-body { border-top: 1px solid var(--color-border); }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
