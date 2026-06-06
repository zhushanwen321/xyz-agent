<template>
  <div class="thinking-block">
    <!-- Single-line toggle: "Thinking · 3.2s ▼" -->
    <!-- eslint-disable-next-line taste/no-native-html-elements -- inline toggle with custom flex layout -->
    <button class="thinking-toggle" @click="expanded = !expanded">
      <svg :class="['thinking-toggle__chevron', { 'thinking-toggle__chevron--collapsed': !expanded }]" xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
      <span v-if="streaming" class="thinking-toggle__pulse" />
      <span class="thinking-toggle__label">Thinking</span>
      <span v-if="elapsedDisplay" class="thinking-toggle__time">· {{ elapsedDisplay }}</span>
    </button>
    <!-- Expanded body -->
    <div v-if="expanded" class="thinking-body">
      <pre class="thinking-body__text">{{ text }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useSettingsStore } from '../../stores/settings'

const props = defineProps<{
  text: string
  streaming?: boolean
  startTime?: number
  endTime?: number
}>()
const settingsStore = useSettingsStore()
const expanded = ref(settingsStore.autoExpandThinking)

// ── Elapsed time ──────────────────────────────────────────────
const MS_PER_SECOND = 1000
const DECISECOND_MS = 100
const SECONDS_PER_MINUTE = 60

const now = ref(Date.now())
let timerInterval: ReturnType<typeof setInterval> | undefined

function startTimer() {
  now.value = Date.now()
  if (!timerInterval) {
    timerInterval = setInterval(() => { now.value = Date.now() }, DECISECOND_MS)
  }
}

function stopTimer() {
  if (timerInterval !== undefined) {
    clearInterval(timerInterval)
    timerInterval = undefined
  }
}

onMounted(() => {
  if (props.streaming) startTimer()
})

watch(() => props.streaming, (streaming) => {
  if (streaming) startTimer()
  else stopTimer()
})

onBeforeUnmount(stopTimer)

const elapsedMs = computed(() => {
  const start = props.startTime
  if (!start) return 0
  const end = props.streaming
    ? now.value
    : (props.endTime ?? now.value)
  return Math.max(0, end - start)
})

const elapsedDisplay = computed(() => {
  const ms = elapsedMs.value
  if (ms <= 0) return ''
  const s = ms / MS_PER_SECOND
  if (s < 1) return `${(ms / DECISECOND_MS).toFixed(1)}s`
  if (s < SECONDS_PER_MINUTE) return `${s.toFixed(1)}s`
  const m = Math.floor(s / SECONDS_PER_MINUTE)
  const sec = Math.floor(s % SECONDS_PER_MINUTE)
  return `${m}m${sec}s`
})
</script>

<style scoped>
/* Single-line inline toggle, no card background.
   Section container provides the background and indent. */
.thinking-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.thinking-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  cursor: pointer;
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.4;
  text-align: left;
  align-self: flex-start;
}
.thinking-toggle:hover {
  color: var(--fg);
}
.thinking-toggle__chevron {
  transition: transform 0.15s ease;
  flex-shrink: 0;
  color: var(--muted);
}
.thinking-toggle__chevron--collapsed {
  transform: rotate(-90deg);
}
.thinking-toggle__pulse {
  display: inline-block;
  width: 5px;
  height: 10px;
  background: var(--accent);
  border-radius: 1px;
  animation: thinking-pulse 2s ease-in-out infinite;
  flex-shrink: 0;
}
@keyframes thinking-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
.thinking-toggle__label {
  color: var(--accent);
  font-weight: 500;
}
.thinking-toggle__time {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--muted);
}
.thinking-body {
  padding: 4px 0 4px 13px;
}
.thinking-body__text {
  white-space: pre-wrap;
  font-family: var(--font-body);
  font-size: 11px;
  line-height: 1.6;
  color: var(--muted);
  margin: 0;
}
</style>
