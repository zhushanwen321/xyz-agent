/**
 * ListTree 组件测试（W3 · U6）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/gui/ListTree.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ListTree from '@/components/panel/message-stream/gui/ListTree.vue'
import type { TreeItem } from '@xyz-agent/extension-protocol'

describe('ListTree', () => {
  it('递归渲染：parent 含嵌套 children + status', () => {
    const items: TreeItem[] = [
      {
        label: 'parent',
        icon: 'arrow',
        children: [
          { label: 'child1', status: 'done' },
          { label: 'child2', status: 'running' },
        ],
      },
    ]
    const wrapper = mount(ListTree, { props: { items } })
    expect(wrapper.find('[data-testid="gui-list-tree"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('parent')
    expect(wrapper.text()).toContain('child1')
    expect(wrapper.text()).toContain('child2')
    // done 着色 success，running 着色 accent
    const statuses = wrapper.findAll('.list-tree__status')
    expect(statuses).toHaveLength(2)
    expect(statuses[0].classes()).toContain('text-success')
    expect(statuses[1].classes()).toContain('text-accent')
  })

  it('failed status 着色 danger', () => {
    const items: TreeItem[] = [
      { label: 'failed-item', status: 'failed' },
    ]
    const wrapper = mount(ListTree, { props: { items } })
    expect(wrapper.find('.list-tree__status').classes()).toContain('text-danger')
  })

  it('depth 缩进：depth=2 时 padding-left=40px', () => {
    const items: TreeItem[] = [
      { label: 'deep', depth: 2 },
    ]
    const wrapper = mount(ListTree, { props: { items } })
    const item = wrapper.find('.list-tree__item')
    expect(item.attributes('style')).toContain('padding-left: 40px')
  })

  it('icon=check 渲染对应图标', () => {
    const items: TreeItem[] = [
      { label: 'checked', icon: 'check' },
    ]
    const wrapper = mount(ListTree, { props: { items } })
    // check icon 用 lucide Check 组件（svg）
    expect(wrapper.find('.list-tree__icon svg').exists()).toBe(true)
  })

  it('空 items 不崩', () => {
    const wrapper = mount(ListTree, { props: { items: [] } })
    expect(wrapper.find('[data-testid="gui-list-tree"]').exists()).toBe(true)
  })
})
