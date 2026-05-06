<template>
  <div class="bash-renderer">
    <div class="bash-section">
      <div class="bash-label">Command:</div>
      <pre class="bash-cmd">{{ command }}</pre>
    </div>
    <div v-if="toolCall.output !== undefined && toolCall.status !== 'running'" class="bash-section">
      <div class="bash-label">Output:</div>
      <div class="bash-output"><pre>{{ toolCall.output }}</pre></div>
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

<style scoped>
.bash-renderer { padding: 0; }
.bash-section { padding: 8px 10px; }
.bash-label { font-family: var(--font-mono); font-size: 11px; color: var(--color-text-muted); margin-bottom: 4px; }
.bash-cmd { white-space: pre-wrap; font-family: var(--font-mono); font-size: 12px; color: var(--color-text-primary); background: var(--color-bg-base); border-radius: var(--radius-md); padding: 8px; margin: 0; }
.bash-output { max-height: 200px; overflow-y: auto; border-radius: var(--radius-md); border: 1px solid var(--color-border); background: var(--color-surface); padding: 8px; }
.bash-output pre { white-space: pre-wrap; font-family: var(--font-mono); font-size: 12px; color: var(--color-text-muted); margin: 0; }
</style>
