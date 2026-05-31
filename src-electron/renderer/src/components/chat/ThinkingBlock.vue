<template>
  <div class="overflow-hidden border border-border mb-2 thinking-block">
    <button class="thinking-header" @click="expanded = !expanded">
      <!-- Left: arrow + label -->
      <svg :class="['transition-transform duration-150 ease-ease shrink-0', { '-rotate-90': !expanded }]" xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
      <span v-if="streaming" class="inline-block w-[5px] h-2.5 bg-accent animate-pulse-bar motion-reduce:opacity-60 motion-reduce:animate-none"></span>
      <span class="text-[11px] font-mono leading-snug text-accent font-medium">Thinking</span>
      <span class="flex-1"></span>
      <!-- Right: elapsed time -->
      <span class="shrink-0 text-[10px] tabular-nums leading-normal text-muted font-medium">{{ elapsedDisplay }}</span>
    </button>
    <div v-if="expanded" class="border-t border-border px-3 py-2">
      <pre class="whitespace-pre-wrap font-mono text-[11px] leading-normal text-muted m-0">{{ text }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
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

const now = ref(Date.now())
let timerInterval: ReturnType<typeof setInterval> | undefined

onMounted(() => {
  if (props.streaming) {
    timerInterval = setInterval(() => { now.value = Date.now() }, 100)
  }
})

onBeforeUnmount(() => {
  if (timerInterval !== undefined) {
    clearInterval(timerInterval)
    timerInterval = undefined
  }
})

const elapsedMs = computed(() => {
  const start = props.startTime
  if (!start) return 0
  const end = props.streaming ? now.value : (props.endTime ?? now.value)
  return Math.max(0, end - start)
})

const elapsedDisplay = computed(() => {
  const ms = elapsedMs.value
  if (ms === 0) return ''
  const s = ms / MS_PER_SECOND
  if (s < 1) return `${(ms / 100).toFixed(1)}s`
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}m${sec}s`
})
</script>

<style scoped>
.thinking-block {
  background: var(--bg);
  border-radius: 1px;
}
.thinking-header {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 12px;
  cursor: pointer;
  border: none;
  background: linear-gradient(to right, var(--accent-light) 0%, var(--accent-light) 40%, transparent 100%);
  transition: background 0.15s ease;
  text-align: left;
}
.thinking-header:hover {
  background: linear-gradient(to right, var(--accent-light) 0%, var(--accent-light) 55%, transparent 100%);
}
</style>
