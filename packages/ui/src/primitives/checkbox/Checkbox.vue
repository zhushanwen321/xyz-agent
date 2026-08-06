<script setup lang="ts">
import type { CheckboxRootEmits, CheckboxRootProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { CheckboxRoot, CheckboxIndicator, useForwardPropsEmits } from 'reka-ui'
import { Check } from '@lucide/vue'
import { cn } from '../../lib/utils'

/**
 * Checkbox —— 勾选原语（reka-ui CheckboxRoot 封装）。
 * 替代 SkillPage/AgentPage 加载路径的裸 <input type=checkbox>。
 * 样式：size-4 / 未选态 border neutral-mid（1px !important，绕过 renderer 全局
 * `*{border-width:0}` unlayered 规则对该 button 的覆盖——CSS Cascade Layers 导致
 * 普通 .border(1px) 被 unlayered `*`(0px) 压过，未选态边框宽度塌成 0 不可见）/
 * 选中 bg-accent + border-accent。Check icon 白色。对齐冷蓝暗色规范。
 */
const props = withDefaults(
  defineProps<CheckboxRootProps & { class?: HTMLAttributes['class'] }>(),
  {},
)
const emits = defineEmits<CheckboxRootEmits>()
const delegatedProps = reactiveOmit(props, 'class')
const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <CheckboxRoot
    v-bind="forwarded"
    :class="
      cn(
        'peer size-4 shrink-0 rounded-sm !border border-neutral-mid bg-transparent outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=unchecked]:border-neutral-mid data-[state=unchecked]:bg-transparent',
        props.class,
      )
    "
  >
    <CheckboxIndicator class="flex items-center justify-center text-current">
      <Check class="size-3 text-white" />
    </CheckboxIndicator>
  </CheckboxRoot>
</template>
