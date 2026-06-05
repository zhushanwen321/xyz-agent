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
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

export type SendMode = 'send' | 'steer' | 'queue'

const props = defineProps<{
  mode: SendMode
}>()

const modeLabel = computed(() => {
  switch (props.mode) {
    case 'steer': return 'Steer'
    case 'queue': return 'Queue'
    default: return 'Send'
  }
})

const modeHint = computed(() => {
  switch (props.mode) {
    case 'steer': return '将中断当前 AI 处理'
    case 'queue': return 'Alt+Enter 排队'
    default: return 'Enter 发送'
  }
})

const modeClass = computed(() => {
  switch (props.mode) {
    case 'steer': return 'text-accent'
    case 'queue': return 'text-warning'
    default: return 'text-muted'
  }
})
</script>
