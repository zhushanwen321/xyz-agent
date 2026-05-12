<template>
  <div class="p-0">
    <div class="px-2.5 py-1.5"><div class="font-mono text-[11px] text-muted mb-1">File:</div><code class="font-mono text-xs text-accent">{{ filePath }}</code></div>
    <div v-if="oldText" class="px-2.5 py-1.5"><div class="font-mono text-[11px] text-muted mb-1">Old:</div><pre class="whitespace-pre-wrap font-mono text-xs bg-bg rounded-md p-2 m-0 max-h-[130px] overflow-y-auto text-danger">{{ oldText }}</pre></div>
    <div v-if="newText" class="px-2.5 py-1.5"><div class="font-mono text-[11px] text-muted mb-1">New:</div><pre class="whitespace-pre-wrap font-mono text-xs bg-bg rounded-md p-2 m-0 max-h-[130px] overflow-y-auto text-success">{{ newText }}</pre></div>
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

