/**
 * ProviderTestDiscoverSection 组件测试（D-1 从 ProviderEditBody 抽出的纯展示块）。
 *
 * 组件契约：零内部状态——testing/discovering/testResult/discoverResult/modelCount 全部
 * props 注入，@test/@discover 事件上抛由父组件（useProviderEdit）编排。测试锁：
 * - 按钮点击上抛 test / discover
 * - testing / discovering 进行中 → 按钮互斥 disabled（防重复点击）
 * - testResult ok/error 渲染成功/失败反馈行；discoverResult 渲染结果文案
 *
 * 测试框架：vitest。i18n 经 ui vitest.setup mock（t 返回 key），断言用 key。
 * 运行：cd packages/ui && npx vitest run src/features/settings/__tests__/provider-test-discover-section.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ProviderTestDiscoverSection from '../provider/ProviderTestDiscoverSection.vue'

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

function mountSection(props: Record<string, unknown> = {}): ReturnType<typeof mount> {
  return mount(ProviderTestDiscoverSection, {
    props: {
      testing: false,
      discovering: false,
      testResult: null,
      discoverResult: '',
      modelCount: 0,
      ...props,
    },
    attachTo: document.body,
  })
}

describe('按钮事件上抛（纯展示 + 零内部状态）', () => {
  it('点击「测试连接」上抛 test、点击「自动发现」上抛 discover', async () => {
    wrapper = mountSection()
    await flushPromises()

    const buttons = wrapper.findAll('button')
    const testBtn = buttons.find((b) => b.text().includes('settings.providerEdit.testConnection'))
    const discoverBtn = buttons.find((b) => b.text().includes('settings.providerEdit.autoDiscover'))
    expect(testBtn).toBeTruthy()
    expect(discoverBtn).toBeTruthy()

    await testBtn!.trigger('click')
    expect(wrapper.emitted('test')).toHaveLength(1)

    await discoverBtn!.trigger('click')
    expect(wrapper.emitted('discover')).toHaveLength(1)
  })

  it('testing=true → 两按钮 disabled（进行中防重复点击）', async () => {
    wrapper = mountSection({ testing: true })
    await flushPromises()

    const buttons = wrapper.findAll('button')
    expect(buttons.every((b) => b.attributes('disabled') !== undefined)).toBe(true)
    await buttons[0]!.trigger('click')
    expect(wrapper.emitted('test')).toBeUndefined()
  })

  it('discovering=true → 同样互斥 disabled', async () => {
    wrapper = mountSection({ discovering: true })
    await flushPromises()
    expect(wrapper.findAll('button').every((b) => b.attributes('disabled') !== undefined)).toBe(true)
  })
})

describe('结果反馈行', () => {
  it('testResult=ok → 成功反馈行（testOk key + 成功色）', async () => {
    wrapper = mountSection({ testResult: 'ok', modelCount: 3 })
    await flushPromises()
    expect(wrapper.text()).toContain('settings.providerEdit.testOk')
  })

  it('testResult=error → 失败反馈行（testFail key）', async () => {
    wrapper = mountSection({ testResult: 'error' })
    await flushPromises()
    expect(wrapper.text()).toContain('settings.providerEdit.testFail')
  })

  it('testResult=null → 不渲染反馈行；discoverResult 非空 → 渲染结果文案', async () => {
    wrapper = mountSection({ discoverResult: '发现 5 个模型' })
    await flushPromises()
    expect(wrapper.text()).not.toContain('settings.providerEdit.testOk')
    expect(wrapper.text()).not.toContain('settings.providerEdit.testFail')
    expect(wrapper.text()).toContain('发现 5 个模型')
  })
})
