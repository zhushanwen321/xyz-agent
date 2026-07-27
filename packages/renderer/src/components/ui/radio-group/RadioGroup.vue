<script setup lang="ts">
import type { RadioGroupRootEmits, RadioGroupRootProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { RadioGroupRoot, useForwardPropsEmits } from 'reka-ui'
import { cn } from '@/lib/utils'

/**
 * RadioGroup —— 单选原语（reka-ui RadioGroupRoot 封装）。
 * 替代 PresetSelectChip 用 ghost Button + 自绘 radio 圆点手搓单选语义，
 * 恢复标准 radio 的键盘可达性（↑↓ 导航 + Tab 进组 + Space/R 切换）和 ARIA 语义。
 * roving-focus + 自动管理 tabindex 由 reka-ui 提供。
 */
const props = withDefaults(
  defineProps<RadioGroupRootProps & { class?: HTMLAttributes['class'] }>(),
  {},
)
const emits = defineEmits<RadioGroupRootEmits>()
const delegatedProps = reactiveOmit(props, 'class')
const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <RadioGroupRoot v-bind="forwarded" :class="cn('grid gap-0', props.class)">
    <slot />
  </RadioGroupRoot>
</template>
