<template>
  <div class="write-renderer">
    <div class="write-section"><div class="write-label">Write:</div><code class="write-path">{{ filePath }}</code></div>
    <div v-if="toolCall.status !== 'running'" class="write-section">
      <div class="write-label">Content:</div>
      <div class="write-content"><pre>{{ fileContent }}</pre></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { ToolCall } from '@xyz-agent/shared'
const props = defineProps<{ toolCall: ToolCall }>()
const filePath = computed(() => {
  try { const obj = typeof props.toolCall.input === 'string' ? JSON.parse(props.toolCall.input) : props.toolCall.input; return String((obj as Record<string, unknown>).path ?? (obj as Record<string, unknown>).filePath ?? '') }
  catch { return '' }
})
const fileContent = computed(() => {
  try { const obj = typeof props.toolCall.input === 'string' ? JSON.parse(props.toolCall.input) : props.toolCall.input; return String((obj as Record<string, unknown>).content ?? '') }
  catch { return '' }
})
</script>

<style scoped>
.write-renderer { padding: 0; }
.write-section { padding: 6px 10px; }
.write-label { font-family: var(--font-mono); font-size: 11px; color: var(--muted); margin-bottom: 4px; }
.write-path { font-family: var(--font-mono); font-size: 12px; color: var(--accent); }
.write-content { max-height: 250px; overflow-y: auto; border-radius: var(--radius-md); border: 1px solid var(--border); background: var(--bg); padding: 8px; }
.write-content pre { white-space: pre-wrap; font-family: var(--font-mono); font-size: 12px; color: var(--muted); margin: 0; }
</style>
