<template>
  <div class="p-0">
    <!-- Running state -->
    <div v-if="toolCall.status === 'running'" class="px-3 py-2.5">
      <div class="flex items-center gap-2 text-[11px] text-muted">
        <span class="inline-block w-2 h-2 border-[1.5px] border-accent border-t-transparent rounded-full animate-spin shrink-0"></span>
        <span class="font-mono">Reading...</span>
      </div>
    </div>

    <!-- Completed state -->
    <div v-else>
      <!-- Summary header -->
      <div class="flex items-center gap-1.5 px-3 pt-2.5 pb-1 text-[10px] font-mono text-success">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="10" height="10" class="shrink-0"><path d="M4 8l3 3 5-6"/></svg>
        <span class="font-medium">Read</span>
      </div>

      <!-- File content -->
      <div v-if="toolCall.output !== undefined" class="px-3 pb-2.5 pt-1">
        <div class="max-h-[250px] overflow-y-auto rounded-none border border-border bg-bg p-2.5">
          <pre class="whitespace-pre-wrap font-mono text-xs text-muted leading-relaxed m-0">{{ toolCall.output }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ToolCall } from '@xyz-agent/shared'
defineProps<{ toolCall: ToolCall }>()
</script>
