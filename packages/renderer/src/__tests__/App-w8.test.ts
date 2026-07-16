/**
 * W8: App.vue 连接建立时调 useSidebar.onConnected（统一入口）。
 *
 * 背景：workspaceStore.load() 只在 initApp 调一次，appBootstrapped 守卫阻止重连后重跑 initApp。
 * WS 断连重连后（runtime 可能重启重载磁盘新记录，或另一窗口写入），前端 records 停留 stale。
 *
 * 修复：onConnected 在 useSidebar 内用模块级 hasConnectedBefore 区分首次 vs 重连（见 useSidebar
 * 单测验证该逻辑）。App.vue 只负责 watch connectionState 并调 onConnected——本测试钉住这层调用契约。
 *
 * Mock 策略：vi.mock useConnection（返回可控 state ref），vi.mock useSidebar（捕获 onConnected 调用），
 * vi.mock AppShell/ToastContainer（避免渲染依赖树）。
 *
 * 运行：npx vitest run src/__tests__/App-w8.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'

// 可控的 connectionState（外部修改触发 App.vue 的 watch）
const connectionState = ref<'disconnected' | 'connected'>('disconnected')

const mocks = vi.hoisted(() => ({
  onConnected: vi.fn(async () => {}),
  init: vi.fn(async () => {}),
  teardown: vi.fn(),
  retryRuntime: vi.fn(async () => {}),
}))

vi.mock('@/composables/useConnection', () => ({
  useConnection: () => ({
    state: connectionState,
    init: mocks.init,
    teardown: mocks.teardown,
    retryRuntime: mocks.retryRuntime,
  }),
}))

vi.mock('@/composables/features/useSidebar', () => ({
  useSidebar: () => ({ onConnected: mocks.onConnected }),
}))

// stub 掉重组件，避免渲染 AppShell/ToastContainer 的依赖树
vi.mock('@/components/shell/AppShell.vue', () => ({ default: { name: 'AppShell', template: '<div />' } }))
vi.mock('@/components/ui/ToastContainer.vue', () => ({ default: { name: 'ToastContainer', template: '<div />' } }))

import { mount } from '@vue/test-utils'
import App from '@/App.vue'

describe('W8: App.vue 连接建立调 onConnected', () => {
  let wrapper: ReturnType<typeof mount> | null = null

  beforeEach(() => {
    connectionState.value = 'disconnected'
    vi.clearAllMocks()
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  it('connected → onConnected 被调用 1 次', async () => {
    wrapper = mount(App)
    connectionState.value = 'connected'
    await new Promise((r) => setTimeout(r, 0))
    expect(mocks.onConnected).toHaveBeenCalledTimes(1)
  })

  it('断连→重连 connected → onConnected 再次被调用（刷新由 onConnected 内部判断）', async () => {
    wrapper = mount(App)
    connectionState.value = 'connected'
    await new Promise((r) => setTimeout(r, 0))
    connectionState.value = 'disconnected'
    await new Promise((r) => setTimeout(r, 0))
    connectionState.value = 'connected'
    await new Promise((r) => setTimeout(r, 0))
    // onConnected 被调两次（首次 + 重连），内部逻辑区分由 useSidebar 单测验证
    expect(mocks.onConnected).toHaveBeenCalledTimes(2)
  })

  it('非 connected 状态不触发 onConnected', async () => {
    wrapper = mount(App)
    connectionState.value = 'disconnected'
    await new Promise((r) => setTimeout(r, 0))
    expect(mocks.onConnected).not.toHaveBeenCalled()
  })
})
