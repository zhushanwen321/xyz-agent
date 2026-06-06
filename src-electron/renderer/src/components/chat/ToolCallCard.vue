<template>
  <div class="tool-card" :class="cardClass">
    <!-- Single-line inline toggle: "read MessageBubble.vue 1.8s" -->
    <!-- eslint-disable-next-line taste/no-native-html-elements -- inline toggle with custom flex layout -->
    <button class="tool-toggle" @click="toggleExpand">
      <!-- Status indicator -->
      <span v-if="isRunning" class="tool-toggle__spinner" />
      <svg v-else :class="['tool-toggle__chevron', { 'tool-toggle__chevron--collapsed': !expanded }]" xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>

      <!-- Tool name -->
      <span class="tool-toggle__name">{{ toolCall.toolName }}</span>

      <!-- File path / command (primary content) -->
      <span v-if="filePathHint" class="tool-toggle__path">{{ filePathHint }}</span>

      <!-- Right meta: size + elapsed -->
      <span class="tool-toggle__meta">
        <span v-if="fileSizeRaw" class="tool-toggle__size">{{ fileSizeRaw }}</span>
        <span :class="['tool-toggle__time', elapsedClass]">{{ elapsedDisplay }}</span>
      </span>
    </button>

    <!-- Progress bar (running only) -->
    <div v-if="isRunning" class="tool-progress">
      <div class="tool-progress__bar" />
    </div>

    <!-- Body (expandable) -->
    <div v-if="expanded" class="tool-body">
      <component v-if="rendererComp" :is="rendererComp" :tool-call="toolCall" />
      <DefaultToolRenderer v-else :tool-call="toolCall" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, shallowRef, computed, onMounted, onUnmounted, watch, type Component } from 'vue'
import type { ToolCall } from '@xyz-agent/shared'
import { getToolRenderer } from '../../lib/tool-renderer-registry'
import DefaultToolRenderer from './ToolRenderers/DefaultToolRenderer.vue'
import { useSettingsStore } from '../../stores/settings'

const props = defineProps<{
  toolCall: ToolCall
}>()
const settingsStore = useSettingsStore()

const expanded = ref(settingsStore.autoExpandToolCalls)
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
  if (props.toolCall.status === 'running') startTimer()
})

onUnmounted(stopTimer)

// ── Auto-expand on completion ──
watch(() => props.toolCall.status, (status) => {
  if (status === 'running') {
    startTimer()
  } else {
    stopTimer()
    now.value = props.toolCall.endTime ?? Date.now()
    setTimeout(() => { expanded.value = settingsStore.autoExpandToolCalls }, AUTO_EXPAND_DELAY_MS)
  }
})

// ── Computed state ──
const isRunning = computed(() => props.toolCall.status === 'running')
const isError = computed(() => props.toolCall.status === 'error')
const isDone = computed(() => props.toolCall.status === 'completed')

const cardClass = computed(() => ({
  'tool-card--error': isError.value,
  'tool-card--running': isRunning.value,
}))

const elapsedMs = computed(() => {
  const start = props.toolCall.startTime
  if (!start) return 0
  if (props.toolCall.endTime) return Math.max(0, props.toolCall.endTime - start)
  if (isRunning.value) return Math.max(0, now.value - start)
  return 0
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
  if (isRunning.value) return 'tool-toggle__time--running'
  if (isDone.value) return 'tool-toggle__time--done'
  if (isError.value) return 'tool-toggle__time--error'
  return ''
})

// ── File info extraction ──
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

const fileSizeRaw = computed(() => {
  const obj = parsedInput.value
  if (!obj) return null
  const text = obj.content ?? obj.newText ?? obj.new_text ?? ''
  const len = String(text).length
  if (len === 0) return null
  if (len < BYTES_PER_KB) return `${len}B`
  if (len < BYTES_PER_KB * BYTES_PER_KB) return `${(len / BYTES_PER_KB).toFixed(1)}KB`
  return `${(len / (BYTES_PER_KB * BYTES_PER_KB)).toFixed(1)}MB`
})

function toggleExpand() {
  expanded.value = !expanded.value
}
</script>

<style scoped>
/* Single-line inline tool call, no card background.
   Section container provides the background and indent. */
.tool-card {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tool-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
  cursor: pointer;
  border: none;
  background: transparent;
  text-align: left;
  font-size: 11px;
  line-height: 1.4;
  color: var(--muted);
  width: 100%;
}
.tool-toggle:hover {
  color: var(--fg);
}
.tool-toggle__spinner {
  display: inline-block;
  width: 10px;
  height: 10px;
  border: 2px solid var(--accent);
  border-top-color: transparent;
  border-radius: 50%;
  animation: tool-spin 0.8s linear infinite;
  flex-shrink: 0;
}
@keyframes tool-spin {
  to { transform: rotate(360deg); }
}
.tool-toggle__chevron {
  transition: transform 0.15s ease;
  flex-shrink: 0;
  color: var(--muted);
}
.tool-toggle__chevron--collapsed {
  transform: rotate(-90deg);
}
.tool-toggle__name {
  font-weight: 600;
  color: var(--accent);
  flex-shrink: 0;
}
.tool-toggle__path {
  color: var(--muted);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tool-toggle__meta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  font-family: var(--font-mono);
  color: var(--muted);
  flex-shrink: 0;
  margin-left: auto;
}
.tool-toggle__size {
  opacity: 0.7;
}
.tool-toggle__time--running { color: var(--accent); opacity: 0.8; }
.tool-toggle__time--done { color: var(--success); }
.tool-toggle__time--error { color: var(--danger); }

.tool-progress {
  height: 1px;
  background: var(--border);
  overflow: hidden;
  margin-left: 15px;
}
.tool-progress__bar {
  height: 100%;
  width: 30%;
  background: var(--accent);
  opacity: 0.7;
  animation: tool-progress 1.5s ease-in-out infinite;
}
@keyframes tool-progress {
  0%   { transform: translateX(-100%); }
  50%  { transform: translateX(200%); }
  100% { transform: translateX(400%); }
}

.tool-body {
  margin-left: 15px;
  padding: 6px 0 4px 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--muted);
}

.tool-card--error .tool-toggle__name { color: var(--danger); }
</style>
