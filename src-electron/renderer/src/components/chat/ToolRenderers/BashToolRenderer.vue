<template>
  <div class="p-0">
    <div class="px-2.5 py-2">
      <div class="font-mono text-[11px] text-muted mb-1">Command:</div>
      <pre class="whitespace-pre-wrap font-mono text-xs text-fg bg-bg rounded-md p-2 m-0">{{ command }}</pre>
    </div>
    <div v-if="toolCall.output !== undefined && toolCall.status !== 'running'" class="px-2.5 py-2">
      <div class="font-mono text-[11px] text-muted mb-1">Output:</div>
      <div class="max-h-[200px] overflow-y-auto rounded-md border border-border bg-surface p-2"><pre class="whitespace-pre-wrap font-mono text-xs text-muted m-0">{{ toolCall.output }}</pre></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { ToolCall } from '@xyz-agent/shared'
const props = defineProps<{ toolCall: ToolCall }>()
const command = computed(() => {
  try { const obj = typeof props.toolCall.input === 'string' ? JSON.parse(props.toolCall.input) : props.toolCall.input; return String((obj as Record<string, unknown>).command ?? '') }
  catch { return String(props.toolCall.input) }
})
</script>

