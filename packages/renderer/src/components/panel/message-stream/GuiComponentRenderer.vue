<script setup lang="ts">
/**
 * GUI 组件路由器——按 GuiComponent.type 路由到对应 Vue 组件（spec §9.1）。
 *
 * P0+P1 阶段只实现路由骨架：仅 ansi-text 内置组件已落地，其余类型（task-list /
 * goal-status / card 等）属 P2 范围。未识别类型与未注册的 custom 均降级到 AnsiText，
 * 把结构化数据 JSON 序列化为文本展示（保证不丢信息，且不崩渲染）。
 *
 * 降级时的 prop 适配（关键点）：
 * - AnsiText.vue 的 props 是 { content: string }，而 GuiComponent.props 形状由 type 决定。
 *   直接 v-bind 非 ansi-text 的 props 会把对象/数组传给期望 string 的 content，渲染异常。
 * - 因此凡降级到 AnsiText（未识别类型 / 未注册 custom / 协议版本 ansi-text 但 lines 非数组）
 *   一律把 props 序列化为文本，只回填 content 字段。
 * - 协议定义 ansi-text 的 props 是 { lines: string[] }（见 extension-protocol types.ts），
 *   需 join 成多行字符串交给 AnsiText.vue 的 content——这与 Block.vue 走 outputRaw 的语义
 *   一致（AnsiText 用 ansi_up 解析 ANSI 转义着色）。
 *
 * custom 组件注册表通过 provide/inject（key 'gui-custom-registry'）注入，供内置 extension
 * 编译期注册自有组件（P2 实现）。
 */
import { computed, inject } from 'vue'
import type { Component } from 'vue'
import type { GuiComponent } from '@xyz-agent/extension-protocol'
import AnsiText from './gui/AnsiText.vue'

const props = defineProps<{ component: GuiComponent }>()

/** 已实现的内置组件映射。P2 阶段逐步补充 task-list / goal-status / card 等。 */
const BUILTIN_MAP: Record<string, Component> = {
  'ansi-text': AnsiText,
}

/** custom 组件注册表（内置 extension 编译期注册，P2 实现）。默认空表。 */
const CUSTOM_MAP = inject<Record<string, Component>>('gui-custom-registry', {})

/** JSON 序列化缩进（降级渲染用） */
const JSON_INDENT = 2

/**
 * 解析出实际渲染组件：
 * - custom 类型 → 查注册表，未注册降级 AnsiText
 * - 已注册内置类型 → 对应组件
 * - 未识别类型 → 降级 AnsiText
 */
const resolved = computed<Component>(() => {
  if (props.component.type === 'custom') {
    const name = (props.component.props as { component?: string }).component
    return CUSTOM_MAP[name ?? ''] ?? AnsiText
  }
  return BUILTIN_MAP[props.component.type] ?? AnsiText
})

/**
 * 适配后的 props——解决 AnsiText.vue 期望 { content: string } 与 GuiComponent.props 形状不匹配。
 *
 * 三种降级到 AnsiText 的情况统一走 JSON 序列化兜底（保留结构化信息，文本可读）：
 *   1. 非 ansi-text 类型降级（未识别 / 未注册 custom）
 *   2. ansi-text 但 props 不是 { lines: string[] } 形状（防御性：协议外脏数据）
 * 正常 ansi-text 把 lines join 成 content（与 Block.vue outputRaw 语义一致）。
 */
const resolvedProps = computed<Record<string, unknown>>(() => {
  const isAnsiTextShape =
    props.component.type === 'ansi-text' &&
    Array.isArray((props.component.props as { lines?: unknown }).lines)

  if (resolved.value === AnsiText) {
    if (isAnsiTextShape) {
      const lines = (props.component.props as { lines: string[] }).lines
      return { content: lines.join('\n') }
    }
    // 降级：未识别类型 / 未注册 custom / 脏数据 —— 序列化为可读文本
    return { content: JSON.stringify(props.component.props, null, JSON_INDENT) }
  }

  return props.component.props as Record<string, unknown>
})
</script>

<template>
  <!-- 包一层 span 容器承担 data-testid。若直接放在 <component> 上，属性继承会把子组件
       根元素的同名 attr（如 AnsiText 的 data-testid="ansi-text"）覆盖掉，导致无法区分。
       容器隔离继承作用域，子组件保留自身 testid，本组件也有 testid 供上层断言。 -->
  <span data-testid="gui-component-renderer">
    <component :is="resolved" v-bind="resolvedProps" />
  </span>
</template>
