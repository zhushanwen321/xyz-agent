/**
 * App.vue 连接门控测试（P4-s2-w2 AC8）。
 *
 * 验收：
 *  - AC8a: 无 token（无 location.hash + 无远程存档）→ 渲染 MobileConnectScreen（粘贴框 DOM）
 *  - AC8b: location.hash 含 #token= → 自动解析 + init 连接流程启动
 *  - 连接成功（state=connected）→ 渲染 MobileShell
 *
 * Mock 策略：
 *  - useConnection: state ref 可控，init spy
 *  - connection-config: isRemoteMode/saveProfile/activateRemote/deactivateRemote spy
 *  - location.hash 通过 vi.spyOn(window.history/location) 或 delete window.location 重设
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import type { Ref } from 'vue'
import { setActivePinia, createPinia } from 'pinia'

// 可控的 connectionState ref（App.vue 通过 useConnection().state 读）
const stateRef = ref<'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'failed'>('disconnected')
const initMock = vi.fn(() => Promise.resolve())

const { isRemoteModeMock, saveProfileMock, activateRemoteMock, deactivateRemoteMock } = vi.hoisted(() => ({
  isRemoteModeMock: vi.fn(() => false),
  saveProfileMock: vi.fn((p: { url: string }) => ({ id: 'srv-1', name: p.url, url: p.url, token: '', networkKind: 'public' as const })),
  activateRemoteMock: vi.fn(),
  deactivateRemoteMock: vi.fn(),
}))

vi.mock('@/composables/useConnection', () => ({
  useConnection: () => ({ state: stateRef, init: initMock }),
}))

vi.mock('@/lib/remote/connection-config', () => ({
  isRemoteMode: isRemoteModeMock,
  saveProfile: saveProfileMock,
  activateRemote: activateRemoteMock,
  deactivateRemote: deactivateRemoteMock,
}))

// 动态 import App（在 mock 之后）
async function loadApp() {
  return (await import('@/App.vue')).default
}

/** 设置 location.href（含 hash）用于 hash token 直达测试 */
function setLocation(href: string): void {
  // happy-dom 允许直接重设 window.location
  Object.defineProperty(window, 'location', {
    value: new URL(href),
    writable: true,
    configurable: true,
  })
}

beforeEach(async () => {
  vi.resetModules()
  setActivePinia(createPinia())
  stateRef.value = 'disconnected'
  initMock.mockClear()
  isRemoteModeMock.mockClear()
  saveProfileMock.mockClear()
  activateRemoteMock.mockClear()
  deactivateRemoteMock.mockClear()
  isRemoteModeMock.mockReturnValue(false)
  // 默认无 hash
  setLocation('http://localhost:1421/')
})

describe('App.vue 连接门控（P4-s2-w2 AC8）', () => {
  it('AC8a: 无 token（无 hash + 无远程存档）→ 渲染 MobileConnectScreen（粘贴框 DOM）', async () => {
    const App = await loadApp()
    const wrapper = mount(App)
    // 等待 onMounted 异步完成
    await vi.dynamicImportSettled()
    await new Promise((r) => setTimeout(r, 0))

    expect(wrapper.find('[data-testid="mobile-connect-screen"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-connect-input"]').exists()).toBe(true)
    // 未自动连接（无 hash + 无存档）
    expect(initMock).not.toHaveBeenCalled()
  })

  it('AC8b: location.href 含 #token= → 自动解析 + init 连接流程启动', async () => {
    // http-url 格式：http://host:port/#token=xxx
    setLocation('http://1.2.3.4:7420/#token=abc123')
    const App = await loadApp()
    mount(App)
    await vi.dynamicImportSettled()
    await new Promise((r) => setTimeout(r, 0))

    // saveProfile 被调用（解析 hash token 后激活远程）
    expect(saveProfileMock).toHaveBeenCalledOnce()
    expect(activateRemoteMock).toHaveBeenCalledOnce()
    // init 连接流程启动
    expect(initMock).toHaveBeenCalledOnce()
  })

  it('连接成功（state=connected）→ 渲染 MobileShell（底部 tab）', async () => {
    stateRef.value = 'connected'
    const App = await loadApp()
    const wrapper = mount(App)
    await vi.dynamicImportSettled()
    await new Promise((r) => setTimeout(r, 0))

    // MobileShell 渲染（底部三 tab 存在）
    expect(wrapper.find('[data-testid="mobile-tab-sessions"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-tabbar"], [role="tablist"]').exists()).toBe(true)
    // MobileConnectScreen 不渲染
    expect(wrapper.find('[data-testid="mobile-connect-screen"]').exists()).toBe(false)
  })

  it('已有远程存档（isRemoteMode=true，无 hash）→ 自动 init 连接', async () => {
    isRemoteModeMock.mockReturnValue(true)
    const App = await loadApp()
    mount(App)
    await vi.dynamicImportSettled()
    await new Promise((r) => setTimeout(r, 0))

    expect(initMock).toHaveBeenCalledOnce()
  })
})
