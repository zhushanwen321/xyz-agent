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

<style scoped>
/* Section container with border-left indent */
.asst-section {
  margin-bottom: 6px;
  padding-left: 12px;
  position: relative;
}
.asst-section::before {
  content: '';
  position: absolute;
  left: 0;
  top: 4px;
  bottom: 4px;
  width: 2px;
  background: var(--divider);
  border-radius: 1px;
}
/* Per-type colored left border */
.asst-section--thinking::before { background: var(--accent); }
.asst-section--toolCall::before { background: var(--success); }
.asst-section--text::before { background: var(--agent); }
.asst-section:last-child {
  margin-bottom: 0;
}
/* Section-internal spacing between child components */
.asst-section--spacing {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* Section label with colored dot */
.asst-section__label {
  font-size: 10px;
  color: var(--muted);
  font-weight: 500;
  margin-bottom: 3px;
  display: flex;
  align-items: center;
  gap: 4px;
}
.asst-section__dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
}
.asst-section__dot--thinking { background: var(--accent); }
.asst-section__dot--tool { background: var(--success); }
.asst-section__dot--text { background: var(--agent); }
</style>
