<script setup lang="ts">
/**
 * 原语内部路由组件——按 GuiComponent.type 路由到对应原语组件（rendering-protocol 内部用）。
 *
 * 用途：Card/Columns 等容器原语递归渲染子组件时，inject(PRIMITIVE_RENDER_KEY)
 * 未命中（ui 包独立使用/测试场景）时的回退渲染器。renderer 场景下
 * GuiComponentRenderer provide 自身（含 custom 注册表 + ansi-text 降级逻辑），
 * 递归行为与 re-home 前完全一致。
 *
 * 降级：未识别类型 / 未注册 custom → PrimitiveFallback（JSON 序列化文本）。
 */
import { computed, inject } from 'vue'
import type { Component } from 'vue'
import type { GuiComponent, GuiComponentType } from '@xyz-agent/extension-protocol'
import AnsiText from './AnsiText.vue'
import ProgressBar from './ProgressBar.vue'
import StatsLine from './StatsLine.vue'
import TabBar from './TabBar.vue'
import Card from './Card.vue'
import Columns from './Columns.vue'
import ListTree from './ListTree.vue'
import { GUI_CUSTOM_REGISTRY_KEY } from '../registry'
import { PrimitiveFallback } from '../primitive-render-key'

const props = defineProps<{ component: GuiComponent }>()

/** 已实现的内置组件映射。键钉到 GuiComponentType，新增 type 时编译期可见。 */
const BUILTIN_MAP: Partial<Record<GuiComponentType, Component>> = {
  'ansi-text': AnsiText,
  'progress-bar': ProgressBar,
  'stats-line': StatsLine,
  'tab-bar': TabBar,
  'card': Card,
  'columns': Columns,
  'list-tree': ListTree,
}

/** custom 组件注册表（内置 extension 编译期注册，P2 实现）。默认空表。 */
const CUSTOM_MAP = inject(GUI_CUSTOM_REGISTRY_KEY, {})

/**
 * 解析出实际渲染组件：
 * - custom 类型 → 查注册表，未注册降级 PrimitiveFallback
 * - 已注册内置类型 → 对应组件
 * - 未识别类型 → PrimitiveFallback
 */
const resolved = computed<Component>(() => {
  if (props.component.type === 'custom') {
    const name = (props.component.props as { component?: string }).component
    return CUSTOM_MAP[name ?? ''] ?? PrimitiveFallback
  }
  return BUILTIN_MAP[props.component.type] ?? PrimitiveFallback
})

/** 适配后的 props——ansi-text 期望 { lines: string[] } 时 join 成 content。 */
const resolvedProps = computed<Record<string, unknown>>(() => {
  if (
    props.component.type === 'ansi-text' &&
    Array.isArray((props.component.props as { lines?: unknown }).lines)
  ) {
    const lines = (props.component.props as { lines: string[] }).lines
    return { content: lines.join('\n') }
  }
  return props.component.props as Record<string, unknown>
})
</script>

<template>
  <component :is="resolved" v-bind="resolvedProps" />
</template>
