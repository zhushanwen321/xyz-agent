/**
 * W8: App.vue 重连后 workspace records 刷新。
 *
 * 背景：workspaceStore.load() 只在 useSidebar.initApp 调一次，appBootstrapped 守卫阻止重连后重跑 initApp。
 * WS 断连重连后（runtime 可能重启重载了磁盘新记录，或另一窗口写入），前端 records 停留在 stale 数据。
 *
 * 修复：App.vue watch connectionState 区分首次 vs 重连——首次 connected 调 initApp（内部含 load），
 * 重连 connected（hasConnectedBefore=true）额外 fire-and-forget workspaceStore.load() 刷新。
 *
 * Mock 策略：vi.mock useConnection（返回可控 state ref + initApp/load mock），vi.mock useSidebar，
 * vi.mock useWorkspaceStore，vi.mock AppShell（避免渲染重组件）。
 *
 * 运行：npx vitest run src/__tests__/App-w8.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'

// 可控的 connectionState（外部修改触发 App.vue 的 watch）
const connectionState = ref<'disconnected' | 'connected'>('disconnected')

const mocks = vi.hoisted(() => ({
  initApp: vi.fn(async () => {}),
  load: vi.fn(async () => {}),
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
  useSidebar: () => ({ initApp: mocks.initApp }),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: () => ({ load: mocks.load, records: ref([]), defaultCwd: ref(undefined), record: vi.fn() }),
}))

// stub 掉重组件，避免渲染 AppShell/ToastContainer 的依赖树
vi.mock('@/components/shell/AppShell.vue', () => ({ default: { name: 'AppShell', template: '<div />' } }))
vi.mock('@/components/ui/ToastContainer.vue', () => ({ default: { name: 'ToastContainer', template: '<div />' } }))

import { mount } from '@vue/test-utils'
import App from '@/App.vue'

describe('W8: App.vue 重连后 workspace records 刷新', () => {
  let wrapper: ReturnType<typeof mount> | null = null

  beforeEach(() => {
    connectionState.value = 'disconnected'
    vi.clearAllMocks()
  })

  afterEach(() => {
    // 卸载 App：销毁其 watch，避免多 it 累积多个 watcher 响应同一 ref
    wrapper?.unmount()
    wrapper = null
  })

  it('首次 connected → initApp 被调用，workspaceStore.load 不单独调用（initApp 内部已调）', async () => {
    wrapper = mount(App)
    // 触发首次连接
    connectionState.value = 'connected'
    // watch 是异步触发，等一个微任务
    await new Promise((r) => setTimeout(r, 0))
    expect(mocks.initApp).toHaveBeenCalledTimes(1)
    // 首次不该单独调 load（initApp 内部已含 load，避免重复）
    expect(mocks.load).not.toHaveBeenCalled()
  })

  it('断连后重连 connected → workspaceStore.load 被单独调用刷新', async () => {
    wrapper = mount(App)
    // 首次连接
    connectionState.value = 'connected'
    await new Promise((r) => setTimeout(r, 0))
    expect(mocks.initApp).toHaveBeenCalledTimes(1)
    // 断连
    connectionState.value = 'disconnected'
    await new Promise((r) => setTimeout(r, 0))
    // 重连
    connectionState.value = 'connected'
    await new Promise((r) => setTimeout(r, 0))
    // 重连后 load 被调（刷新 stale records）
    expect(mocks.load).toHaveBeenCalledTimes(1)
    // initApp 不该再被调（appBootstrapped 守卫在 initApp 内部，但此处 mock 不含守卫；
    // 关键断言是 load 被调用于刷新——真实 initApp 的守卫由 useSidebar 自身保证）
  })

  it('非 connected 状态不触发任何调用', async () => {
    wrapper = mount(App)
    connectionState.value = 'disconnected'
    await new Promise((r) => setTimeout(r, 0))
    expect(mocks.initApp).not.toHaveBeenCalled()
    expect(mocks.load).not.toHaveBeenCalled()
  })
})
