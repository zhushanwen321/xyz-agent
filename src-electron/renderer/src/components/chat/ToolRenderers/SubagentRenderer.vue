<template>
  <div class="p-0" :data-status="toolCall.status">
  <!-- Agent line: icon + name + mode tag -->
  <div class="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-border bg-surface">
    <div class="w-3.5 h-3.5 rounded-sm bg-agent flex items-center justify-center text-white text-[9px] font-bold shrink-0">A</div>
    <span class="font-mono text-xs font-semibold text-agent">{{ agentName }}</span>
    <span class="text-[10px] text-muted px-1.5 py-px bg-surface border border-border rounded-sm">{{ mode }}</span>
  </div>

  <!-- Task description -->
  <div v-if="taskDesc" class="px-2.5 py-1.5 text-xs text-muted border-b border-border">
    <span class="font-medium text-fg mr-1">Task:</span>{{ taskDesc }}
  </div>

  <!-- Output area -->
  <div v-if="showOutput" class="mx-2.5 my-2 max-h-[180px] overflow-y-auto rounded-sm border border-border bg-bg p-2">
    <pre class="whitespace-pre-wrap font-mono text-xs text-fg leading-relaxed m-0">{{ toolCall.output }}</pre>
  </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { ToolCall } from '@xyz-agent/shared'

const props = defineProps<{ toolCall: ToolCall }>()

const parsedInput = computed(() => {
  const raw = props.toolCall.input
  if (!raw) return null
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    return null
  }
})

const agentName = computed(() => parsedInput.value?.agent ?? 'unknown')

const taskDesc = computed(() => parsedInput.value?.task ?? '')

const mode = computed(() => {
  if (parsedInput.value?.tasks) return 'parallel'
  if (parsedInput.value?.chain) return 'chain'
  if (parsedInput.value?.mode === 'parallel' || parsedInput.value?.mode === 'chain') return parsedInput.value.mode
  return 'single'
})

const showOutput = computed(() => {
  return props.toolCall.output !== undefined && props.toolCall.status !== 'running'
})
</script>
