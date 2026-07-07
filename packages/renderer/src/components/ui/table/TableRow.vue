<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'

const props = defineProps<{ class?: HTMLAttributes['class'] }>()
</script>

<template>
  <tr
    :class="cn(
      'border-b border-border transition-colors hover:bg-surface-hover/50 data-[state=selected]:bg-surface-hover',
      props.class,
    )"
  >
    <slot />
  </tr>
</template>
