<script setup lang="ts">
/**
 * 原语内部路由组件——按 GuiComponent.type 路由到对应原语组件（rendering-protocol 内部用）。
 *
 * 用途：Card/Columns 等容器原语递归渲染子组件时，inject(PRIMITIVE_RENDER_KEY)
 * 未命中（ui 包独立使用/测试场景）时的回退渲染器。renderer 场景下
 * GuiComponentRenderer provide 自身（含 custom 注册表 + ansi-text 降级逻辑），
 * 递归行为与 re-home 前完全一致。
 *
 * 降级 SSOT 在 core resolveComponent（§7.2）：未注册 custom / 未知 type / 脏数据
 * 统一降级为 AnsiText——与顶层 GuiComponentRenderer 行为一致。此前本组件降级到
 * PrimitiveFallback（第三份不一致实现），现已收敛，容器内与顶层降级行为统一。
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
import Group from './Group.vue'
import ListTree from './ListTree.vue'
import { GUI_CUSTOM_REGISTRY_KEY } from '../registry'
import { resolveComponent } from '@xyz-agent/core/rendering-protocol'

const props = defineProps<{ component: GuiComponent }>()

/** core resolveComponent 保证可渲染的 builtin type（ansi-text + 6 布局原语）。 */
type RenderableBuiltinType = Exclude<GuiComponentType, 'custom'>

/** builtin type → Vue 组件纯映射表（无降级分支，降级 SSOT 在 core resolveComponent）。
 * 键钉到 RenderableBuiltinType，新增 type 时编译期可见。 */
const BUILTIN_MAP: Record<RenderableBuiltinType, Component> = {
  'ansi-text': AnsiText,
  'progress-bar': ProgressBar,
  'stats-line': StatsLine,
  'tab-bar': TabBar,
  'card': Card,
  'columns': Columns,
  'group': Group,
  'list-tree': ListTree,
}

/** custom 组件注册表（内置 extension 编译期注册）。默认空表。 */
const CUSTOM_MAP = inject(GUI_CUSTOM_REGISTRY_KEY, {})

/** core 解析结果：{ type, props }。type 为最终渲染键，props 已适配。 */
const resolved = computed(() => resolveComponent(props.component, CUSTOM_MAP))

/** resolved.type → Vue Component 纯查表（降级决策在 core，统一 AnsiText）：
 * custom → CUSTOM_MAP 按 props.component 查（core 已保证已注册）；其余 → BUILTIN_MAP。 */
const renderComponent = computed<Component>(() => {
  const { type, props: resolvedProps } = resolved.value
  if (type === 'custom') {
    return CUSTOM_MAP[(resolvedProps as { component: string }).component]
  }
  return BUILTIN_MAP[type]
})
</script>

<template>
  <component :is="renderComponent" v-bind="resolved.props" />
</template>
