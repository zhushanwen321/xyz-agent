<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'

const props = defineProps<{ class?: HTMLAttributes['class'] }>()
</script>

<template>
  <th
    :class="cn(
      'px-3 py-2 text-left align-middle text-[11px] font-normal uppercase tracking-wider text-subtle [&:has([role=checkbox])]:pr-0',
      props.class,
    )"
  >
    <slot />
  </th>
</template>
