<template>
  <div class="standalone-tool" :class="[`standalone-tool--${toolCall.status}`]">
    <!-- Header row: clickable toggle -->
    <!-- eslint-disable-next-line taste/no-native-html-elements -- custom flex layout requires button -->
    <button class="standalone-tool__hdr" @click="expanded = !expanded">
      <!-- Left icon -->
      <svg v-if="isCustomTool" class="standalone-tool__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>
      <span v-else :class="['standalone-tool__dot', `standalone-tool__dot--${toolCall.status}`]" />

      <!-- Tool name -->
      <span class="standalone-tool__name">{{ toolCall.toolName }}</span>

      <!-- File path / command -->
      <span v-if="resolvedPath" class="standalone-tool__path">{{ resolvedPath }}</span>

      <!-- Status badge -->
      <span :class="['standalone-tool__badge', `standalone-tool__badge--${toolCall.status}`]">
        {{ statusLabel }}
      </span>

      <!-- Elapsed time -->
      <span v-if="elapsedDisplay" class="standalone-tool__time">{{ elapsedDisplay }}</span>
    </button>

    <!-- Expandable body: delegate to ToolCallCard -->
    <div v-if="expanded" class="standalone-tool__body">
      <ToolCallCard :tool-call="toolCall" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import ToolCallCard from './ToolCallCard.vue'
import { formatTime, toolPath } from '@/lib/compact-utils'
import { useLiveTimer } from '../../composables/useLiveTimer'
import type { ToolCall } from '@xyz-agent/shared'

const props = defineProps<{
  toolCall: ToolCall
}>()

const isCustomTool = computed(() => {
  const builtin = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']
  return !builtin.includes(props.toolCall.toolName)
})

const expanded = ref(false)

// ── Elapsed time reactive counter ──
const REFRESH_INTERVAL_MS = 100
const MAX_PATH_LENGTH = 50

const { now, start: startTimer, stop: stopTimer } = useLiveTimer(REFRESH_INTERVAL_MS)

watch(() => props.toolCall.status, (status) => {
  if (status === 'running') startTimer()
  else stopTimer()
}, { immediate: true })

// ── Path extraction ──
const resolvedPath = computed(() => {
  const raw = toolPath(props.toolCall.input)
  if (!raw || raw === 'undefined') return ''
  return raw.length > MAX_PATH_LENGTH ? raw.slice(0, MAX_PATH_LENGTH) + '...' : raw
})

// ── Status label ──
const statusLabel = computed(() => {
  switch (props.toolCall.status) {
    case 'running': return 'running'
    case 'completed': return 'done'
    case 'error': return 'error'
    default: return ''
  }
})

// ── Elapsed display ──
const elapsedMs = computed(() => {
  const start = props.toolCall.startTime
  if (!start) return 0
  if (props.toolCall.endTime) return Math.max(0, props.toolCall.endTime - start)
  if (props.toolCall.status === 'running') return Math.max(0, now.value - start)
  return 0
})

const elapsedDisplay = computed(() => {
  const ms = elapsedMs.value
  if (ms <= 0) return ''
  return formatTime(ms)
})
</script>

<style scoped>
.standalone-tool {
  display: flex;
  flex-direction: column;
  font-size: 11px;
}

/* ── Header ── */
.standalone-tool__hdr {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 0;
  cursor: pointer;
  border: none;
  background: transparent;
  text-align: left;
  font-size: 11px;
  line-height: 1.4;
  color: var(--muted);
  width: 100%;
}
.standalone-tool__hdr:hover {
  color: var(--fg);
}

/* ── Dot (builtin tools) ── */
.standalone-tool__dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  flex-shrink: 0;
}
.standalone-tool__dot--completed {
  background: var(--success);
}
.standalone-tool__dot--running {
  background: var(--accent);
}
.standalone-tool__dot--error {
  background: var(--danger);
}

/* ── Icon (custom tools / subagents) ── */
.standalone-tool__icon {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
  color: var(--accent);
}

/* ── Name ── */
.standalone-tool__name {
  font-weight: 600;
  color: var(--accent);
  flex-shrink: 0;
}

/* ── Path ── */
.standalone-tool__path {
  color: var(--muted);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── Status badge ── */
.standalone-tool__badge {
  font-family: var(--font-mono);
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  padding: 1px 5px;
  border-radius: 100px;
  flex-shrink: 0;
  user-select: none;
}
.standalone-tool__badge--completed {
  background: color-mix(in oklch, var(--success) 14%, transparent);
  color: var(--success);
}
.standalone-tool__badge--running {
  background: color-mix(in oklch, var(--accent) 14%, transparent);
  color: var(--accent);
}
.standalone-tool__badge--error {
  background: color-mix(in oklch, var(--danger) 14%, transparent);
  color: var(--danger);
}

/* ── Time ── */
.standalone-tool__time {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--muted-dim, var(--muted));
  flex-shrink: 0;
  margin-left: auto;
}

/* ── Expandable body ── */
.standalone-tool__body {
  padding: 4px 0 2px 0;
}
</style>
