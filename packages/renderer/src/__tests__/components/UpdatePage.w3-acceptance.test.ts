/**
 * W3 验收测试 - UpdatePage 组件
 *
 * 覆盖验收场景：
 * - W3-A6-update-page-two-line-vitest: 测试结果两行渲染（message + suggestion）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/UpdatePage.w3-acceptance.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

// __APP_VERSION__ 是 vite define 注入的全局常量，vitest 下不存在，stub 之
vi.stubGlobal('__APP_VERSION__', '0.9.7')

// Mock ipc
const testProxyMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/ipc', () => ({
  getProxyConfig: vi.fn(() => Promise.resolve({ mode: 'manual', httpProxy: 'http://192.168.1.202:7890' })),
  setProxyConfig: vi.fn(() => Promise.resolve()),
  testProxy: testProxyMock,
  getUpdateSettings: vi.fn(() => Promise.resolve({ preDownload: false, autoUpdate: false })),
  setUpdateSettings: vi.fn(() => Promise.resolve({ success: true })),
}))

// Mock settings domain
vi.mock('@/api/domains/settings', () => ({
  getProxyConfig: vi.fn(() => Promise.resolve({ mode: 'manual', httpProxy: 'http://192.168.1.202:7890' })),
  setProxyConfig: vi.fn(() => Promise.resolve()),
  testProxy: testProxyMock,
  getUpdateSettings: vi.fn(() => Promise.resolve({ preDownload: false, autoUpdate: false })),
  setUpdateSettings: vi.fn(() => Promise.resolve({ success: true })),
}))

// Mock useToast
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({
    info: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  }),
}))

// Mock UpdateCheckCard
vi.mock('@/components/settings/UpdateCheckCard.vue', () => ({
  default: {
    name: 'UpdateCheckCard',
    template: '<div data-testid="update-check-card">UpdateCheckCard Mock</div>',
  },
}))

import UpdatePage from '@/components/settings/update/UpdatePage.vue'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('W3-A6-update-page-two-line-vitest', () => {
  it('W3-A6-update-page-two-line-vitest: 测试失败时显示两行（message + suggestion）', async () => {
    // Mock testProxy 返回失败结果（带 suggestion）
    testProxyMock.mockResolvedValue({
      success: false,
      message: '无法连接代理 (EHOSTUNREACH)',
      suggestion: 'macOS 未授予「本地网络」权限。恢复指引：系统设置 → 隐私与安全性 → 本地网络',
    })

    const wrapper = mount(UpdatePage)
    await flushPromises()

    // 点击测试代理按钮
    const testButton = wrapper.find('[data-testid="btn-test-proxy"]')
    expect(testButton.exists()).toBe(true)
    await testButton.trigger('click')
    await flushPromises()

    // 验证测试结果显示两行
    const result = wrapper.find('[data-testid="test-proxy-result"]')
    expect(result.exists()).toBe(true)

    const text = result.text()
    // 第一行：错误摘要
    expect(text).toContain('代理连接失败: 无法连接代理 (EHOSTUNREACH)')
    // 第二行：恢复指引
    expect(text).toContain('macOS 未授予「本地网络」权限')
  })

  it('W3-A6-update-page-two-line-vitest: 测试成功时只显示成功消息', async () => {
    // Mock testProxy 返回成功结果
    testProxyMock.mockResolvedValue({
      success: true,
    })

    const wrapper = mount(UpdatePage)
    await flushPromises()

    const testButton = wrapper.find('[data-testid="btn-test-proxy"]')
    await testButton.trigger('click')
    await flushPromises()

    const result = wrapper.find('[data-testid="test-proxy-result"]')
    expect(result.exists()).toBe(true)
    expect(result.text()).toContain('代理连接成功')
    // 成功时不应显示 suggestion
    expect(result.text()).not.toContain('macOS')
  })

  it('W3-A6-update-page-two-line-vitest: 测试失败无 suggestion 时只显示一行', async () => {
    // Mock testProxy 返回失败结果（无 suggestion）
    testProxyMock.mockResolvedValue({
      success: false,
      message: 'fetch failed',
    })

    const wrapper = mount(UpdatePage)
    await flushPromises()

    const testButton = wrapper.find('[data-testid="btn-test-proxy"]')
    await testButton.trigger('click')
    await flushPromises()

    const result = wrapper.find('[data-testid="test-proxy-result"]')
    expect(result.exists()).toBe(true)
    expect(result.text()).toContain('代理连接失败: fetch failed')
  })
})
