/**
 * SegmentedTab 组件测试。
 *
 * 覆盖：
 * - 渲染 3 个 tab（sessions/files/subagents）
 * - subagents tab 含 Bot icon + count
 * - icon-only 模式（label 收进 title）
 * - active 态切换
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/SegmentedTab.spec.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SegmentedTab from '@/components/sidebar/SegmentedTab.vue'
import type { SidebarTab } from '@/stores/sidebar'

describe('SegmentedTab', () => {
  it('渲染 4 个 tab（sessions/files/subagents/workflows）', () => {
    const wrapper = mount(SegmentedTab, {
      props: {
        modelValue: 'sessions' as SidebarTab,
        sessionCount: 6,
        fileCount: 4,
        subagentCount: 2,
        workflowCount: 0,
      },
    })

    const buttons = wrapper.findAll('button')
    expect(buttons).toHaveLength(4)

    // tab title 含 label
    expect(buttons[0].attributes('title')).toBe('会话')
    expect(buttons[1].attributes('title')).toBe('文件')
    expect(buttons[2].attributes('title')).toBe('Agents')
    expect(buttons[3].attributes('title')).toBe('Flows')
  })

  it('subagents tab 含 count 数字', () => {
    const wrapper = mount(SegmentedTab, {
      props: {
        modelValue: 'subagents' as SidebarTab,
        sessionCount: 6,
        fileCount: 4,
        subagentCount: 2,
        workflowCount: 0,
      },
    })

    const buttons = wrapper.findAll('button')
    // 第三个 tab（subagents）的 count 文本含 '2'
    const subagentBtn = buttons[2]
    expect(subagentBtn.text()).toContain('2')
  })

  it('subagents count > 0 时显示 badge dot', () => {
    const wrapper = mount(SegmentedTab, {
      props: {
        modelValue: 'sessions' as SidebarTab,
        sessionCount: 6,
        fileCount: 4,
        subagentCount: 3,
        workflowCount: 0,
      },
    })

    const buttons = wrapper.findAll('button')
    const subagentBtn = buttons[2]
    // badge dot 是 absolute 定位的 span
    const badge = subagentBtn.find('.absolute.right-1.top-1')
    expect(badge.exists()).toBe(true)
  })

  it('subagents count = 0 时不显示 badge dot', () => {
    const wrapper = mount(SegmentedTab, {
      props: {
        modelValue: 'sessions' as SidebarTab,
        sessionCount: 6,
        fileCount: 4,
        subagentCount: 0,
        workflowCount: 0,
      },
    })

    const buttons = wrapper.findAll('button')
    const subagentBtn = buttons[2]
    const badge = subagentBtn.find('.absolute.right-1.top-1')
    expect(badge.exists()).toBe(false)
  })

  it('点击 tab 触发 update:modelValue', async () => {
    const wrapper = mount(SegmentedTab, {
      props: {
        modelValue: 'sessions' as SidebarTab,
        sessionCount: 6,
        fileCount: 4,
        subagentCount: 2,
        workflowCount: 0,
      },
    })

    const buttons = wrapper.findAll('button')
    await buttons[2].trigger('click')

    const emitted = wrapper.emitted('update:modelValue')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toBe('subagents')
  })
})
