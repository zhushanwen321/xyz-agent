<template>
  <div class="p-0">
    <!-- Running state: writing indicator -->
    <div v-if="toolCall.status === 'running'" class="px-3 py-2.5">
      <div class="flex items-center gap-2 text-[11px] text-muted">
        <span class="inline-block w-2 h-2 border-[1.5px] border-accent border-t-transparent rounded-full animate-spin shrink-0"></span>
        <span class="font-mono">Writing...</span>
        <span v-if="fileSizeStr" class="opacity-60">· {{ fileSizeStr }}</span>
        <span v-if="lineCount > 0" class="opacity-60">· {{ lineCount }} lines</span>
      </div>
    </div>

    <!-- Completed state: summary + content -->
    <div v-else>
      <!-- Summary header -->
      <div class="flex items-center gap-1.5 px-3 pt-2.5 pb-1 text-[11px] font-mono text-success">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="10" height="10" class="shrink-0"><path d="M4 8l3 3 5-6"/></svg>
        <span class="font-medium">Written</span>
        <span v-if="fileSizeStr" class="opacity-70 text-muted">· {{ fileSizeStr }}</span>
        <span v-if="lineCount > 0" class="opacity-70 text-muted">· {{ lineCount }} lines</span>
      </div>

      <!-- File content -->
      <div class="px-3 pb-2.5 pt-1">
        <div class="max-h-[250px] overflow-y-auto rounded-md border border-border bg-bg p-2.5">
          <pre class="whitespace-pre-wrap font-mono text-xs text-muted leading-relaxed m-0">{{ fileContent }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { ToolCall } from '@xyz-agent/shared'
const props = defineProps<{ toolCall: ToolCall }>()

const parsedInput = computed(() => {
  try {
    const obj = typeof props.toolCall.input === 'string' ? JSON.parse(props.toolCall.input) : props.toolCall.input
    return obj as Record<string, unknown>
  } catch { return {} }
})

const fileContent = computed(() => String(parsedInput.value.content ?? ''))

const fileSizeStr = computed(() => {
  const len = fileContent.value.length
  if (len === 0) return ''
  if (len < 1024) return `${len}B`
  if (len < 1024 * 1024) return `${(len / 1024).toFixed(1)}KB`
  return `${(len / (1024 * 1024)).toFixed(1)}MB`
})

const lineCount = computed(() => {
  const content = fileContent.value
  if (!content) return 0
  return content.split('\n').length
})
</script>
