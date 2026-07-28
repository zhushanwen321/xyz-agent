/**
 * App.vue pending-batch 全局订阅挂载测试（P3 D3，TC7）。
 *
 * 验证 App.vue setup 调 bindPendingRequestsBatchEffect() 挂载全局订阅。
 * mock 该 effect 捕获调用，验证 App 挂载时被调用一次。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/App-pending-batch.test.ts
 */
import { describe, it, expect, vi } from 'vitest'

// 捕获 bindPendingRequestsBatchEffect 调用（vi.hoisted 让 mock 工厂能引用，vi.mock 提升到顶部）
const { bindPendingBatch } = vi.hoisted(() => ({ bindPendingBatch: vi.fn() }))
vi.mock('@/composables/effects/usePendingRequestsBatchEffect', () => ({
  bindPendingRequestsBatchEffect: bindPendingBatch,
}))
// stub 其余 App 依赖（复用 App-w8 策略）
vi.mock('@/composables/useConnection', () => ({
  useConnection: () => ({
    state: { value: 'connected' },
    init: () => Promise.resolve(),
    teardown: () => {},
    retryRuntime: () => Promise.resolve(),
  }),
}))
vi.mock('@/composables/features/useSidebar', () => ({
  useSidebar: () => ({ onConnected: () => Promise.resolve() }),
}))
vi.mock('@/composables/effects/useForkNoticeEffect', () => ({ bindForkNoticeEffect: () => {} }))
vi.mock('@/lib/ws-client', () => ({
  getFailReason: () => ({ value: null }),
  getIsRemote: () => ({ value: false }),
}))
vi.mock('@/components/shell/AppShell.vue', () => ({ default: { name: 'AppShell', template: '<div />' } }))
vi.mock('@/components/ui/ToastContainer.vue', () => ({ default: { name: 'ToastContainer', template: '<div />' } }))
vi.mock('@/components/remote/RemoteConnectModal.vue', () => ({ default: { name: 'RemoteConnectModal', template: '<div />' } }))

import { mount } from '@vue/test-utils'
import App from '@/App.vue'

describe('P3 D3: App.vue setup 调 bindPendingRequestsBatchEffect 挂载全局订阅', () => {
  it('TC7: App 挂载时 bindPendingRequestsBatchEffect 被调用一次', () => {
    bindPendingBatch.mockClear()
    mount(App)
    expect(bindPendingBatch).toHaveBeenCalledTimes(1)
  })
})
