<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'

const props = defineProps<{ class?: HTMLAttributes['class'] }>()
</script>

<template>
  <td
    :class="cn(
      'px-3 py-2 align-middle text-fg [&:has([role=checkbox])]:pr-0',
      props.class,
    )"
  >
    <slot />
  </td>
</template>
