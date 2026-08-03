/**
 * 原语渲染协议 key —— rendering-protocol 层与消费方（renderer）的注入契约。
 *
 * - PRIMITIVE_RENDER_KEY：渲染器组件注入点。原语组件内部递归渲染子组件时
 *   inject 此 key 获取渲染器；未注入时回退内置 PrimitiveRouter（7 原语路由）。
 *   renderer 的 GuiComponentRenderer provide 自身（含 custom 注册表与 ansi-text
 *   降级逻辑），保证 re-home 后递归行为与迁移前完全一致。
 * - PrimitiveFallback：不支持类型的兜底渲染。未识别 type / 未注册 custom 时
 *   渲染 JSON 序列化文本，保证不丢信息、不崩渲染。
 *
 * 注意：vue 为 runtime-only（无模板编译器），组件必须用 render 函数，
 * 不能用 template 字符串。
 */
import { computed, defineComponent, h } from 'vue'
import type { Component, InjectionKey, PropType } from 'vue'
import type { GuiComponent } from '@xyz-agent/extension-protocol'

export const PRIMITIVE_RENDER_KEY: InjectionKey<Component> = Symbol('primitive-render')

/** JSON 序列化缩进（兜底渲染用） */
const JSON_INDENT = 2

/**
 * 兜底渲染组件：对不支持的 GUI 组件类型渲染可读文本。
 * 接受任意 props（来自 GuiComponent.props 的 Record<string, unknown>）。
 */
export const PrimitiveFallback = defineComponent({
  name: 'PrimitiveFallback',
  props: {
    component: { type: Object as PropType<GuiComponent>, required: true },
  },
  setup(props) {
    const text = computed(() =>
      JSON.stringify(props.component.props, null, JSON_INDENT),
    )
    return () =>
      h(
        'span',
        {
          'data-testid': 'primitive-fallback',
          class: 'font-mono text-[length:var(--text-xs)] text-neutral-dim',
        },
        text.value,
      )
  },
})
