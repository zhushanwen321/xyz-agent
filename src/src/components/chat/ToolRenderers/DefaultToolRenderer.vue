<template>
  <div class="default-renderer">
    <pre v-if="toolCall.input" class="renderer-input">{{ formatInput(toolCall) }}</pre>
    <div v-if="toolCall.output !== undefined && toolCall.status !== 'running'" class="renderer-output">
      <pre>{{ toolCall.output }}</pre>
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

<style scoped>
.default-renderer { padding: 0; }
.renderer-input { white-space: pre-wrap; padding: 8px 10px; font-family: var(--font-mono); font-size: 12px; color: var(--muted); margin: 0; }
.renderer-output { margin: 0 10px 8px; max-height: 200px; overflow-y: auto; border-radius: var(--radius-md); border: 1px solid var(--border); background: var(--bg); padding: 8px; }
.renderer-output pre { white-space: pre-wrap; font-family: var(--font-mono); font-size: 12px; color: var(--muted); margin: 0; }
</style>
