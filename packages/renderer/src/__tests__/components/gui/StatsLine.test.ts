/**
 * StatsLine 组件测试（W1 · U2）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/gui/StatsLine.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import StatsLine from '@/components/panel/message-stream/gui/StatsLine.vue'

describe('StatsLine', () => {
  it('渲染多个 item，值按 severity 着色', () => {
    const wrapper = mount(StatsLine, {
      props: {
        items: [
          { label: 'changes', value: '+142', severity: 'ok' },
          { label: 'warns', value: '3', severity: 'warn' },
          { label: 'fails', value: '1', severity: 'danger' },
        ],
      },
    })
    expect(wrapper.find('[data-testid="gui-stats-line"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('+142')
    expect(wrapper.text()).toContain('3')
    expect(wrapper.text()).toContain('1')
    // 值分别着色
    const values = wrapper.findAll('.stats-line__value')
    expect(values).toHaveLength(3)
    expect(values[0].classes()).toContain('text-success')
    expect(values[1].classes()).toContain('text-warning')
    expect(values[2].classes()).toContain('text-danger')
  })

  it('item 间用 border-l 分隔（首项无分隔线）', () => {
    const wrapper = mount(StatsLine, {
      props: { items: [{ value: 'a' }, { value: 'b' }, { value: 'c' }] },
    })
    const items = wrapper.findAll('.stats-line__item')
    expect(items).toHaveLength(3)
    // 首项无左边框
    expect(items[0].classes()).not.toContain('border-l')
    // 后续项有左边框
    expect(items[1].classes()).toContain('border-l')
    expect(items[2].classes()).toContain('border-l')
  })

  it('label 可选，无 label 时只渲染 value', () => {
    const wrapper = mount(StatsLine, {
      props: { items: [{ value: '42' }] },
    })
    expect(wrapper.text()).toContain('42')
    expect(wrapper.find('.stats-line__label').exists()).toBe(false)
  })
})
