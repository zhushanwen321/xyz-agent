<template>
  <div class="thinking-block">
    <Button variant="ghost" class="thinking-header" @click="expanded = !expanded">
      <span class="thinking-label">Thinking<span v-if="!expanded">...</span></span>
      <span v-if="streaming" class="thinking-pulse"></span>
      <svg class="thinking-chevron" :class="{ 'rotated': expanded }" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
    </Button>
    <div v-if="expanded" class="thinking-body">
      <pre class="thinking-text">{{ text }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { Button } from '../../design-system'

const props = defineProps<{ text: string; streaming?: boolean; collapsed?: boolean }>()
const expanded = ref(!props.collapsed)

// streaming 进行中时自动展开，完成时折叠
watch(() => props.collapsed, (v) => {
  expanded.value = !v
})
</script>

<style scoped>
.thinking-block { overflow: hidden; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--surface); margin-bottom: 8px; }
.thinking-header { display: flex; width: 100%; align-items: center; gap: 6px; padding: 6px 12px; text-align: left; cursor: pointer; transition: background 0.15s var(--ease); background: none; border: none; color: inherit; font: inherit; border-radius: 0 !important; }
.thinking-header:hover { background: var(--bg); }
.thinking-label { font-size: 11px; font-family: var(--font-mono); line-height: 1.4; color: var(--muted); }
.thinking-pulse { display: inline-block; width: 5px; height: 10px; background: var(--accent); animation: pulse 1s ease-in-out infinite; }
.thinking-chevron { margin-left: auto; color: var(--muted); transition: transform 0.2s var(--ease); }
.thinking-chevron.rotated { transform: rotate(180deg); }
.thinking-body { border-top: 1px solid var(--border); padding: 8px 12px; }
.thinking-text { white-space: pre-wrap; font-family: var(--font-mono); font-size: 11px; line-height: 1.5; color: var(--muted); margin: 0; }
.thinking-header:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
@media (prefers-reduced-motion: reduce) {
  .thinking-pulse { animation: none; opacity: 0.6; }
  .thinking-chevron { transition: none; }
}
</style>
