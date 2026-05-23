<template>
  <div class="p-0">
    <!-- Running state -->
    <div v-if="toolCall.status === 'running'" class="px-3 py-2.5">
      <div class="flex items-center gap-2 text-[11px] text-muted">
        <span class="inline-block w-2 h-2 border-[1.5px] border-accent border-t-transparent rounded-full animate-spin shrink-0"></span>
        <span class="font-mono">Executing...</span>
      </div>
      <pre class="whitespace-pre-wrap font-mono text-xs text-fg bg-bg rounded-none p-2 m-0 mt-2">{{ command }}</pre>
    </div>

    <!-- Completed state -->
    <div v-else>
      <!-- Command -->
      <div class="px-3 pt-2.5 pb-1">
        <div class="font-mono text-[10px] text-muted font-semibold mb-1">Command</div>
        <pre class="whitespace-pre-wrap font-mono text-xs text-fg bg-bg rounded-none p-2.5 m-0">{{ command }}</pre>
      </div>

      <!-- Output -->
      <div v-if="toolCall.output !== undefined" class="px-3 pb-2.5 pt-1">
        <div class="font-mono text-[10px] text-muted font-semibold mb-1">Output</div>
        <div class="max-h-[200px] overflow-y-auto rounded-none border border-border bg-surface p-2.5">
          <pre class="whitespace-pre-wrap font-mono text-xs text-muted leading-relaxed m-0">{{ toolCall.output }}</pre>
        </div>
      </div>
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
