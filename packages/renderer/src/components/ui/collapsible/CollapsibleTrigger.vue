<script setup lang="ts">
import type { CollapsibleTriggerProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { CollapsibleTrigger as RekaCollapsibleTrigger, useForwardProps } from 'reka-ui'
import { cn } from '@/lib/utils'

/**
 * CollapsibleTrigger —— 折叠触发器（reka-ui CollapsibleTrigger 封装）。
 * 默认 as-child 透传（配合 Button 等组件使用，不额外渲染 button 元素）。
 */
const props = defineProps<CollapsibleTriggerProps & { class?: HTMLAttributes['class'] }>()
const delegatedProps = reactiveOmit(props, 'class')
const forwarded = useForwardProps(delegatedProps)
</script>

<template>
  <RekaCollapsibleTrigger v-bind="forwarded" as-child :class="cn('', props.class)">
    <slot />
  </RekaCollapsibleTrigger>
</template>
