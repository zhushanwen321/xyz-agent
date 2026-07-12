/**
 * TabBar 组件测试（W1 · U3）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/gui/TabBar.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import TabBar from '@/components/panel/message-stream/gui/TabBar.vue'

describe('TabBar', () => {
  it('渲染 active + done + pending 三态', () => {
    const wrapper = mount(TabBar, {
      props: {
        tabs: [
          { label: 'node20', active: true },
          { label: 'node22', status: 'done' },
          { label: 'bun', status: 'pending' },
        ],
      },
    })
    expect(wrapper.find('[data-testid="gui-tab-bar"]').exists()).toBe(true)
    const tabs = wrapper.findAll('.tab-bar__tab')
    expect(tabs).toHaveLength(3)

    // active tab 有 accent-soft 背景
    expect(tabs[0].classes()).toContain('bg-accent-soft')
    // done tab 有绿点
    expect(tabs[1].find('.tab-bar__dot').classes()).toContain('bg-success')
    // pending tab 有灰点
    expect(tabs[2].find('.tab-bar__dot').classes()).toContain('bg-subtle')
  })

  it('无 active 无 status 的 tab 只渲染 label 文本', () => {
    const wrapper = mount(TabBar, {
      props: { tabs: [{ label: 'plain' }] },
    })
    expect(wrapper.text()).toContain('plain')
    expect(wrapper.find('.tab-bar__dot').exists()).toBe(false)
  })
})
