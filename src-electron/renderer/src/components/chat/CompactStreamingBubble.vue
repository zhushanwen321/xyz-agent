<template>
  <div class="stream-compact" :class="{ 'stream-compact--expanded': expanded }" @click="expanded = !expanded">
    <span class="stream-compact__pulse" />
    <span class="stream-compact__status">{{ statusText }}</span>
    <span v-if="elapsedDisplay" class="stream-compact__time">{{ elapsedDisplay }}</span>
    <svg class="stream-compact__chevron" :class="{ 'stream-compact__chevron--open': expanded }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
  </div>
  <!-- Expanded full message -->
  <div v-if="expanded" class="stream-compact__full">
    <MessageBubble :message="message" :is-streaming="true" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import type { Message } from '@xyz-agent/shared'
import MessageBubble from './MessageBubble.vue'
import { formatTime, toolPath } from '../lib/compact-utils'

const props = defineProps<{
  message: Message
}>()

const expanded = ref(false)

// Auto-collapse when streaming ends (status → 'complete')
watch(() => props.message.status, (newStatus) => {
  if (newStatus === 'complete') {
    expanded.value = false
  }
})

// ── Constants ──
const TIMER_INTERVAL_MS = 100
const ELAPSED_THRESHOLD_MS = 1000
const PATH_DISPLAY_MAX = 50
const TEXT_PREVIEW_MAX = 60

// ── Derive current status from contentBlocks / thinking / toolCalls ──
const statusText = computed(() => {
  const msg = props.message

  // Check if thinking is running (last thinking block not collapsed)
  const thinkingBlocks = msg.thinking ?? []
  const lastThinking = thinkingBlocks[thinkingBlocks.length - 1]
  if (lastThinking && !lastThinking.collapsed) {
    return '思考中...'
  }

  // Check if any tool call is running
  const toolCalls = msg.toolCalls ?? []
  const runningTc = toolCalls.find(tc => tc.status === 'running')
  if (runningTc) {
    const p = toolPath(runningTc.input, PATH_DISPLAY_MAX)
    return p ? `${runningTc.toolName} ${p}` : `${runningTc.toolName}...`
  }

  // Fallback: text preview
  if (msg.content) {
    const text = msg.content.trim()
    if (text.length > TEXT_PREVIEW_MAX) return text.slice(0, TEXT_PREVIEW_MAX) + '...'
    return text
  }

  return '等待响应...'
})

// ── Elapsed time ──
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined

function startTimer() {
  now.value = Date.now()
  if (!timer) timer = setInterval(() => { now.value = Date.now() }, TIMER_INTERVAL_MS)
}
function stopTimer() {
  if (timer !== undefined) { clearInterval(timer); timer = undefined }
}

// Always show elapsed time while mounted (streaming is in progress)
onMounted(startTimer)
onBeforeUnmount(stopTimer)
// message reference changes on each WS update (new object), so no deep:true needed
watch(() => props.message, () => { if (!timer) startTimer() })

const elapsedMs = computed(() => {
  const ts = props.message.timestamp
  if (!ts) return 0
  return Math.max(0, now.value - ts)
})
const elapsedDisplay = computed(() => {
  const ms = elapsedMs.value
  if (ms < ELAPSED_THRESHOLD_MS) return ''
  return formatTime(ms)
})
</script>

<style scoped>
.stream-compact {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
  margin-bottom: 4px;
}
.stream-compact:hover {
  border-color: var(--accent);
  background: var(--accent-light);
}
.stream-compact--expanded {
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
  margin-bottom: 0;
  border-bottom: none;
}

.stream-compact__pulse {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  animation: pulse 2s ease-in-out infinite;
  flex-shrink: 0;
}
@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.7); }
}

.stream-compact__status {
  font-size: 11px;
  color: var(--muted);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stream-compact__time {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--muted-dim, var(--muted));
  flex-shrink: 0;
}

.stream-compact__chevron {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  color: var(--muted-dim, var(--muted));
  transition: transform 0.15s;
}
.stream-compact__chevron--open {
  transform: rotate(180deg);
}

.stream-compact__full {
  border: 1px solid var(--border);
  border-top: none;
  border-radius: 0 0 4px 4px;
  padding: 8px 12px;
  background: var(--surface);
  margin-bottom: 4px;
}
</style>
