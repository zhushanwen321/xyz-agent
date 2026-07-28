/**
 * useConnection 重连编排测试（wave3 P2-s4 TC28，spec §6.1/§6.3）。
 *
 * 验证 useConnection 的 watch(getState()) 重连检测：
 * - 首次连接（connecting→connected）：setSubscribedSessions 被调，bumpReconnectEpoch 不调
 * - 重连（disconnected/reconnecting→connected）：bumpReconnectEpoch 被调 + setSubscribedSessions 被调
 * - panels 的 sessionId 列表传入 setSubscribedSessions
 *
 * Vue watch 异步：每次 mockStateRef 赋值后 await nextTick 让 watch 回调跑完再断言。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/useConnection-reconnect.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref, type Ref } from 'vue'
import type { ConnectionState } from '@/lib/ws-client'

// ── ws-client mock：捕获 setSubscribedSessions 调用 + 提供 mockStateRef ──
const mockConnect = vi.fn()
const mockDisconnect = vi.fn()
const mockStateRef: Ref<ConnectionState> = ref('disconnected')
const mockSetSubscribedSessions = vi.fn()
vi.mock('@/lib/ws-client', () => ({
  connect: (...args: unknown[]) => mockConnect(...args),
  disconnect: (...args: unknown[]) => mockDisconnect(...args),
  getState: () => mockStateRef,
  setRestarting: vi.fn(),
  setFailed: vi.fn(),
  setSubscribedSessions: (...args: unknown[]) => mockSetSubscribedSessions(...args),
}))

// ── terminal-reconnect-signal mock：捕获 bumpReconnectEpoch 调用 ──
const mockBumpReconnectEpoch = vi.fn()
vi.mock('@/lib/terminal-reconnect-signal', () => ({
  bumpReconnectEpoch: (...args: unknown[]) => mockBumpReconnectEpoch(...args),
}))

// ── ipc mock ──
vi.mock('@/lib/ipc', () => ({
  getRuntimePort: vi.fn().mockResolvedValue(undefined),
  getRuntimePortOffset: vi.fn().mockResolvedValue(undefined),
  onRuntimePort: () => () => {},
  onRuntimeRestarting: () => () => {},
  onRuntimeFailed: () => () => {},
  restartRuntime: vi.fn().mockResolvedValue(undefined),
}))

// ── transport / pending / events mock ──
vi.mock('@/api/transport', () => ({ on: () => () => {} }))
const mockRejectAll = vi.fn()
vi.mock('@/api/pending', () => ({
  rejectAll: (...args: unknown[]) => mockRejectAll(...args),
  resolve: vi.fn(),
  reject: vi.fn(),
}))
vi.mock('@/api/events', () => ({
  dispatchSession: vi.fn(),
  dispatchGlobal: vi.fn(),
}))

// ── useToast / stores mock ──
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: vi.fn() }),
}))
vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({ finalizeAllStreaming: vi.fn(), markSessionError: vi.fn() }),
}))
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ markDead: vi.fn() }),
}))
vi.mock('@/stores/extension-ui', () => ({
  useExtensionUIStore: () => ({ clearAllPending: vi.fn() }),
}))

// ── panel store mock：控制 panels 的 sessionId 列表（syncSubscribedSessions 来源）──
const mockPanels: Ref<Array<{ sessionId: string | null }>> = ref([{ sessionId: 's1' }])
vi.mock('@/stores/panel', () => ({
  usePanelStore: () => ({
    get panels() {
      return mockPanels.value
    },
    activePanelId: 'root',
    focusedSessionId: 's1',
  }),
}))

// ── remote connection-config mock（远程模式判断 + init 不走远程分支）──
vi.mock('@/lib/remote/connection-config', () => ({
  isRemoteMode: () => false,
  getActiveProfile: () => null,
  getClientId: () => 'test-client',
  getDeviceName: () => 'test-device',
}))

import { nextTick } from 'vue'
import { useConnection } from '@/composables/useConnection'

describe('TC28: useConnection 重连编排（bumpReconnectEpoch + setSubscribedSessions）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStateRef.value = 'disconnected'
    mockPanels.value = [{ sessionId: 's1' }]
    // init 在 VITE_MOCK='true' 时走 mock 分支提前 return，不安装 watch getState。
    // 本测试需触发 watch，故 stub VITE_MOCK 为空串走非 mock 路径。
    vi.stubEnv('VITE_MOCK', '')
  })

  it('首次连接 connecting→connected：setSubscribedSessions 被调，bumpReconnectEpoch 不调', async () => {
    const { init, teardown } = useConnection()
    await init()

    // 模拟首次连接：connecting → connected（每步 await nextTick 让 watch 跑）
    mockStateRef.value = 'connecting'
    await nextTick()
    mockBumpReconnectEpoch.mockClear()
    mockStateRef.value = 'connected'
    await nextTick()

    // 首次连接成功：setSubscribedSessions 被调（注入订阅供下次重连用）
    expect(mockSetSubscribedSessions).toHaveBeenCalled()
    // bumpReconnectEpoch 不被调（首次连接非重连，不清 scrollback）
    expect(mockBumpReconnectEpoch).not.toHaveBeenCalled()
    teardown()
  })

  it('重连 disconnected→connected：bumpReconnectEpoch 被调 + setSubscribedSessions 被调', async () => {
    const { init, teardown } = useConnection()
    await init()

    // 先到 connected（首次），再断到 disconnected，再重连回 connected
    mockStateRef.value = 'connecting'
    await nextTick()
    mockStateRef.value = 'connected'
    await nextTick()
    mockStateRef.value = 'disconnected'
    await nextTick()
    // 清掉之前的调用计数，专注验重连分支
    mockBumpReconnectEpoch.mockClear()
    mockSetSubscribedSessions.mockClear()

    mockStateRef.value = 'connected'
    await nextTick()

    // 重连成功：bump 信号触发 + 注入订阅
    expect(mockBumpReconnectEpoch).toHaveBeenCalledTimes(1)
    expect(mockSetSubscribedSessions).toHaveBeenCalledTimes(1)
    // 注入的 sessionId 来自 panels
    expect(mockSetSubscribedSessions).toHaveBeenCalledWith(['s1'])
    teardown()
  })

  it('重连 reconnecting→connected：bumpReconnectEpoch 被调（reconnecting 也算重连）', async () => {
    const { init, teardown } = useConnection()
    await init()

    mockStateRef.value = 'reconnecting'
    await nextTick()
    mockBumpReconnectEpoch.mockClear()
    mockStateRef.value = 'connected'
    await nextTick()

    expect(mockBumpReconnectEpoch).toHaveBeenCalledTimes(1)
    teardown()
  })

  it('panels 多 sessionId → setSubscribedSessions 传完整列表（过滤 null）', async () => {
    mockPanels.value = [{ sessionId: 's1' }, { sessionId: 's2' }, { sessionId: null }]
    const { init, teardown } = useConnection()
    await init()

    // init 末尾初始注入（syncSubscribedSessions）—— null 被过滤
    expect(mockSetSubscribedSessions).toHaveBeenCalledWith(['s1', 's2'])
    teardown()
  })

  it('断线 connected→disconnected：bumpReconnectEpoch 不调（只 rejectAll pending）', async () => {
    const { init, teardown } = useConnection()
    await init()

    mockStateRef.value = 'connecting'
    await nextTick()
    mockStateRef.value = 'connected'
    await nextTick()
    mockBumpReconnectEpoch.mockClear()
    mockRejectAll.mockClear()
    mockStateRef.value = 'disconnected'
    await nextTick()

    // 断线不清 scrollback（bump 不调），只 rejectAll
    expect(mockBumpReconnectEpoch).not.toHaveBeenCalled()
    expect(mockRejectAll).toHaveBeenCalled()
    teardown()
  })
})
