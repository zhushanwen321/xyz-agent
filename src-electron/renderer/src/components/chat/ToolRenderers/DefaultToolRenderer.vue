<template>
  <div class="p-0">
    <pre v-if="toolCall.input" class="whitespace-pre-wrap px-2.5 py-2 font-mono text-xs text-muted m-0">{{ formatInput(toolCall) }}</pre>
    <div v-if="toolCall.output !== undefined && toolCall.status !== 'running'" class="mx-2.5 mb-2 max-h-[200px] overflow-y-auto rounded-md border border-border bg-bg p-2">
      <pre class="whitespace-pre-wrap font-mono text-xs text-muted m-0">{{ toolCall.output }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ToolCall } from '@xyz-agent/shared'
const FORMAT_INDENT = 2
defineProps<{ toolCall: ToolCall }>()
function formatInput(tc: ToolCall): string {
  try { return JSON.stringify(typeof tc.input === 'string' ? JSON.parse(tc.input) : tc.input, null, FORMAT_INDENT) }
  catch { return String(tc.input) }
}
</script>

