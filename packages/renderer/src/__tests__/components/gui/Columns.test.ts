/**
 * Columns 组件测试（W2 · U5）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/gui/Columns.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Columns from '@/components/panel/message-stream/gui/Columns.vue'
import type { GuiComponent } from '@xyz-agent/extension-protocol'

describe('Columns', () => {
  it('ratios=[2,1] 时子区域 flex-grow 分别为 2 和 1', () => {
    const children: GuiComponent[] = [
      { type: 'ansi-text', props: { lines: ['left'] } },
      { type: 'ansi-text', props: { lines: ['right'] } },
    ]
    const wrapper = mount(Columns, {
      props: { children, ratios: [2, 1] },
    })
    expect(wrapper.find('[data-testid="gui-columns"]').exists()).toBe(true)
    const kids = wrapper.findAll('.columns__child')
    expect(kids).toHaveLength(2)
    expect(kids[0].attributes('style')).toContain('flex-grow: 2')
    expect(kids[1].attributes('style')).toContain('flex-grow: 1')
    // 子组件通过 GuiComponentRenderer 渲染
    expect(wrapper.text()).toContain('left')
    expect(wrapper.text()).toContain('right')
  })

  it('ratios 未传时等分（flex-grow: 1）', () => {
    const children: GuiComponent[] = [
      { type: 'ansi-text', props: { lines: ['a'] } },
      { type: 'ansi-text', props: { lines: ['b'] } },
      { type: 'ansi-text', props: { lines: ['c'] } },
    ]
    const wrapper = mount(Columns, {
      props: { children },
    })
    const kids = wrapper.findAll('.columns__child')
    expect(kids).toHaveLength(3)
    for (const k of kids) {
      expect(k.attributes('style')).toContain('flex-grow: 1')
    }
  })

  it('空 children 不崩', () => {
    const wrapper = mount(Columns, {
      props: { children: [] },
    })
    expect(wrapper.find('[data-testid="gui-columns"]').exists()).toBe(true)
  })
})
