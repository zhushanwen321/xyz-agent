<template>
  <div class="overflow-hidden rounded-sm border border-border bg-surface mb-2">
    <Button variant="ghost" class="flex w-full items-center gap-1.5 px-3 py-1.5 text-left cursor-pointer transition-colors duration-150 ease-ease justify-start !rounded-none hover:bg-bg focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2" @click="expanded = !expanded">
      <span class="text-[11px] font-mono leading-snug text-muted">Thinking<span v-if="!expanded">...</span></span>
      <span v-if="streaming" class="inline-block w-[5px] h-2.5 bg-accent animate-pulse-bar motion-reduce:opacity-60 motion-reduce:animate-none"></span>
      <svg :class="['ml-auto text-muted transition-transform duration-200 ease-ease motion-reduce:transition-none', { 'rotate-180': expanded }]" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
    </Button>
    <div v-if="expanded" class="border-t border-border px-3 py-2">
      <pre class="whitespace-pre-wrap font-mono text-[11px] leading-normal text-muted m-0">{{ text }}</pre>
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


