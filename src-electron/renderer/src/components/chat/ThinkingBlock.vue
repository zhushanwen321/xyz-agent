<template>
  <div class="overflow-hidden border border-border mb-2 thinking-block">
    <button class="thinking-header" @click="expanded = !expanded">
      <span class="text-[11px] font-mono leading-snug text-accent font-medium">Thinking<span v-if="!expanded">...</span></span>
      <span v-if="streaming" class="inline-block w-[5px] h-2.5 bg-accent animate-pulse-bar motion-reduce:opacity-60 motion-reduce:animate-none"></span>
      <svg :class="['ml-auto text-muted transition-transform duration-200 ease-ease motion-reduce:transition-none', { 'rotate-180': expanded }]" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
    </button>
    <div v-if="expanded" class="border-t border-border px-3 py-2">
      <pre class="whitespace-pre-wrap font-mono text-[11px] leading-normal text-muted m-0">{{ text }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

defineProps<{ text: string; streaming?: boolean }>()
const expanded = ref(true)

// 始终展开，不做自动折叠
</script>

<style scoped>
.thinking-block {
  background: var(--bg);
  border-radius: 2px;
}
.thinking-header {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 12px;
  cursor: pointer;
  border: none;
  background: linear-gradient(to right, var(--accent-light) 0%, var(--accent-light) 40%, transparent 100%);
  transition: background 0.15s ease;
  text-align: left;
}
.thinking-header:hover {
  background: linear-gradient(to right, var(--accent-light) 0%, var(--accent-light) 55%, transparent 100%);
}
</style>
