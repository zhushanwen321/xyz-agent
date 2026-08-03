<script setup lang="ts">
/**
 * 卡片容器组件——替代 TUI 的 ┌─┐││└─┘ box 边框。
 * variant 映射边框+底色；header 可以是 string 或 GuiComponent（后者递归调渲染器）；
 * body 通过 v-for + 渲染器递归渲染子组件。
 * 渲染器经 PRIMITIVE_RENDER_KEY 注入（renderer 的 GuiComponentRenderer provide 自身），
 * 未注入时回退内置 PrimitiveRouter。
 */
import { computed, inject } from 'vue'
import type { Component } from 'vue'
import type { GuiComponent } from '@xyz-agent/extension-protocol'
import { PRIMITIVE_RENDER_KEY } from '../primitive-render-key'
import PrimitiveRouter from './PrimitiveRouter.vue'

/** 递归渲染器：注入优先（renderer 场景），独立使用回退内置路由 */
const renderer = inject<Component>(PRIMITIVE_RENDER_KEY, PrimitiveRouter)

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
      class="flex items-center gap-1.5 border-b border-border px-3 py-2 font-mono text-[length:var(--text-xs)] font-semibold uppercase tracking-[0.04em] text-neutral-mid"
    >
      <template v-if="isStringHeader">
        <span>{{ header }}</span>
      </template>
      <component :is="renderer" v-else-if="headerComponent" :component="headerComponent" />
    </div>
    <div class="p-3">
      <component
        :is="renderer"
        v-for="(child, i) in body"
        :key="i"
        :component="child"
      />
    </div>
  </div>
</template>
