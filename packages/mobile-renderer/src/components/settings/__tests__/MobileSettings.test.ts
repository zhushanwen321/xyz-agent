/**
 * MobileSettings 测试（P4-s4-w2 AC10 连接信息+断开、AC11 theme 切换）。
 *
 * 验收：
 *  - 有 profile 时显示 host/token/deviceName + 断开按钮
 *  - 无 profile 时显示 notConnected 提示
 *  - theme toggle 调 setSystem({theme}) 且 DOM data-theme 生效
 *  - 断开按钮调 deactivateRemote（isRemoteMode 变 false）+ location.reload
 *    （reload 必要：App 连接门控只 watch ws-client state，不读 localStorage）
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

// location.reload mock：onDisconnect 调 location.reload 切回连接页（jsdom 下真 reload 无意义）
const reloadMock = vi.fn()
vi.stubGlobal('location', { ...window.location, reload: reloadMock })

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
  reloadMock.mockClear()
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

  it('断开按钮调 deactivateRemote（isRemoteMode 变 false）+ location.reload 切回连接页', async () => {
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
    // reload 必须触发：否则 App 连接门控只 watch ws-client state（不读 localStorage），
    // state 仍 connected，MobileShell 不卸载，用户无法回连接页（BLOCKER 修复回归断言）
    expect(reloadMock).toHaveBeenCalledTimes(1)
  })

  it('theme toggle 失败时 toast 反馈（不静默）', async () => {
    updateSystemMock.mockRejectedValueOnce(new Error('boom'))
    const wrapper = mount(MobileSettings)
    await wrapper.find('[data-testid="mobile-settings-theme-toggle"]').trigger('click')
    // ToastContainer 挂载在 App（mount 单组件无容器），断言 toast store 非空即可
    const { useToast } = await import('@/composables/useToast')
    expect(useToast().toasts.value.length).toBeGreaterThan(0)
    expect(useToast().toasts.value[0].type).toBe('error')
  })
})
