<template>
  <div :class="['approval-card', `approval-card--${pending.dangerLevel}`]">
    <div class="approval-header">
      <span class="approval-tool">{{ pending.toolName }}</span>
      <span :class="['approval-level', `approval-level--${pending.dangerLevel}`]">{{ pending.dangerLevel }}</span>
    </div>
    <pre class="approval-input">{{ formattedInput }}</pre>
    <div class="approval-actions">
      <button class="approval-btn approval-btn--always" @click="handleAlwaysAllow">Always Allow</button>
      <button class="approval-btn approval-btn--deny" @click="handleDeny">Deny</button>
      <button class="approval-btn approval-btn--approve" @click="handleApprove">Approve</button>
      <span class="approval-countdown">{{ remainingSeconds }}s</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onUnmounted } from 'vue'

export interface PendingToolCall {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  dangerLevel: 'safe' | 'caution' | 'danger'
}

const props = defineProps<{ pending: PendingToolCall }>()

const emit = defineEmits<{
  approve: [toolCallId: string]
  deny: [toolCallId: string, reason?: string]
  alwaysAllow: [toolName: string]
}>()

const APPROVAL_TIMEOUT_SECONDS = 60
const FORMAT_INDENT = 2
const remainingSeconds = ref(APPROVAL_TIMEOUT_SECONDS)
let timerId: ReturnType<typeof setInterval> | null = null

function cleanup() {
  if (timerId !== null) {
    clearInterval(timerId)
    timerId = null
  }
}

function handleApprove() {
  cleanup()
  emit('approve', props.pending.toolCallId)
}

function handleDeny() {
  cleanup()
  emit('deny', props.pending.toolCallId)
}

function handleAlwaysAllow() {
  cleanup()
  emit('alwaysAllow', props.pending.toolName)
}

onUnmounted(() => cleanup())

const TIMER_INTERVAL_MS = 1000

timerId = setInterval(() => {
  remainingSeconds.value--
  if (remainingSeconds.value <= 0) {
    cleanup()
    emit('deny', props.pending.toolCallId, 'timeout')
  }
}, TIMER_INTERVAL_MS)

const formattedInput = computed(() => {
  try {
    return JSON.stringify(props.pending.input, null, FORMAT_INDENT)
  } catch {
    return String(props.pending.input)
  }
})
</script>

<style scoped>
.approval-card {
  border-radius: var(--radius-md);
  border: 1px solid var(--border);
  border-left: 3px solid var(--border);
  background: var(--surface);
  overflow: hidden;
}

/* Danger-level left border */
.approval-card--safe { border-left-color: var(--success); }
.approval-card--caution { border-left-color: var(--warning); }
.approval-card--danger { border-left-color: var(--danger); }

.approval-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  gap: 8px;
}

.approval-tool {
  font-family: var(--font-mono);
  font-weight: 600;
  font-size: 13px;
  color: var(--fg);
}

.approval-level {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
}

.approval-level--safe {
  color: var(--success);
  background: oklch(95% 0.06 145);
}
.approval-level--caution {
  color: var(--warning);
  background: oklch(95% 0.06 85);
}
.approval-level--danger {
  color: var(--danger);
  background: oklch(95% 0.06 25);
}

[data-theme="dark"] .approval-level--safe { background: oklch(30% 0.06 145); }
[data-theme="dark"] .approval-level--caution { background: oklch(30% 0.06 85); }
[data-theme="dark"] .approval-level--danger { background: oklch(30% 0.06 25); }

.approval-input {
  margin: 0;
  padding: 6px 10px;
  max-height: 160px;
  overflow: auto;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
  color: var(--muted);
  border-top: 1px solid var(--border);
  white-space: pre-wrap;
  word-break: break-all;
}

.approval-actions {
  display: flex;
  gap: 8px;
  padding: 8px 10px;
  border-top: 1px solid var(--border);
}

.approval-btn {
  padding: 4px 12px;
  border-radius: var(--radius-sm);
  font-family: var(--font-body);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

/* Always Allow: ghost */
.approval-btn--always {
  background: none;
  border: 1px solid transparent;
  color: var(--muted);
}
.approval-btn--always:hover {
  background: var(--bg);
  color: var(--fg);
}

/* Deny: bordered */
.approval-btn--deny {
  background: none;
  border: 1px solid var(--border);
  color: var(--fg);
}
.approval-btn--deny:hover {
  border-color: var(--danger);
  color: var(--danger);
}

/* Countdown */
.approval-countdown {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
  line-height: 28px;
}

/* Approve: filled accent */
.approval-btn--approve {
  background: var(--accent);
  border: 1px solid var(--accent);
  color: #fff;
}
.approval-btn--approve:hover {
  opacity: 0.88;
}
</style>
