<template>
  <div class="edit-renderer">
    <div class="edit-section"><div class="edit-label">File:</div><code class="edit-path">{{ filePath }}</code></div>
    <div v-if="oldText" class="edit-section"><div class="edit-label">Old:</div><pre class="edit-old">{{ oldText }}</pre></div>
    <div v-if="newText" class="edit-section"><div class="edit-label">New:</div><pre class="edit-new">{{ newText }}</pre></div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { ToolCall } from '@xyz-agent/shared'
const props = defineProps<{ toolCall: ToolCall }>()
const parsed = computed(() => {
  try { return typeof props.toolCall.input === 'string' ? JSON.parse(props.toolCall.input) : props.toolCall.input }
  catch { return {} }
})
const filePath = computed(() => String((parsed.value as Record<string, unknown>).file_path ?? ''))
const oldText = computed(() => String((parsed.value as Record<string, unknown>).old_text ?? ''))
const newText = computed(() => String((parsed.value as Record<string, unknown>).new_text ?? ''))
</script>

<style scoped>
.edit-renderer { padding: 0; }
.edit-section { padding: 6px 10px; }
.edit-label { font-family: var(--font-mono); font-size: 11px; color: var(--muted); margin-bottom: 4px; }
.edit-path { font-family: var(--font-mono); font-size: 12px; color: var(--accent); }
.edit-old, .edit-new { white-space: pre-wrap; font-family: var(--font-mono); font-size: 12px; background: var(--bg); border-radius: var(--radius-md); padding: 8px; margin: 0; max-height: 130px; overflow-y: auto; }
.edit-old { color: var(--danger); }
.edit-new { color: var(--success); }
</style>
