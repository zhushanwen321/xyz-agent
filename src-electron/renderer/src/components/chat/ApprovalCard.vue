<template>
  <div
    :class="[
      'rounded-sm border border-border border-l-[3px] bg-surface overflow-hidden',
      pending.dangerLevel === 'safe' && 'border-l-success',
      pending.dangerLevel === 'caution' && 'border-l-warning',
      pending.dangerLevel === 'danger' && 'border-l-danger',
    ]"
  >
    <div class="flex items-center justify-between px-2.5 py-2 gap-2">
      <span class="font-mono font-semibold text-[13px] text-fg">{{ pending.toolName }}</span>
      <span
        :class="[
          'font-mono text-[11px] font-medium uppercase tracking-[0.04em] py-px px-1.5 rounded-sm',
          pending.dangerLevel === 'safe' && 'text-success bg-level-safe',
          pending.dangerLevel === 'caution' && 'text-warning bg-level-caution',
          pending.dangerLevel === 'danger' && 'text-danger bg-level-danger',
        ]"
      >{{ pending.dangerLevel }}</span>
    </div>
    <pre class="m-0 px-2.5 py-1.5 max-h-40 overflow-auto font-mono text-xs leading-normal text-muted border-t border-border whitespace-pre-wrap break-all">{{ formattedInput }}</pre>
    <div class="flex gap-2 px-2.5 py-2 border-t border-border">
      <Button variant="ghost" class="py-1 px-3 rounded-sm font-body text-[13px] font-medium cursor-pointer transition-colors duration-150 bg-transparent border border-transparent text-muted hover:bg-bg hover:text-fg" @click="handleAlwaysAllow">Always Allow</Button>
      <Button variant="ghost" class="py-1 px-3 rounded-sm font-body text-[13px] font-medium cursor-pointer transition-colors duration-150 bg-transparent border border-border text-fg hover:border-danger hover:text-danger" @click="handleDeny">Deny</Button>
      <Button variant="primary" class="py-1 px-3 rounded-sm font-body text-[13px] font-medium cursor-pointer transition-colors duration-150 bg-accent border border-accent text-white hover:opacity-88" @click="handleApprove">Approve</Button>
      <span class="ml-auto font-mono text-xs text-muted whitespace-nowrap leading-7">{{ remainingSeconds }}s</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onUnmounted } from 'vue'
import { Button } from '../../design-system'

export interface PendingToolCall {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  dangerLevel: 'safe' | 'caution' | 'danger'
}

const props = defineProps<{ pending: PendingToolCall }>()

const emit = defineEmits<{
  approve: [toolCallId: string]
  deny: [payload: { toolCallId: string; reason?: string }]
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
  emit('deny', { toolCallId: props.pending.toolCallId })
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
    emit('deny', { toolCallId: props.pending.toolCallId, reason: 'timeout' })
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

