<template>
  <div class="p-0">
    <div class="px-2.5 py-1.5"><div class="font-mono text-[11px] text-muted mb-1">Write:</div><code class="font-mono text-xs text-accent">{{ filePath }}</code></div>
    <div v-if="toolCall.status !== 'running'" class="px-2.5 py-1.5">
      <div class="font-mono text-[11px] text-muted mb-1">Content:</div>
      <div class="max-h-[250px] overflow-y-auto rounded-md border border-border bg-bg p-2"><pre class="whitespace-pre-wrap font-mono text-xs text-muted m-0">{{ fileContent }}</pre></div>
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

