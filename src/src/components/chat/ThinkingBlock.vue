<template>
  <div class="thinking-block">
    <button class="thinking-header" @click="expanded = !expanded">
      <span class="thinking-icon">◆</span>
      <span class="thinking-label">Thinking</span>
      <span v-if="streaming" class="thinking-pulse"></span>
      <svg class="thinking-chevron" :class="{ 'rotated': expanded }" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
    </button>
    <div v-if="expanded" class="thinking-body">
      <pre class="thinking-text">{{ text }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

defineProps<{ text: string; streaming?: boolean }>()
const expanded = ref(false)
</script>

<style scoped>
.thinking-block { overflow: hidden; border-radius: var(--radius-md); border: 1px solid var(--color-border); background: var(--color-surface); margin-bottom: 8px; }
.thinking-header { display: flex; width: 100%; align-items: center; gap: 6px; padding: 6px 12px; text-align: left; cursor: pointer; transition: background 0.15s; background: none; border: none; color: inherit; font: inherit; }
.thinking-header:hover { background: var(--color-bg-base); }
.thinking-icon { font-size: 10px; color: var(--color-text-muted); }
.thinking-label { font-size: 12px; font-family: var(--font-mono); color: var(--color-text-muted); }
.thinking-pulse { display: inline-block; width: 5px; height: 10px; background: var(--color-accent); animation: pulse 1s ease-in-out infinite; }
.thinking-chevron { margin-left: auto; color: var(--color-text-muted); transition: transform 0.2s; }
.thinking-chevron.rotated { transform: rotate(180deg); }
.thinking-body { border-top: 1px solid var(--color-border); padding: 8px 12px; }
.thinking-text { white-space: pre-wrap; font-family: var(--font-mono); font-size: 12px; line-height: 1.5; color: var(--color-text-muted); margin: 0; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
</style>
