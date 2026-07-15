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
      { label: 'deep' },
    ]
    const wrapper = mount(ListTree, { props: { items, depth: 2 } })
    const item = wrapper.find('.list-tree__item')
    expect(item.attributes('style')).toContain('padding-left: 40px')
  })

  it('递归 children 自动 depth+1 缩进（children padding > parent padding）', () => {
    const items: TreeItem[] = [
      {
        label: 'parent',
        children: [
          { label: 'child' },
        ],
      },
    ]
    const wrapper = mount(ListTree, { props: { items } })
    const allItems = wrapper.findAll('.list-tree__item')
    expect(allItems).toHaveLength(2)
    // parent 在 depth=0 → padding-left: 0px
    expect(allItems[0].attributes('style')).toContain('padding-left: 0px')
    // child 在 depth=1 → padding-left: 20px（比 parent 缩进）
    expect(allItems[1].attributes('style')).toContain('padding-left: 20px')
  })

  it('status 文本映射为中文（running→进行中, done→完成, failed→失败）', () => {
    const items: TreeItem[] = [
      { label: 'a', status: 'running' },
      { label: 'b', status: 'done' },
      { label: 'c', status: 'failed' },
    ]
    const wrapper = mount(ListTree, { props: { items } })
    const statuses = wrapper.findAll('.list-tree__status')
    expect(statuses).toHaveLength(3)
    expect(statuses[0].text()).toBe('进行中')
    expect(statuses[1].text()).toBe('完成')
    expect(statuses[2].text()).toBe('失败')
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
