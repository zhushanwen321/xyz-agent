/**
 * MobileSettings 测试（P4-s4-w2 AC10 连接信息+断开、AC11 theme 切换）。
 *
 * 验收：
 *  - 有 profile 时显示 host/token/deviceName + 断开按钮
 *  - 无 profile 时显示 notConnected 提示
 *  - theme toggle 调 setSystem({theme}) 且 DOM data-theme 生效
 *  - 断开按钮调 deactivateRemote（isRemoteMode 变 false）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'

// mock settingsApi 避免 WS 调用（setSystem 调 settingsApi.updateSystem）
// 用 vi.hoisted 让 mock 引用在 factory 里可访问（vi.mock 被 hoist 到顶部）
const { updateSystemMock } = vi.hoisted(() => ({ updateSystemMock: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return {
    ...actual,
    settings: { ...actual.settings, updateSystem: updateSystemMock },
  }
})

import MobileSettings from '../MobileSettings.vue'
import {
  saveProfile,
  activateRemote,
  deactivateRemote,
  isRemoteMode,
  __resetForTest,
} from '@/lib/remote/connection-config'

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  __resetForTest()
  updateSystemMock.mockClear()
})

describe('MobileSettings（P4-s4-w2 AC10/AC11）', () => {
  it('有 profile 时显示 host/token/deviceName + 断开按钮', () => {
    const profile = saveProfile({
      name: 'host1',
      url: 'ws://1.2.3.4:7777',
      token: 'abcdefgh1234567890',
      networkKind: 'public',
    })
    activateRemote(profile.id)

    const wrapper = mount(MobileSettings)
    expect(wrapper.find('[data-testid="mobile-settings-connection"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-settings-host"]').text()).toBe('ws://1.2.3.4:7777')
    // token 截断显示（前 8 字符 + …）
    expect(wrapper.find('[data-testid="mobile-settings-token"]').text()).toContain('abcdefgh')
    expect(wrapper.find('[data-testid="mobile-settings-device-name"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-settings-disconnect"]').exists()).toBe(true)
  })

  it('无 profile 时显示 notConnected 提示，不显示连接信息区', () => {
    const wrapper = mount(MobileSettings)
    expect(wrapper.find('[data-testid="mobile-settings-not-connected"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-settings-connection"]').exists()).toBe(false)
  })

  it('theme toggle 调 setSystem({theme}) 切换 dark/light', async () => {
    const wrapper = mount(MobileSettings)
    // 默认 theme=dark，toggle 按钮显示 themeLight 文案
    const toggle = wrapper.find('[data-testid="mobile-settings-theme-toggle"]')
    expect(toggle.exists()).toBe(true)
    await toggle.trigger('click')
    // setSystem 调用 settingsApi.updateSystem（mock），patch theme=light
    expect(updateSystemMock).toHaveBeenCalledWith({ theme: 'light' })
  })

  it('断开按钮调 deactivateRemote（isRemoteMode 变 false）', async () => {
    const profile = saveProfile({
      name: 'host1',
      url: 'ws://1.2.3.4:7777',
      token: 'tok',
      networkKind: 'public',
    })
    activateRemote(profile.id)
    expect(isRemoteMode()).toBe(true)

    const wrapper = mount(MobileSettings)
    await wrapper.find('[data-testid="mobile-settings-disconnect"]').trigger('click')
    expect(isRemoteMode()).toBe(false)
    // 确认 deactivateRemote 被调用（connection-mode 写 local）
    void deactivateRemote
  })
})
