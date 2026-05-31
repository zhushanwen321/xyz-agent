<template>
  <div class="tool-card my-2 overflow-hidden" :class="cardBorderClass">
    <!-- Header -->
    <button class="tool-header" @click="toggleExpand">
      <!-- Status indicator -->
      <span v-if="isRunning" class="inline-block w-2.5 h-2.5 border-2 border-accent border-t-transparent rounded-full animate-spin shrink-0"></span>
      <svg v-else :class="['transition-transform duration-150 ease-ease shrink-0', { '-rotate-90': !expanded }]" xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>

      <!-- Tool name -->
      <span class="font-semibold text-accent shrink-0">{{ toolCall.toolName }}</span>

      <!-- File path (primary content, flexible) -->
      <span v-if="filePathHint" class="text-muted truncate min-w-0 flex-1 mx-1">{{ filePathHint }}</span>
      <span v-else class="flex-1"></span>

      <!-- Right meta: size + elapsed duration -->
      <span class="ml-auto shrink-0 flex items-center gap-1.5 text-[10px] tabular-nums leading-normal">
        <span v-if="fileSizeRaw" class="opacity-60">{{ fileSizeRaw }}</span>
        <span :class="['min-w-[3em] text-right font-medium', elapsedClass]">{{ elapsedDisplay }}</span>
      </span>
    </button>

    <!-- Progress bar (running only) -->
    <div v-if="isRunning" class="h-0.5 bg-border overflow-hidden">
      <div class="h-full rounded-full w-1/3 bg-accent/70 animate-progress-indeterminate"></div>
    </div>

    <!-- Body (expandable) -->
    <div v-if="expanded" class="border-t border-border text-[11px] leading-normal font-mono text-muted">
      <component v-if="rendererComp" :is="rendererComp" :tool-call="toolCall" />
      <DefaultToolRenderer v-else :tool-call="toolCall" />
    </div>

    <!-- Batch summary (last card of a write/edit batch) -->
    <div v-if="showBatchSummary" class="flex items-center gap-1.5 px-3 py-1.5 border-t border-border text-[10px] font-mono text-success">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="10" height="10" class="shrink-0"><path d="M4 8l3 3 5-6"/></svg>
      <span class="font-medium">{{ batchSummaryText }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, shallowRef, computed, onMounted, onUnmounted, watch, type Component } from 'vue'
import type { ToolCall } from '@xyz-agent/shared'
import { getToolRenderer } from '../../lib/tool-renderer-registry'
import DefaultToolRenderer from './ToolRenderers/DefaultToolRenderer.vue'
import { useSettingsStore } from '../../stores/settings'

export interface BatchInfo {
  index: number
  total: number
  isLast: boolean
  totalSize: string
}

const props = defineProps<{
  toolCall: ToolCall
  batchInfo?: BatchInfo
}>()
const settingsStore = useSettingsStore()

const expanded = ref(settingsStore.autoExpandToolCalls)
// Vue 组件定义不能被 reactive 包裹，用 shallowRef 避免性能开销
const rendererComp = shallowRef<Component | null>(null)

const TIMER_UPDATE_INTERVAL_MS = 100
const AUTO_EXPAND_DELAY_MS = 80
const MS_PER_SECOND = 1000
const DECISECOND_MS = 100
const SECONDS_PER_MINUTE = 60
const BYTES_PER_KB = 1024

// ── Elapsed time reactive counter ──
const now = ref(Date.now())
let timerInterval: ReturnType<typeof setInterval> | undefined

function startTimer() {
  now.value = Date.now()
  timerInterval = setInterval(() => { now.value = Date.now() }, TIMER_UPDATE_INTERVAL_MS)
}

function stopTimer() {
  if (timerInterval !== undefined) {
    clearInterval(timerInterval)
    timerInterval = undefined
  }
}

onMounted(() => {
  const r = getToolRenderer(props.toolCall.toolName)
  if (r) rendererComp.value = r
  if (props.toolCall.status === 'running') {
    startTimer()
  }
})

onUnmounted(() => {
  stopTimer()
})

// ── Auto-expand on completion ──
watch(() => props.toolCall.status, (status) => {
  if (status === 'running') {
    startTimer()
  } else {
    stopTimer()
    now.value = props.toolCall.endTime ?? Date.now()
    // Auto-expand with slight delay for completion animation
    setTimeout(() => { expanded.value = settingsStore.autoExpandToolCalls }, AUTO_EXPAND_DELAY_MS)
  }
})

