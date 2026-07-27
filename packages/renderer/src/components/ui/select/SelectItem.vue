<script setup lang="ts">
import type { SelectItemEmits, SelectItemProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { SelectItem, SelectItemIndicator, SelectItemText, useForwardPropsEmits } from 'reka-ui'
import { Check } from '@lucide/vue'
import { cn } from '@/lib/utils'

/**
 * SelectItem —— 下拉项。选中态显示 check，配色与项目其他 popover 列表项一致。
 * 文字用 text-fg（非 text-muted）：下拉项需保证可读对比度，muted 在暗底偏淡。
 */
const props = defineProps<SelectItemProps & { class?: HTMLAttributes['class'] }>()
const emits = defineEmits<SelectItemEmits>()
const delegatedProps = reactiveOmit(props, 'class')
const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <SelectItem
    v-bind="forwarded"
    :class="
      cn(
        'group/item relative flex w-full cursor-pointer select-none items-center gap-2 rounded-sm py-1.5 pl-2.5 pr-8 text-[13px] text-fg outline-none transition-colors data-[highlighted]:bg-surface-hover data-[highlighted]:text-fg data-[state=checked]:text-accent',
        props.class,
      )
    "
  >
    <span class="flex-1 truncate">
      <!-- 选项文案必须落在 SelectItemText 的默认 slot 内：
           SelectValue 靠它读 textContent 来渲染触发器已选值，
           SelectItemText 自己不带内容（reka 设计）→ 直接转发外层 slot。 -->
      <SelectItemText>
        <slot />
      </SelectItemText>
    </span>
    <!-- 可选 #action slot：选项右侧 append 区（Check 指示器左旁）。
         仅当调用方传 #action 时渲染，原有仅传文案的调用零影响。
         用法场景：SystemPage 提示音选择，每个声音项右侧带试听按钮。
         注意：#action 内的可交互元素自身应处理事件（@click.stop 等），这里容器层
         已 @click.stop / @pointerdown.stop 兜底阻止冒泡到 SelectItem 触发选中。 -->
    <span
      v-if="$slots.action"
      class="flex items-center justify-center opacity-0 transition-opacity group-data-[highlighted]/item:opacity-100"
      @click.stop
      @pointerdown.stop
    >
      <slot name="action" />
    </span>
    <span class="absolute right-2 flex size-4 items-center justify-center">
      <SelectItemIndicator>
        <Check class="size-3.5 text-accent" />
      </SelectItemIndicator>
    </span>
  </SelectItem>
</template>
