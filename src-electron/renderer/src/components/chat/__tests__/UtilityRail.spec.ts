import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import UtilityRail from '../UtilityRail.vue'

// Mock lucide-vue-next icons
vi.mock('lucide-vue-next', () => ({
  ChevronUp: { template: '<svg data-testid="chevron-up" />' },
  ChevronDown: { template: '<svg data-testid="chevron-down" />' },
}))

function mountRail(props: { showScrollTop?: boolean; showScrollBottom?: boolean } = {}) {
  return mount(UtilityRail, {
    props: {
      showScrollTop: props.showScrollTop ?? false,
      showScrollBottom: props.showScrollBottom ?? false,
    },
  })
}

describe('UtilityRail', () => {
  it('renders both buttons when both scroll directions are available', () => {
    const wrapper = mountRail({ showScrollTop: true, showScrollBottom: true })
    expect(wrapper.find('[data-testid="chevron-up"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="chevron-down"]').exists()).toBe(true)
  })

  it('hides scroll-top button when at top', () => {
    const wrapper = mountRail({ showScrollTop: false, showScrollBottom: true })
    expect(wrapper.find('[data-testid="chevron-up"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="chevron-down"]').exists()).toBe(true)
  })

  it('hides scroll-bottom button when at bottom', () => {
    const wrapper = mountRail({ showScrollTop: true, showScrollBottom: false })
    expect(wrapper.find('[data-testid="chevron-up"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="chevron-down"]').exists()).toBe(false)
  })

  it('hides both buttons when fully visible (no scroll needed)', () => {
    const wrapper = mountRail({ showScrollTop: false, showScrollBottom: false })
    expect(wrapper.find('[data-testid="chevron-up"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="chevron-down"]').exists()).toBe(false)
  })

  it('emits scroll-to-top when top button is clicked', async () => {
    const wrapper = mountRail({ showScrollTop: true, showScrollBottom: false })
    await wrapper.find('button[aria-label="回到顶端"]').trigger('click')
    expect(wrapper.emitted('scroll-to-top')).toHaveLength(1)
  })

  it('emits scroll-to-bottom when bottom button is clicked', async () => {
    const wrapper = mountRail({ showScrollTop: false, showScrollBottom: true })
    await wrapper.find('button[aria-label="回到底部"]').trigger('click')
    expect(wrapper.emitted('scroll-to-bottom')).toHaveLength(1)
  })

  it('has utility-rail base class', () => {
    const wrapper = mountRail()
    const rail = wrapper.find('div')
    expect(rail.classes()).toContain('utility-rail')
  })

  it('has pointer-events-none for rail container', () => {
    const wrapper = mountRail()
    const rail = wrapper.find('div')
    expect(rail.classes()).toContain('pointer-events-none')
  })
})
