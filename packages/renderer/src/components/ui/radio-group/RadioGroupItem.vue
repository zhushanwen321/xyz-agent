<script setup lang="ts">
import type { RadioGroupItemEmits, RadioGroupItemProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { RadioGroupItem, RadioGroupIndicator, useForwardPropsEmits } from 'reka-ui'
import { cn } from '@/lib/utils'

/**
 * RadioGroupItem —— 单选项原语（reka-ui RadioGroupItem 封装）。
 * 视觉：size-[7px] 圆点（对齐 PresetSelectChip 旧自绘圆点尺寸），选中 bg-accent，未选 bg-subtle。
 * reka-ui 提供 roving tabindex、↑↓/Home/End 键盘导航、Space/R 切换、disabled 跳过。
 */
const props = withDefaults(
  defineProps<RadioGroupItemProps & { class?: HTMLAttributes['class'] }>(),
  {},
)
const emits = defineEmits<RadioGroupItemEmits>()
const delegatedProps = reactiveOmit(props, 'class')
const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <RadioGroupItem
    v-bind="forwarded"
    :class="
      cn(
        'flex size-[7px] shrink-0 items-center justify-center rounded-full bg-subtle outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-accent',
        props.class,
      )
    "
  >
    <RadioGroupIndicator />
  </RadioGroupItem>
</template>
