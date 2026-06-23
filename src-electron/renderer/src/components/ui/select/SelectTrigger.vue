<script setup lang="ts">
import type { SelectTriggerProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { SelectIcon, SelectTrigger } from 'reka-ui'
import { ChevronDown } from '@lucide/vue'
import { cn } from '@/lib/utils'

/**
 * SelectTrigger —— 触发器，样式与 Input 对齐（h-9 / 圆角 / 边框 / 聚焦环）。
 * 右侧自带 ChevronDown。尺寸可通过 class 覆盖（如 h-8）。
 */
const props = defineProps<SelectTriggerProps & { class?: HTMLAttributes['class'] }>()
const delegatedProps = reactiveOmit(props, 'class')
</script>

<template>
  <SelectTrigger
    v-bind="delegatedProps"
    :class="
      cn(
        'flex w-full items-center justify-between gap-2 rounded-md border border-border bg-surface-2 px-3 py-2 text-[13px] text-fg outline-none transition-colors placeholder:text-muted focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent-ring disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-muted',
        props.class,
      )
    "
  >
    <slot />
    <SelectIcon as-child>
      <ChevronDown class="size-4 shrink-0 text-subtle opacity-50 transition-transform duration-200" />
    </SelectIcon>
  </SelectTrigger>
</template>
