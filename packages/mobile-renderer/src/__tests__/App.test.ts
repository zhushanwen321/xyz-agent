/**
 * App.vue 连接门控测试（P4-s2-w2 AC8）。
 *
 * 验收：
 *  - AC8a: 无 token（无 location.hash + 无远程存档）→ 渲染 MobileConnectScreen（粘贴框 DOM）
 *  - AC8b: location.hash 含 #token= → 自动解析 + init 连接流程启动
 *  - 连接成功（state=connected）→ 渲染 MobileShell
 *  - [Major2 fix] 失败态存档保留策略：failReason='auth' → 清存档；failReason='network' → 保留存档
 *
 * Mock 策略：
 *  - useConnection: state ref 可控，init spy
 *  - connection-config: isRemoteMode/saveProfile/activateRemote/deactivateRemote spy
 *  - ws-client: getFailReason 返回可控 failReason ref（决定失败态是否清存档）
 *  - location.hash 通过 vi.spyOn(window.history/location) 或 delete window.location 重设
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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

// 可控的 failReason ref（Major2：决定失败态是否清存档）
const failReasonRef = ref<'auth' | 'replaced' | 'network' | null>(null)

vi.mock('@/composables/useConnection', () => ({
  useConnection: () => ({ state: stateRef, init: initMock }),
}))

vi.mock('@/lib/remote/connection-config', () => ({
  isRemoteMode: isRemoteModeMock,
  saveProfile: saveProfileMock,
  activateRemote: activateRemoteMock,
  deactivateRemote: deactivateRemoteMock,
}))

vi.mock('@/lib/ws-client', () => ({
  getFailReason: () => failReasonRef,
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
  failReasonRef.value = null
  initMock.mockClear()
  isRemoteModeMock.mockClear()
  saveProfileMock.mockClear()
  activateRemoteMock.mockClear()
  deactivateRemoteMock.mockClear()
  isRemoteModeMock.mockReturnValue(false)
  // 默认无 hash
  setLocation('http://localhost:1421/')
})

// 收集每个用例的 wrapper，afterEach 统一 unmount 避免残留 watch(state) 串扰。
// （App.vue 的 watch(state) 在组件存活时持续触发，多用例累积的 watcher 会让
//   deactivateRemote 被重复调用，污染「调用次数」断言。）
const wrappers: Array<{ unmount: () => void }> = []
afterEach(() => {
  while (wrappers.length > 0) {
    const w = wrappers.pop()
    try {
      w!.unmount()
    } catch {
      // 已 unmount 或异常，吞掉
    }
  }
})

describe('App.vue 连接门控（P4-s2-w2 AC8）', () => {
  it('AC8a: 无 token（无 hash + 无远程存档）→ 渲染 MobileConnectScreen（粘贴框 DOM）', async () => {
    const App = await loadApp()
    const wrapper = mount(App)
    wrappers.push(wrapper)
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
    wrappers.push(mount(App))
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
    wrappers.push(wrapper)
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
    wrappers.push(mount(App))
    await vi.dynamicImportSettled()
    await new Promise((r) => setTimeout(r, 0))

    expect(initMock).toHaveBeenCalledOnce()
  })
})

// ── [Major2 fix] 失败态存档保留策略 ──
describe('App.vue 失败态存档保留策略（Major2 fix：spec §四）', () => {
  it('failReason=auth（token 失效）→ 清存档（deactivateRemote）', async () => {
    const App = await loadApp()
    wrappers.push(mount(App))
    await vi.dynamicImportSettled()
    await new Promise((r) => setTimeout(r, 0))

    // 模拟 auth 失败：state → failed 且 failReason='auth'
    failReasonRef.value = 'auth'
    stateRef.value = 'failed'
    await new Promise((r) => setTimeout(r, 0))

    expect(deactivateRemoteMock).toHaveBeenCalledTimes(1)
  })

  it('failReason=network（网络抖动）→ 保留存档（不调 deactivateRemote）', async () => {
    const App = await loadApp()
    wrappers.push(mount(App))
    await vi.dynamicImportSettled()
    await new Promise((r) => setTimeout(r, 0))

    // 模拟网络失败：state → failed 且 failReason='network'
    failReasonRef.value = 'network'
    stateRef.value = 'failed'
    await new Promise((r) => setTimeout(r, 0))

    expect(deactivateRemoteMock).not.toHaveBeenCalled()
  })

  it('failReason=replaced（被挤下线）→ 保留存档（不调 deactivateRemote）', async () => {
    const App = await loadApp()
    wrappers.push(mount(App))
    await vi.dynamicImportSettled()
    await new Promise((r) => setTimeout(r, 0))

    failReasonRef.value = 'replaced'
    stateRef.value = 'failed'
    await new Promise((r) => setTimeout(r, 0))

    expect(deactivateRemoteMock).not.toHaveBeenCalled()
  })
})
