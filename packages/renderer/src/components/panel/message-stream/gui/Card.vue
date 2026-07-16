<script setup lang="ts">
/**
 * 卡片容器组件——替代 TUI 的 ┌─┐││└─┘ box 边框。
 * variant 映射边框+底色；header 可以是 string 或 GuiComponent（后者递归调 GuiComponentRenderer）；
 * body 通过 v-for + GuiComponentRenderer 递归渲染子组件。
 */
import { computed } from 'vue'
import type { GuiComponent } from '@xyz-agent/extension-protocol'
import GuiComponentRenderer from '../GuiComponentRenderer.vue'

const props = defineProps<{
  variant?: 'default' | 'elevated' | 'danger' | 'success'
  header?: GuiComponent | string
  body: GuiComponent[]
}>()

const isStringHeader = computed(() => typeof props.header === 'string')

/** header 为 GuiComponent 时收窄类型，避免模板内 as 断言 */
const headerComponent = computed<GuiComponent | null>(() =>
  isStringHeader.value || !props.header ? null : props.header as GuiComponent,
)

const cardClass = computed(() => {
  const map: Record<NonNullable<typeof props.variant>, string> = {
    default: 'border-border bg-surface',
    elevated: 'border-border-strong bg-surface-2',
    danger: 'border-danger',
    success: 'border-success',
  }
  return map[props.variant ?? 'default']
})
</script>

<template>
  <div
    class="overflow-hidden rounded-lg border"
    :class="cardClass"
    data-testid="gui-card"
  >
    <div
      v-if="header"
      class="flex items-center gap-1.5 border-b border-border px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.04em] text-muted"
    >
      <template v-if="isStringHeader">
        <span>{{ header }}</span>
      </template>
      <GuiComponentRenderer v-else-if="headerComponent" :component="headerComponent" />
    </div>
    <div class="p-3">
      <GuiComponentRenderer
        v-for="(child, i) in body"
        :key="i"
        :component="child"
      />
    </div>
  </div>
</template>
