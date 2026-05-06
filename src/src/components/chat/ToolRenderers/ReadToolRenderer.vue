<template>
  <div class="read-renderer">
    <div class="read-section"><div class="read-label">File:</div><code class="read-path">{{ filePath }}</code></div>
    <div v-if="toolCall.output !== undefined && toolCall.status !== 'running'" class="read-section">
      <div class="read-label">Content:</div>
      <div class="read-content"><pre>{{ toolCall.output }}</pre></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { ToolCall } from '@xyz-agent/shared'
const props = defineProps<{ toolCall: ToolCall }>()
const filePath = computed(() => {
  try { const obj = typeof props.toolCall.input === 'string' ? JSON.parse(props.toolCall.input) : props.toolCall.input; return String((obj as Record<string, unknown>).path ?? (obj as Record<string, unknown>).file_path ?? '') }
  catch { return '' }
})
</script>

<style scoped>
.read-renderer { padding: 0; }
.read-section { padding: 6px 10px; }
.read-label { font-family: var(--font-mono); font-size: 11px; color: var(--color-text-muted); margin-bottom: 4px; }
.read-path { font-family: var(--font-mono); font-size: 12px; color: var(--color-accent); }
.read-content { max-height: 250px; overflow-y: auto; border-radius: var(--radius-md); border: 1px solid var(--color-border); background: var(--color-bg-base); padding: 8px; }
.read-content pre { white-space: pre-wrap; font-family: var(--font-mono); font-size: 12px; color: var(--color-text-muted); margin: 0; }
</style>
