/**
 * W2: App.vue failed 分支按 (failReason, isRemote) 分化文案+按钮。
 *
 * 背景：ws-client 已暴露 failReason/isRemote（wave1 ae71e6540），useConnection.retryRuntime
 * 已分模式（wave1 c52820b1e）。本 wave 改 App.vue 消费：auth→认证文案+双按钮、replaced→
 * 强制接管、network+remote→远程网络重试、null/network+local→现状本地分支逐字节不变。
 *
 * Mock 策略：vi.mock ws-client 导出 getState/getFailReason/getIsRemote 返回可控 readonly ref
 * （App.vue 直接 import 这俩 ref，不经 useConnection——与 App-w8 的 mock 解耦）；vi.mock
 * useConnection 返回 state+retryRuntime spy；vi.mock RemoteConnectModal 为 stub div 验证挂载；
 * vi.mock AppShell/ToastContainer/useSidebar/useForkNoticeEffect 复用 App-w8 策略。
 *
 * 运行：npx vitest run src/__tests__/App-w2-failed-remote.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, type DeepReadonly, type Ref } from 'vue'
import type { ConnectionState, FailReason } from '@/lib/ws-client'

// 可控的 ws-client 状态（App.vue 直接 import getFailReason/getIsRemote/getState）
const connectionState = ref<ConnectionState>('failed')
const failReason = ref<FailReason>(null)
const isRemote = ref<boolean>(false)

// ws-client 类型导出是 type-only，运行时 mock 需提供函数实现
vi.mock('@/lib/ws-client', () => ({
  getState: () => connectionState as unknown as DeepReadonly<Ref<ConnectionState>>,
  getFailReason: () => failReason as unknown as DeepReadonly<Ref<FailReason>>,
  getIsRemote: () => isRemote as unknown as DeepReadonly<Ref<boolean>>,
}))

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

// stub RemoteConnectModal：挂载时渲染 data-testid=remote-connect-modal 标记，供断言挂载
vi.mock('@/components/remote/RemoteConnectModal.vue', () => ({
  default: {
    name: 'RemoteConnectModal',
    props: ['standalone'],
    emits: ['close'],
    template: '<div data-testid="remote-connect-modal"><slot /></div>',
  },
}))

// stub 重组件，避免渲染依赖树（复用 App-w8 策略）
vi.mock('@/components/shell/AppShell.vue', () => ({ default: { name: 'AppShell', template: '<div />' } }))
vi.mock('@/components/ui/ToastContainer.vue', () => ({ default: { name: 'ToastContainer', template: '<div />' } }))
vi.mock('@/composables/effects/useForkNoticeEffect', () => ({ bindForkNoticeEffect: () => {} }))
// stub pending-batch 全局效果（P3 D3，App setup 调用，依赖 pinia/extension-ui store）
vi.mock('@/composables/effects/usePendingRequestsBatchEffect', () => ({ bindPendingRequestsBatchEffect: () => {} }))

import { mount } from '@vue/test-utils'
import App from '@/App.vue'

/**
 * 按状态组合挂载 App 并返回 wrapper。
 * failReason/isRemote/connectionState 在 beforeEach 已设，这里仅 mount。
 */
function mountApp() {
  return mount(App)
}

describe('W2: App.vue failed 分支按 (failReason, isRemote) 分化', () => {
  let wrapper: ReturnType<typeof mount> | null = null

  beforeEach(() => {
    connectionState.value = 'failed'
    failReason.value = null
    isRemote.value = false
    vi.clearAllMocks()
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  it('failReason=auth && isRemote=true：渲染认证失败文案 + 双按钮 + 点击副作用', async () => {
    failReason.value = 'auth'
    isRemote.value = true
    wrapper = mountApp()

    // 文案：failedAuth
    expect(wrapper.text()).toContain('认证失败：token 错误或已被重置')

    // [重新连接] 按钮点击 → retryRuntime 调 1 次
    const reconnectBtn = wrapper.find('[data-testid="failed-reconnect-btn"]')
    expect(reconnectBtn.exists()).toBe(true)
    await reconnectBtn.trigger('click')
    expect(mocks.retryRuntime).toHaveBeenCalledTimes(1)

    // [修改连接信息] 按钮点击 → 挂载 RemoteConnectModal
    expect(wrapper.find('[data-testid="remote-connect-modal"]').exists()).toBe(false)
    const editBtn = wrapper.find('[data-testid="failed-edit-connection-btn"]')
    expect(editBtn.exists()).toBe(true)
    await editBtn.trigger('click')
    expect(wrapper.find('[data-testid="remote-connect-modal"]').exists()).toBe(true)
  })

  it('failReason=replaced && isRemote=true：渲染被挤下线文案 + 强制接管按钮', async () => {
    failReason.value = 'replaced'
    isRemote.value = true
    wrapper = mountApp()

    expect(wrapper.text()).toContain('此设备已在其他窗口连接')

    const takeoverBtn = wrapper.find('[data-testid="failed-force-takeover-btn"]')
    expect(takeoverBtn.exists()).toBe(true)
    await takeoverBtn.trigger('click')
    expect(mocks.retryRuntime).toHaveBeenCalledTimes(1)

    // 其他分支按钮不存在
    expect(wrapper.find('[data-testid="failed-edit-connection-btn"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="failed-remote-retry-btn"]').exists()).toBe(false)
  })

  it('failReason=network && isRemote=true：渲染远程网络失败文案 + 远程重试按钮', async () => {
    failReason.value = 'network'
    isRemote.value = true
    wrapper = mountApp()

    expect(wrapper.text()).toContain('无法连接服务器：检查 Tailscale/服务器是否在线')

    const retryBtn = wrapper.find('[data-testid="failed-remote-retry-btn"]')
    expect(retryBtn.exists()).toBe(true)
    await retryBtn.trigger('click')
    expect(mocks.retryRuntime).toHaveBeenCalledTimes(1)

    // 本地 testid 不存在（远程分支独立 testid）
    expect(wrapper.find('[data-testid="runtime-retry-btn"]').exists()).toBe(false)
  })

  it('failReason=null && isRemote=false：本地分支逐字节不变（现状契约）', () => {
    failReason.value = null
    isRemote.value = false
    wrapper = mountApp()

    // 现状本地文案
    expect(wrapper.text()).toContain('runtime 不可用，重试多次仍失败')
    // 现状 testid 存在
    expect(wrapper.find('[data-testid="runtime-retry-btn"]').exists()).toBe(true)
    // 远程分支按钮均不存在
    expect(wrapper.find('[data-testid="failed-reconnect-btn"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="failed-edit-connection-btn"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="failed-force-takeover-btn"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="failed-remote-retry-btn"]').exists()).toBe(false)
  })

  it('failReason=network && isRemote=false：按 isRemote 判据走本地分支（非远程 network 文案）', () => {
    failReason.value = 'network'
    isRemote.value = false
    wrapper = mountApp()

    // 本地文案（非 failedRemoteNetwork）
    expect(wrapper.text()).toContain('runtime 不可用，重试多次仍失败')
    expect(wrapper.text()).not.toContain('Tailscale')
    // 本地 testid 存在
    expect(wrapper.find('[data-testid="runtime-retry-btn"]').exists()).toBe(true)
    // 远程 testid 不存在
    expect(wrapper.find('[data-testid="failed-remote-retry-btn"]').exists()).toBe(false)
  })
})
