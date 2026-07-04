/**
 * ContextChipsBar 组件单测 —— 演示组件不直 import mock 数据（#fix 假数据 ①）。
 *
 * 覆盖：
 * - 无真实数据源时整行 v-if 自隐藏（不渲染任何 chip，含外层容器）
 * - 不显示 mock 假上下文条目（AuthService.ts / token.ts / login-flow.png）
 *
 * 修复后组件不再 import @/api/mock/composer-data；真实数据源（runtime 已附上下文推送）
 * 未接入前 items 恒为空数组 → 整行 v-if="items.length" 不渲染。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/panel/context-chips-bar.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ContextChipsBar from '@/components/panel/ContextChipsBar.vue'

describe('ContextChipsBar', () => {
  it('无真实数据源时整行不渲染（不显示 mock 假上下文 chip）', () => {
    const wrapper = mount(ContextChipsBar)
    expect(wrapper.text()).toBe('')
    // 假数据名绝不出现在 DOM
    expect(wrapper.text()).not.toContain('AuthService.ts')
    expect(wrapper.text()).not.toContain('login-flow.png')
    // 外层容器也不渲染（v-if 自隐藏，非空 div）
    expect(wrapper.find('div.flex-wrap').exists()).toBe(false)
  })
})
