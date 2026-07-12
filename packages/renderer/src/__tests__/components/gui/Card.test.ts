/**
 * Card 组件测试（W2 · U4）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/gui/Card.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Card from '@/components/panel/message-stream/gui/Card.vue'
import type { GuiComponent } from '@xyz-agent/extension-protocol'

describe('Card', () => {
  it('header=string + body 嵌套 stats-line 子组件（variant=elevated）', () => {
    const body: GuiComponent[] = [
      { type: 'stats-line', props: { items: [{ value: '15' }] } },
    ]
    const wrapper = mount(Card, {
      props: { variant: 'elevated', header: 'CI Pipeline', body },
    })
    expect(wrapper.find('[data-testid="gui-card"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('CI Pipeline')
    // body 内嵌 GuiComponentRenderer 渲染出 stats-line
    expect(wrapper.find('[data-testid="gui-stats-line"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('15')
    // elevated variant → border-strong
    expect(wrapper.find('[data-testid="gui-card"]').classes()).toContain('border-border-strong')
  })

  it('variant=danger → danger 边框色', () => {
    const wrapper = mount(Card, {
      props: { variant: 'danger', body: [] },
    })
    const card = wrapper.find('[data-testid="gui-card"]')
    expect(card.classes()).toContain('border-danger')
  })

  it('variant=success → success 边框色', () => {
    const wrapper = mount(Card, {
      props: { variant: 'success', body: [] },
    })
    const card = wrapper.find('[data-testid="gui-card"]')
    expect(card.classes()).toContain('border-success')
  })

  it('variant 未传 → default（border-border）', () => {
    const wrapper = mount(Card, {
      props: { body: [] },
    })
    const card = wrapper.find('[data-testid="gui-card"]')
    expect(card.classes()).toContain('border-border')
  })

  it('header 为 GuiComponent 时递归渲染', () => {
    const headerComp: GuiComponent = {
      type: 'stats-line',
      props: { items: [{ label: 'x', value: '42' }] },
    }
    const wrapper = mount(Card, {
      props: { header: headerComp, body: [] },
    })
    expect(wrapper.find('[data-testid="gui-stats-line"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('42')
  })
})
