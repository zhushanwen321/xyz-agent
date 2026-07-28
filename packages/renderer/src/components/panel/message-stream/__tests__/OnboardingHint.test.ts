/**
 * OnboardingHint.vue + useOnboarding.ts 组合测试。
 *
 * 覆盖（critique 第 3 轮 Nielsen 第 10 项 Help & Documentation 渐进气泡）：
 * - 首次渲染（localStorage 无 key）：气泡可见
 * - 点关闭按钮：气泡消失 + localStorage 写入 '1'
 * - 再次渲染（localStorage 有 key）：气泡不可见（dismiss 后永不再显）
 * - data-testid 正确（onboarding-{hintKey} / onboarding-{hintKey}-close）
 * - 多 key 互相独立（dismiss 一个不影响另一个）
 * - 模块级缓存一致性（dismiss 后同 key 新实例也不显）
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/message-stream/__tests__/OnboardingHint.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import OnboardingHint from '@/components/panel/message-stream/OnboardingHint.vue'
import { __resetOnboardingCacheForTest } from '@/composables/effects/useOnboarding'

/** happy-dom 提供可用 localStorage。每个 case 前清空 + 清模块缓存，确保「首次」态。 */
beforeEach(() => {
  localStorage.clear()
  __resetOnboardingCacheForTest()
})

function mountHint(hintKey = 'subagent', text = '提示文案') {
  return mount(OnboardingHint, {
    props: { hintKey, text },
  })
}

describe('OnboardingHint: 首次渲染（localStorage 无 key）', () => {
  it('气泡可见 + 渲染 text 文案', () => {
    const wrapper = mountHint('subagent', '这是子 agent 块')
    expect(wrapper.find('[data-testid="onboarding-subagent"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('这是子 agent 块')
  })

  it('data-testid 按 hintKey 拼接（workflow）', () => {
    const wrapper = mountHint('workflow')
    expect(wrapper.find('[data-testid="onboarding-workflow"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="onboarding-workflow-close"]').exists()).toBe(true)
  })

  it('关闭按钮存在（ghost X icon）', () => {
    const wrapper = mountHint('fork')
    const closeBtn = wrapper.find('[data-testid="onboarding-fork-close"]')
    expect(closeBtn.exists()).toBe(true)
    expect(closeBtn.find('svg').exists()).toBe(true) // X 图标
  })
})

describe('OnboardingHint: 点关闭按钮', () => {
  it('点击后气泡从 DOM 消失', async () => {
    const wrapper = mountHint('subagent')
    expect(wrapper.find('[data-testid="onboarding-subagent"]').exists()).toBe(true)
    await wrapper.find('[data-testid="onboarding-subagent-close"]').trigger('click')
    expect(wrapper.find('[data-testid="onboarding-subagent"]').exists()).toBe(false)
  })

  it('点击后 localStorage 写入 xyz-onboarding-{key}=1', async () => {
    const wrapper = mountHint('subagent')
    await wrapper.find('[data-testid="onboarding-subagent-close"]').trigger('click')
    expect(localStorage.getItem('xyz-onboarding-subagent')).toBe('1')
  })
})

describe('OnboardingHint: dismiss 后永不再显', () => {
  it('localStorage 已有 key 时新实例不渲染气泡', () => {
    localStorage.setItem('xyz-onboarding-workflow', '1')
    const wrapper = mountHint('workflow')
    expect(wrapper.find('[data-testid="onboarding-workflow"]').exists()).toBe(false)
  })

  it('同 key dismiss 后挂载新实例也不显（模块级缓存一致性）', async () => {
    const wrapper1 = mountHint('fork')
    await wrapper1.find('[data-testid="onboarding-fork-close"]').trigger('click')
    expect(wrapper1.find('[data-testid="onboarding-fork"]').exists()).toBe(false)
    // 新实例：useOnboarding 读模块级缓存（已 dismissed）→ visible=false
    const wrapper2 = mountHint('fork')
    expect(wrapper2.find('[data-testid="onboarding-fork"]').exists()).toBe(false)
  })
})

describe('OnboardingHint: 多 key 互相独立', () => {
  it('dismiss subagent 不影响 workflow / fork', async () => {
    const subWrapper = mountHint('subagent')
    await subWrapper.find('[data-testid="onboarding-subagent-close"]').trigger('click')

    const wfWrapper = mountHint('workflow')
    const forkWrapper = mountHint('fork')
    expect(wfWrapper.find('[data-testid="onboarding-workflow"]').exists()).toBe(true)
    expect(forkWrapper.find('[data-testid="onboarding-fork"]').exists()).toBe(true)
    // localStorage 只写了 subagent 的 key
    expect(localStorage.getItem('xyz-onboarding-subagent')).toBe('1')
    expect(localStorage.getItem('xyz-onboarding-workflow')).toBeNull()
    expect(localStorage.getItem('xyz-onboarding-fork')).toBeNull()
  })
})