// ── Computed state ──
const isRunning = computed(() => props.toolCall.status === 'running')
const isError = computed(() => props.toolCall.status === 'error')
const isDone = computed(() => props.toolCall.status === 'completed')

const cardBorderClass = computed(() => {
  if (isRunning.value) return 'border-accent/30'
  if (isError.value) return 'border-danger/40'
  return ''
})

const elapsedMs = computed(() => {
  const end = props.toolCall.endTime ?? now.value
  return Math.max(0, end - props.toolCall.startTime)
})

const elapsedDisplay = computed(() => {
  const ms = elapsedMs.value
  const s = ms / MS_PER_SECOND
  if (s < 1) return `${(ms / DECISECOND_MS).toFixed(1)}s`
  if (s >= SECONDS_PER_MINUTE) {
    const m = Math.floor(s / SECONDS_PER_MINUTE)
    const sec = Math.floor(s % SECONDS_PER_MINUTE)
    return `${m}m${sec}s`
  }
  return `${s.toFixed(1)}s`
})

const elapsedClass = computed(() => {
  if (isRunning.value) return 'text-accent/80'
  if (isDone.value) return 'text-success'
  if (isError.value) return 'text-danger'
  return 'text-muted'
})

// ── File info extraction from input ──
const PATH_HINT_MAX = 55

const parsedInput = computed(() => {
  const input = props.toolCall.input
  if (!input) return null
  try {
    return typeof input === 'string' ? JSON.parse(input) as Record<string, unknown> : input as Record<string, unknown>
  } catch { return null }
})

const filePathHint = computed(() => {
  const obj = parsedInput.value
  if (!obj) return ''
  const path = obj.path ?? obj.file_path ?? obj.command ?? ''
  const str = String(path)
  return str.length <= PATH_HINT_MAX ? str : str.slice(0, PATH_HINT_MAX) + '...'
})

/** Human-readable file size from write/edit content length */
const fileSizeRaw = computed(() => {
  const obj = parsedInput.value
  if (!obj) return null
  // write → content, edit → new_text, bash → command (skip)
  const text = obj.content ?? obj.newText ?? obj.new_text ?? ''
  const len = String(text).length
  if (len === 0) return null
  if (len < BYTES_PER_KB) return `${len}B`
  if (len < BYTES_PER_KB * BYTES_PER_KB) return `${(len / BYTES_PER_KB).toFixed(1)}KB`
  return `${(len / (BYTES_PER_KB * BYTES_PER_KB)).toFixed(1)}MB`
})

// ── Batch summary ──
const showBatchSummary = computed(() => {
  if (!props.batchInfo?.isLast) return false
  if (isRunning.value) return false
  const name = props.toolCall.toolName
  return name === 'write' || name === 'edit'
})

const batchSummaryText = computed(() => {
  if (!props.batchInfo) return ''
  const { total, totalSize } = props.batchInfo
  if (props.toolCall.toolName === 'write') {
    return totalSize ? `${total} files · ${totalSize}` : `${total} files`
  }
  return `${total} edits${totalSize ? ' · ' + totalSize : ''}`
})

// ── Expand toggle ──
function toggleExpand() {
  // Allow manual collapse even after auto-expand
  expanded.value = !expanded.value
}
</script>

<style scoped>
.tool-card {
  border: 1px solid var(--border);
  background: var(--bg);
  border-radius: 1px;
}
.tool-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  cursor: pointer;
  border: none;
  background: linear-gradient(to right, var(--hover-bg) 0%, var(--hover-bg) 40%, transparent 100%);
  transition: background 0.15s ease;
  width: 100%;
  text-align: left;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.4;
}
.tool-header:hover {
  background: linear-gradient(to right, var(--hover-bg) 0%, var(--hover-bg) 55%, transparent 100%);
}

@keyframes progress-indeterminate {
  0%   { transform: translateX(-100%); }
  50%  { transform: translateX(200%); }
  100% { transform: translateX(400%); }
}
.animate-progress-indeterminate {
  animation: progress-indeterminate 1.5s ease-in-out infinite;
}
</style>
