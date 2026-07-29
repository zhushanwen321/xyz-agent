<script setup lang="ts">
import type { CollapsibleContentProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { CollapsibleContent, useForwardProps } from 'reka-ui'
import { cn } from '@/lib/utils'

/**
 * CollapsibleContent —— 折叠内容区（reka-ui CollapsibleContent 封装）。
 * 展开时渲染（data-state=open），折叠时不渲染（reka 默认 v-if 行为）。
 * 动画由 reka 内置 CSS variable（--reka-collapsible-content-width/height）驱动，
 * 调用方按需用 data-[state=open]:animate-in / data-[state=closed]:animate-out 加过渡。
 */
const props = defineProps<CollapsibleContentProps & { class?: HTMLAttributes['class'] }>()
const delegatedProps = reactiveOmit(props, 'class')
const forwarded = useForwardProps(delegatedProps)
</script>

<template>
  <CollapsibleContent
    v-bind="forwarded"
    :class="
      cn(
        'overflow-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        props.class,
      )
    "
  >
    <slot />
  </CollapsibleContent>
</template>
