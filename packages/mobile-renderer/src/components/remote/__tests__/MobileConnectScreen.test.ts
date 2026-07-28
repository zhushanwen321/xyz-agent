/**
 * MobileConnectScreen 测试（P4-s2-w2）。
 *
 * 验收：
 *  - mount 后粘贴框（textarea）+ 连接按钮 DOM 存在
 *  - 粘贴合法 ws-url → 点击连接 → emit connected（profile 含 url/token）
 *  - 粘贴无法识别文本 → 显示 hintUnrecognized（不 emit）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import MobileConnectScreen from '../MobileConnectScreen.vue'

// Mock connection-config（vi.hoisted 保证 mock 工厂能引用，避免 TDZ）
const { saveProfileMock, activateRemoteMock } = vi.hoisted(() => ({
  saveProfileMock: vi.fn((p: { url: string; token: string }) => ({
    id: 'srv-1',
    name: p.url,
    url: p.url,
    token: p.token,
    networkKind: 'public' as const,
  })),
  activateRemoteMock: vi.fn(),
}))

vi.mock('@/lib/remote/connection-config', () => ({
  saveProfile: saveProfileMock,
  activateRemote: activateRemoteMock,
}))

beforeEach(() => {
  saveProfileMock.mockClear()
  activateRemoteMock.mockClear()
})

describe('MobileConnectScreen（P4-s2-w2）', () => {
  it('mount 后粘贴框 + 连接按钮 DOM 存在', () => {
    const wrapper = mount(MobileConnectScreen)
    expect(wrapper.find('[data-testid="mobile-connect-input"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-connect-button"]').exists()).toBe(true)
    // 标题文案（i18n）
    expect(wrapper.text()).toContain('连接到服务器')
  })

  it('粘贴合法 ws-url → 点击连接 → emit connected（含 profile）', async () => {
    const wrapper = mount(MobileConnectScreen)
    const textarea = wrapper.find('[data-testid="mobile-connect-input"]')
    // ws-url 格式
    await textarea.setValue('ws://1.2.3.4:7420')
    await wrapper.find('[data-testid="mobile-connect-button"]').trigger('click')

    // saveProfile 被调用
    expect(saveProfileMock).toHaveBeenCalledOnce()
    expect(saveProfileMock).toHaveBeenCalledWith(expect.objectContaining({ url: 'ws://1.2.3.4:7420' }))
    // activateRemote 被调用
    expect(activateRemoteMock).toHaveBeenCalledOnce()
    // emit connected
    const connectedEvents = wrapper.emitted('connected')
    expect(connectedEvents).toHaveLength(1)
    const profile = connectedEvents![0][0] as { url: string }
    expect(profile.url).toBe('ws://1.2.3.4:7420')
  })

  it('粘贴 http-url（含 token）→ 解析推导 ws + 提取 token', async () => {
    const wrapper = mount(MobileConnectScreen)
    await wrapper.find('[data-testid="mobile-connect-input"]').setValue('http://1.2.3.4:7420/#token=abc123')
    await wrapper.find('[data-testid="mobile-connect-button"]').trigger('click')

    expect(saveProfileMock).toHaveBeenCalledWith(expect.objectContaining({
      url: 'ws://1.2.3.4:7420',
      token: 'abc123',
    }))
    expect(wrapper.emitted('connected')).toHaveLength(1)
  })

  it('粘贴无法识别文本 → 显示 hintUnrecognized（不 emit connected）', async () => {
    const wrapper = mount(MobileConnectScreen)
    await wrapper.find('[data-testid="mobile-connect-input"]').setValue('这不是连接信息')
    await wrapper.find('[data-testid="mobile-connect-button"]').trigger('click')

    // 显示 hint
    expect(wrapper.find('[data-testid="mobile-connect-hint"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('无法识别')
    // 不 emit / 不 saveProfile
    expect(wrapper.emitted('connected')).toBeUndefined()
    expect(saveProfileMock).not.toHaveBeenCalled()
  })
})
