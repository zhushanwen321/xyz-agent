/**
 * ProgressBar 组件测试（W1 · U1）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/gui/ProgressBar.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ProgressBar from '@/components/panel/message-stream/gui/ProgressBar.vue'

describe('ProgressBar', () => {
  it('severity=ok 时 fill 着色 success，按比例填充 width', () => {
    const wrapper = mount(ProgressBar, {
      props: { label: 'build', current: 7, total: 8, severity: 'ok' },
    })
    expect(wrapper.find('[data-testid="gui-progress-bar"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('build')
    expect(wrapper.text()).toContain('7')
    expect(wrapper.text()).toContain('8')
    const fill = wrapper.find('.progress-bar__fill')
    expect(fill.exists()).toBe(true)
    expect(fill.classes()).toContain('bg-success')
    // 7/8 = 87.5%
    expect(fill.attributes('style')).toContain('width: 87.5%')
  })

  it('severity=warn → bg-warning，severity=danger → bg-danger', () => {
    const w1 = mount(ProgressBar, { props: { current: 3, total: 4, severity: 'warn' } })
    expect(w1.find('.progress-bar__fill').classes()).toContain('bg-warning')

    const w2 = mount(ProgressBar, { props: { current: 1, total: 4, severity: 'danger' } })
    expect(w2.find('.progress-bar__fill').classes()).toContain('bg-danger')
  })

  it('severity 未传时按比例自动推断 (>=0.8 ok, >=0.5 warn, <0.5 danger)', () => {
    const ok = mount(ProgressBar, { props: { current: 9, total: 10 } })
    expect(ok.find('.progress-bar__fill').classes()).toContain('bg-success')

    const warn = mount(ProgressBar, { props: { current: 6, total: 10 } })
    expect(warn.find('.progress-bar__fill').classes()).toContain('bg-warning')

    const danger = mount(ProgressBar, { props: { current: 3, total: 10 } })
    expect(danger.find('.progress-bar__fill').classes()).toContain('bg-danger')
  })

  it('total=0 时不崩，width=0%', () => {
    const wrapper = mount(ProgressBar, { props: { current: 0, total: 0 } })
    expect(wrapper.find('[data-testid="gui-progress-bar"]').exists()).toBe(true)
    expect(wrapper.find('.progress-bar__fill').attributes('style')).toContain('width: 0.0%')
  })

  it('current > total 时不崩（溢出场景）', () => {
    const wrapper = mount(ProgressBar, { props: { current: 10, total: 8 } })
    expect(wrapper.find('[data-testid="gui-progress-bar"]').exists()).toBe(true)
    // 10/8 = 125%，fill width 超过 100%（track overflow-hidden 裁剪视觉溢出，但不崩渲染）
    expect(wrapper.find('.progress-bar__fill').attributes('style')).toContain('width: 125.0%')
  })
})
