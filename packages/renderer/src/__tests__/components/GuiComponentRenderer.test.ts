/**
 * GuiComponentRenderer 路由测试（审计项 C / P0+P1）。
 *
 * 验证：
 * - ansi-text 类型 → 渲染 AnsiText（lines join 成 content，ansi_up 着色）
 * - 协议内但 P2 前未实现的通用原语（如 card）→ 降级 AnsiText，content 为 props 的 JSON 文本
 * - custom 类型未注册 → 降级 AnsiText，content 为 props 的 JSON 文本
 * - custom 类型已注册（provide 'gui-custom-registry'）→ 路由到注册组件
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/GuiComponentRenderer.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import GuiComponentRenderer from '@/components/panel/message-stream/GuiComponentRenderer.vue'
import type { GuiComponent } from '@xyz-agent/extension-protocol'

describe('GuiComponentRenderer 路由', () => {
  it('ansi-text 类型 → 渲染 AnsiText，lines join 成 content', () => {
    const component: GuiComponent = {
      type: 'ansi-text',
      props: { lines: ['\x1b[32mhello\x1b[0m', 'world'] },
    }
    const wrapper = mount(GuiComponentRenderer, { props: { component } })

    // AnsiText 渲染了 data-testid="ansi-text"
    expect(wrapper.find('[data-testid="ansi-text"]').exists()).toBe(true)
    // lines 被 join('\n')：ansi_up 把 ANSI 转成 span，"world" 作为纯文本保留
    expect(wrapper.text()).toContain('world')
    // ansi_up 着色后应有 style span（绿色）
    expect(wrapper.html()).toContain('color')
  })

  it('协议内但 P2 前未实现的通用原语（card）→ 降级 AnsiText，content 为 JSON 文本', () => {
    const component: GuiComponent = {
      type: 'card',
      props: { variant: 'elevated', body: [] },
    }
    const wrapper = mount(GuiComponentRenderer, { props: { component } })

    // 降级到 AnsiText
    expect(wrapper.find('[data-testid="ansi-text"]').exists()).toBe(true)
    // content 是 props 的 JSON 文本（缩进 2 空格，关键字段可见）
    const text = wrapper.text()
    expect(text).toContain('"variant": "elevated"')
    expect(text).toContain('"body"')
  })

  it('custom 类型未注册 → 降级 AnsiText，content 为 JSON 文本', () => {
    const component: GuiComponent = {
      type: 'custom',
      props: { component: 'my-widget', props: { count: 3 } },
    }
    const wrapper = mount(GuiComponentRenderer, { props: { component } })

    // 降级到 AnsiText
    expect(wrapper.find('[data-testid="ansi-text"]').exists()).toBe(true)
    // 未注册的 custom：序列化 props（含 component 名与嵌套 props）
    const text = wrapper.text()
    expect(text).toContain('"component": "my-widget"')
    expect(text).toContain('"count": 3')
  })

  it('custom 类型已注册（provide registry）→ 路由到注册组件', () => {
    // 一个桩注册组件，挂 data-testid 便于断言
    const MyWidget = defineComponent({
      name: 'MyWidget',
      props: { count: { type: Number, required: false } },
      setup(props) {
        return () =>
          h('div', { 'data-testid': 'my-widget' }, `count=${props.count ?? '-'}`)
      },
    })

    const component: GuiComponent = {
      type: 'custom',
      props: { component: 'my-widget', props: { count: 3 } },
    }
    const wrapper = mount(GuiComponentRenderer, {
      props: { component },
      global: {
        provide: { 'gui-custom-registry': { 'my-widget': MyWidget } },
      },
    })

    // 路由到 MyWidget 而非 AnsiText
    expect(wrapper.find('[data-testid="my-widget"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ansi-text"]').exists()).toBe(false)
    // 注意：custom 的 props 形状是 { component, props }，注册组件收到的是整个 props 对象
    // （v-bind 直接展开 resolvedProps = component.props）
    expect(wrapper.text()).toContain('count=')
  })

  it('ansi-text 但 props 非 { lines: string[] } 形状（脏数据）→ 降级 AnsiText 序列化', () => {
    const component: GuiComponent = {
      type: 'ansi-text',
      props: { wrong: 'shape' } as unknown as GuiComponent['props'],
    }
    const wrapper = mount(GuiComponentRenderer, { props: { component } })

    // 仍渲染 AnsiText（不崩），content 序列化脏数据
    expect(wrapper.find('[data-testid="ansi-text"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('"wrong": "shape"')
  })
})
