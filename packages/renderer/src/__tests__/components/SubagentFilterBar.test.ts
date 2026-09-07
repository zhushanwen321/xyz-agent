/**
 * SubagentFilterBar 组件测试（三视角，TEST-STRATEGY §3）。
 *
 * 覆盖（设计 docs/design/subagent-sidebar-filter.md §3.4 / impl-plan u-filterbar）：
 * - 渲染（构建者白盒）：三桶 testid 齐全、计数渲染 counts 载荷、选中桶高亮
 *   （bg-bg-elevated + data-active="true"）、未选中 data-active="false"
 * - 黑盒（使用者）：点击桶按钮 → emit update:modelValue 载荷为桶 id
 * - 形态（观察者）：计数 testid 存在且文本含数字、三桶中文文案（i18n zh-CN）
 *
 * 纯展示组件：v-model 受控，高亮随 modelValue props 移动（含受控切换用例）。
 *
 * 运行：cd packages/renderer && pnpm test src/__tests__/components/SubagentFilterBar.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SubagentFilterBar from '@/components/sidebar/SubagentFilterBar.vue'
import type { SubagentFilterValue } from '@/lib/subagent-bucket'

const COUNTS = { active: 2, ended: 6, all: 8 }

function mountBar(modelValue: SubagentFilterValue = 'active') {
  return mount(SubagentFilterBar, {
    props: { counts: COUNTS, modelValue },
  })
}

describe('SubagentFilterBar 渲染（白盒：计数 + 选中高亮）', () => {
  it('渲染三个筛选按钮（active / ended / all testid 齐全）', () => {
    const wrapper = mountBar()
    for (const id of ['active', 'ended', 'all'] as const) {
      expect(wrapper.find(`[data-testid="subagent-filter-${id}"]`).exists()).toBe(true)
    }
  })

  it('计数文案渲染 counts 载荷（active 2 / ended 6 / all 8）', () => {
    const wrapper = mountBar()
    expect(wrapper.find('[data-testid="subagent-filter-count-active"]').text()).toBe('2')
    expect(wrapper.find('[data-testid="subagent-filter-count-ended"]').text()).toBe('6')
    expect(wrapper.find('[data-testid="subagent-filter-count-all"]').text()).toBe('8')
  })

  it('选中桶含 bg-bg-elevated 浮起 class 且 data-active="true"', () => {
    const wrapper = mountBar('active')
    const activeBtn = wrapper.find('[data-testid="subagent-filter-active"]')
    expect(activeBtn.classes()).toContain('bg-bg-elevated')
    expect(activeBtn.attributes('data-active')).toBe('true')
  })

  it('未选中桶 data-active="false" 且无 bg-bg-elevated', () => {
    const wrapper = mountBar('active')
    for (const id of ['ended', 'all'] as const) {
      const btn = wrapper.find(`[data-testid="subagent-filter-${id}"]`)
      expect(btn.attributes('data-active')).toBe('false')
      expect(btn.classes()).not.toContain('bg-bg-elevated')
    }
  })

  it('modelValue 切到 ended 时高亮随 props 移动（纯受控组件，无内部状态）', () => {
    const wrapper = mountBar('ended')
    expect(wrapper.find('[data-testid="subagent-filter-ended"]').classes()).toContain('bg-bg-elevated')
    expect(wrapper.find('[data-testid="subagent-filter-active"]').classes()).not.toContain('bg-bg-elevated')
    expect(wrapper.find('[data-testid="subagent-filter-ended"]').attributes('data-active')).toBe('true')
  })
})

describe('SubagentFilterBar 黑盒（点击上抛 update:modelValue）', () => {
  it('点击「已结束」按钮 emit update:modelValue 载荷 ["ended"]', async () => {
    const wrapper = mountBar()
    await wrapper.find('[data-testid="subagent-filter-ended"]').trigger('click')
    const emitted = wrapper.emitted('update:modelValue')
    expect(emitted).toBeTruthy()
    expect(emitted![0]).toEqual(['ended'])
  })

  it('点击「全部」按钮 emit update:modelValue 载荷 ["all"]', async () => {
    const wrapper = mountBar()
    await wrapper.find('[data-testid="subagent-filter-all"]').trigger('click')
    const emitted = wrapper.emitted('update:modelValue')
    expect(emitted).toBeTruthy()
    expect(emitted![0]).toEqual(['all'])
  })

  it('点击「进行中」按钮 emit update:modelValue 载荷 ["active"]（从其他桶切回）', async () => {
    const wrapper = mountBar('ended')
    await wrapper.find('[data-testid="subagent-filter-active"]').trigger('click')
    const emitted = wrapper.emitted('update:modelValue')
    expect(emitted).toBeTruthy()
    expect(emitted![0]).toEqual(['active'])
  })
})

describe('SubagentFilterBar 形态（观察者：文案 + 计数可见）', () => {
  it('三桶文案为「进行中 / 已结束 / 全部」（zh-CN i18n，逐桶断言防串扰）', () => {
    const wrapper = mountBar()
    expect(wrapper.find('[data-testid="subagent-filter-active"]').text()).toContain('进行中')
    expect(wrapper.find('[data-testid="subagent-filter-ended"]').text()).toContain('已结束')
    expect(wrapper.find('[data-testid="subagent-filter-all"]').text()).toContain('全部')
  })

  it('计数元素三桶齐全且文本含数字（数量预告 G3 用户可见）', () => {
    const wrapper = mountBar()
    const expectations: ReadonlyArray<[SubagentFilterValue, string]> = [
      ['active', '2'],
      ['ended', '6'],
      ['all', '8'],
    ]
    for (const [id, count] of expectations) {
      const el = wrapper.find(`[data-testid="subagent-filter-count-${id}"]`)
      expect(el.exists()).toBe(true)
      expect(el.text()).toContain(count)
    }
  })
})
