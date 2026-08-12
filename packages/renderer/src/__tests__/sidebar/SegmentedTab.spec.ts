/**
 * SegmentedTab 组件测试。
 *
 * 覆盖：
 * - 渲染 3 个 tab（sessions/files/subagents）
 * - subagents tab 含 Bot icon
 * - icon-only 模式（label 收进 title）
 * - active 态切换
 * - badge 精确化：仅 subagentRunningCount/workflowRunningCount > 0 亮蓝点（count 数字 props 已随组件删除）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/SegmentedTab.spec.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SegmentedTab from '@/components/sidebar/SegmentedTab.vue'
import type { SidebarTab } from '@/stores/sidebar'

describe('SegmentedTab', () => {
  it('渲染 5 个 tab（sessions/files/subagents/workflows/plugins）', () => {
    const wrapper = mount(SegmentedTab, {
      props: {
        modelValue: 'sessions' as SidebarTab,
      },
    })

    const buttons = wrapper.findAll('button')
    expect(buttons).toHaveLength(5)

    // tab title 含 label（i18n 中文：与组件 t('sidebar.segmentedTab.*') 输出对齐）
    expect(buttons[0].attributes('title')).toBe('会话')
    expect(buttons[1].attributes('title')).toBe('文件')
    expect(buttons[2].attributes('title')).toBe('子代理')
    expect(buttons[3].attributes('title')).toBe('工作流')
    expect(buttons[4].attributes('title')).toBe('插件')
  })

  it('count 数字不再渲染（克制原则：对切换决策无用、制造视觉噪音）', () => {
    const wrapper = mount(SegmentedTab, {
      props: {
        modelValue: 'subagents' as SidebarTab,
      },
    })

    const buttons = wrapper.findAll('button')
    // count span 已删：所有 tab 按钮都不渲染 count 数字（此前 subagents 按钮 text 含 '2'）
    for (const btn of buttons) {
      expect(btn.text()).not.toContain('2')
      expect(btn.text()).not.toContain('6')
    }
  })

  it('subagents count > 0 时显示 badge dot（带 pulse 动画）', () => {
    const wrapper = mount(SegmentedTab, {
      props: {
        modelValue: 'sessions' as SidebarTab,
        // badge 精确化：仅 running 态 > 0 亮蓝点（组件 badge = subagentRunningCount > 0）
        subagentRunningCount: 1,
        workflowRunningCount: 0,
      },
    })

    const buttons = wrapper.findAll('button')
    const subagentBtn = buttons[2]
    // badge dot 是 absolute 定位的 span（组件 class: absolute right-1 top-1）
    const badge = subagentBtn.find('.absolute.right-1.top-1')
    expect(badge.exists()).toBe(true)
    // 静态 badge：plan 04 已删 pulse 动画（keyframes pulse-dot 仍在 style.css 供 SystemShortcutSection 使用）
    expect(badge.classes()).not.toContain('animate-[pulse-dot_1.8s_ease-in-out_infinite]')
    expect(badge.classes()).not.toContain('motion-reduce:animate-none')
  })

  it('subagents count = 0 时不显示 badge dot', () => {
    const wrapper = mount(SegmentedTab, {
      props: {
        modelValue: 'sessions' as SidebarTab,
        subagentRunningCount: 0,
        workflowRunningCount: 0,
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
      },
    })

    const buttons = wrapper.findAll('button')
    await buttons[2].trigger('click')

    const emitted = wrapper.emitted('update:modelValue')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toBe('subagents')
  })
})
