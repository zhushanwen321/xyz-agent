<template>
  <div
    :class="[
      'flex items-center h-5 px-3.5 text-[11px] font-mono select-none transition-colors duration-150',
      modeClass,
    ]"
  >
    <span class="font-medium">{{ modeLabel }}</span>
    <span class="mx-1 opacity-40">·</span>
    <span class="opacity-70">{{ modeHint }}</span>
    <span
      v-if="showAuto"
      class="ml-1.5 text-[9px] font-semibold uppercase tracking-[0.04em] opacity-60"
    >auto</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

export type SendMode = 'send' | 'steer' | 'queue'

const props = defineProps<{
  mode: SendMode
  isStreaming?: boolean
}>()

const isMac = navigator.platform?.startsWith('Mac') ?? false

const modeLabel = computed(() => {
  switch (props.mode) {
    case 'steer': return 'Steer'
    case 'queue': return 'Queue'
    default: return 'Send'
  }
})

const modeHint = computed(() => {
  switch (props.mode) {
    case 'steer': return isMac ? '⌘+Enter' : 'Ctrl+Enter'
    case 'queue': return isMac ? '⌥+Enter' : 'Alt+Enter'
    default: return 'Enter'
  }
})

const showAuto = computed(() => props.mode === 'queue' && props.isStreaming)

const modeClass = computed(() => {
  switch (props.mode) {
    case 'steer': return 'text-accent'
    case 'queue': return 'text-warning'
    default: return 'text-muted'
  }
})
</script>
