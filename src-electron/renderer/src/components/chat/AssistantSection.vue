<!--
  Section 容器组件：为 thinking/toolCall/text 提供统一的
  border-left 缩进（按 type 着色）+ 圆点标签 + 间距控制。
-->
<template>
  <div :class="['asst-section', 'asst-section--spacing', `asst-section--${type}`]">
    <!-- Section label (optional) -->
    <div v-if="label" class="asst-section__label">
      <span :class="['asst-section__dot', dotClass]" />
      {{ label }}
    </div>
    <!-- Section content -->
    <slot />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { SectionType } from '../../lib/message-layout'

const props = defineProps<{
  type: SectionType
  label?: string
}>()

const dotClass = computed(() => {
  const map: Record<SectionType, string> = {
    thinking: 'asst-section__dot--thinking',
    toolCall: 'asst-section__dot--tool',
    text: 'asst-section__dot--text',
  }
  return map[props.type]
})
</script>
