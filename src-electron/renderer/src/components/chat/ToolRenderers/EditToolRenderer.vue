<template>
  <div class="p-0">
    <!-- Running state -->
    <div v-if="toolCall.status === 'running'" class="px-3 py-2.5">
      <div class="flex items-center gap-2 text-[11px] text-muted">
        <span class="inline-block w-2 h-2 border-[1.5px] border-accent border-t-transparent rounded-full animate-spin shrink-0"></span>
        <span class="font-mono">Editing...</span>
        <span v-if="diffSize" class="opacity-60">· {{ diffSize }}</span>
      </div>
    </div>

    <!-- Completed state: old / new diff -->
    <div v-else>
      <!-- Summary header -->
      <div class="flex items-center gap-1.5 px-3 pt-2.5 pb-1 text-[10px] font-mono text-success">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="10" height="10" class="shrink-0"><path d="M4 8l3 3 5-6"/></svg>
        <span class="font-medium">Edited</span>
        <span v-if="diffSize" class="opacity-70 text-muted">· {{ diffSize }}</span>
      </div>

      <!-- Diff display -->
      <div class="flex flex-col gap-2.5 px-3 pb-3 pt-1">
        <div v-if="oldText">
          <div class="font-mono text-[10px] text-danger font-semibold mb-1">− Removed</div>
          <pre class="whitespace-pre-wrap font-mono text-xs text-danger bg-bg rounded-md border border-danger/20 p-2.5 m-0 max-h-[130px] overflow-y-auto">{{ oldText }}</pre>
        </div>
        <div v-if="newText">
          <div class="font-mono text-[10px] text-success font-semibold mb-1">+ Added</div>
          <pre class="whitespace-pre-wrap font-mono text-xs text-success bg-bg rounded-md border border-success/20 p-2.5 m-0 max-h-[130px] overflow-y-auto">{{ newText }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { ToolCall } from '@xyz-agent/shared'

const BYTES_PER_KB = 1024

const props = defineProps<{ toolCall: ToolCall }>()

const parsedInput = computed(() => {
  try {
    const obj = typeof props.toolCall.input === 'string' ? JSON.parse(props.toolCall.input) : props.toolCall.input
    return obj as Record<string, unknown>
  } catch { return {} }
})

const oldText = computed(() => String(parsedInput.value.old_text ?? ''))
const newText = computed(() => String(parsedInput.value.new_text ?? ''))

const diffSize = computed(() => {
  const oldLen = oldText.value.length
  const newLen = newText.value.length
  if (oldLen === 0 && newLen === 0) return ''
  // Show diff as total change size
  const total = oldLen + newLen
  if (total < BYTES_PER_KB) return `${total}B changed`
  if (total < BYTES_PER_KB * BYTES_PER_KB) return `${(total / BYTES_PER_KB).toFixed(1)}KB changed`
  return `${(total / (BYTES_PER_KB * BYTES_PER_KB)).toFixed(1)}MB changed`
})
</script>
