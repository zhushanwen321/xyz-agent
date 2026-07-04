/**
 * ProgressZone 组件单测 —— 演示组件不直 import mock 数据（#fix 假数据 ②）。
 *
 * 覆盖：
 * - 无真实进度数据时组件不渲染（v-if="state" 自隐藏）
 * - 即使误传 phase（如 Panel 仍传 running）也不渲染假任务
 * - 不显示 mock 假任务（标题「重构 auth 模块」/ 步骤「第 3/5 步」/ 假 todos）
 *
 * 修复后组件不再 import @/api/mock/composer-data；真实数据源（runtime Flow3 任务状态）
 * 未接入前 state 恒为 null → v-if="state" 不渲染。
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/panel/progress-zone.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ProgressZone from '@/components/panel/ProgressZone.vue'

describe('ProgressZone', () => {
  it('不传 phase 时不渲染（无真实进度数据自隐藏）', () => {
    const wrapper = mount(ProgressZone)
    expect(wrapper.text()).toBe('')
    expect(wrapper.text()).not.toContain('重构 auth 模块')
  })

  it('即使误传 phase=running 也不渲染假任务（state 恒 null）', () => {
    const wrapper = mount(ProgressZone, { props: { phase: 'running' } })
    expect(wrapper.text()).toBe('')
    expect(wrapper.text()).not.toContain('第 3/5 步')
    expect(wrapper.text()).not.toContain('抽离 UserRepository')
  })
})
