/**
 * useConnection presence resume 测试（P5 审查 Major3）。
 *
 * spec §五要求 resume 路径（短断线，无 auth.ok.presence 兜底）主动调 presence.list RPC 拉一次。
 * 此前 renderer 无任何 listPresence 调用点 → 短断线 resume 后 presence store 是断线前的旧列表。
 *
 * 验证：
 * - 远程模式连接成功（首次 + 重连）→ session.listPresence() 被调 + presence store.setConnections 被调
 * - 本地模式连接成功 → listPresence 不被调（本地单客户端无多端 presence 需求）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/useConnection-presence-resume.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref, type Ref, nextTick } from 'vue'
import type { ConnectionState } from '@/lib/ws-client'

// ── ws-client mock：提供 mockStateRef ──
const mockStateRef: Ref<ConnectionState> = ref('disconnected')
vi.mock('@/lib/ws-client', () => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  getState: () => mockStateRef,
  setRestarting: vi.fn(),
  setFailed: vi.fn(),
  setSubscribedSessions: vi.fn(),
}))

vi.mock('@/lib/terminal-reconnect-signal', () => ({
  bumpReconnectEpoch: vi.fn(),
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
vi.mock('@/api/pending', () => ({
  rejectAll: vi.fn(),
  resolve: vi.fn(),
  reject: vi.fn(),
}))
vi.mock('@/api/events', () => ({
  dispatchSession: vi.fn(),
  dispatchGlobal: vi.fn(),
}))

// ── @/api 门面 mock：捕获 session.listPresence 调用 ──
const mockListPresence = vi.fn()
vi.mock('@/api', () => ({
  session: { listPresence: (...args: unknown[]) => mockListPresence(...args) },
}))

// ── useToast / stores mock ──
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: vi.fn() }),
}))
vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({ finalizeAllStreaming: vi.fn(), markSessionError: vi.fn() }),
}))
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ markDead: vi.fn(), setSessionBusy: vi.fn(), clearSessionBusy: vi.fn() }),
}))
vi.mock('@/stores/extension-ui', () => ({
  useExtensionUIStore: () => ({ clearAllPending: vi.fn() }),
}))
vi.mock('@/stores/panel', () => ({
  usePanelStore: () => ({ panels: [], activePanelId: 'root', focusedSessionId: null }),
}))

// ── presence store mock：捕获 setConnections 调用 ──
const mockSetConnections = vi.fn()
vi.mock('@/stores/presence', () => ({
  usePresenceStore: () => ({ setConnections: (...args: unknown[]) => mockSetConnections(...args) }),
}))

// ── remote connection-config mock：默认远程模式（可切本地）──
let remoteMode = true
vi.mock('@/lib/remote/connection-config', () => ({
  isRemoteMode: () => remoteMode,
  getActiveProfile: () => ({ url: 'ws://remote', token: 't', clientId: 'c', deviceName: 'd' }),
  getClientId: () => 'test-client',
  getDeviceName: () => 'test-device',
}))

import { useConnection } from '@/composables/useConnection'

describe('Major3: useConnection 远程模式连接成功后调 presence.list RPC', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStateRef.value = 'disconnected'
    remoteMode = true
    vi.stubEnv('VITE_MOCK', '')
  })

  it('远程模式首次连接 connecting→connected：listPresence 被调 + setConnections 被调', async () => {
    const connections = [{ clientId: 'c1', deviceName: 'Mac', activeSessionId: null, isOperating: false }]
    mockListPresence.mockResolvedValue(connections)

    const { init, teardown } = useConnection()
    await init()

    // 远程模式 init 直接 return（不安装 watch getState 的 connected 分支？不——init 内 watch 仍安装）
    mockStateRef.value = 'connecting'
    await nextTick()
    mockStateRef.value = 'connected'
    await nextTick()
    // listPresence 是异步链（.then 调 setConnections），await microtask 让 .then 跑完
    await nextTick()

    expect(mockListPresence).toHaveBeenCalledTimes(1)
    expect(mockSetConnections).toHaveBeenCalledWith(connections)
    teardown()
  })

  it('远程模式重连 disconnected→connected：listPresence 被调（resume 兜底）', async () => {
    mockListPresence.mockResolvedValue([])

    const { init, teardown } = useConnection()
    await init()

    // 首次连接
    mockStateRef.value = 'connecting'
    await nextTick()
    mockStateRef.value = 'connected'
    await nextTick()
    await nextTick()
    mockListPresence.mockClear()
    mockSetConnections.mockClear()

    // 断线
    mockStateRef.value = 'disconnected'
    await nextTick()
    // 重连成功
    mockStateRef.value = 'connected'
    await nextTick()
    await nextTick()

    // 重连成功也调 listPresence（resume 兜底）
    expect(mockListPresence).toHaveBeenCalledTimes(1)
    expect(mockSetConnections).toHaveBeenCalledWith([])
    teardown()
  })

  it('本地模式连接成功：listPresence 不被调（无多端 presence 需求）', async () => {
    remoteMode = false
    mockListPresence.mockResolvedValue([])

    const { init, teardown } = useConnection()
    await init()

    mockStateRef.value = 'connecting'
    await nextTick()
    mockStateRef.value = 'connected'
    await nextTick()
    await nextTick()

    expect(mockListPresence).not.toHaveBeenCalled()
    teardown()
  })

  it('listPresence 失败时不抛错（非阻塞，presence 可由广播自愈）', async () => {
    mockListPresence.mockRejectedValue(new Error('rpc failed'))

    const { init, teardown } = useConnection()
    await init()

    mockStateRef.value = 'connecting'
    await nextTick()
    mockStateRef.value = 'connected'
    await nextTick()
    await nextTick()
    await nextTick()

    // listPresence 被调但失败不传播、不调 setConnections
    expect(mockListPresence).toHaveBeenCalledTimes(1)
    expect(mockSetConnections).not.toHaveBeenCalled()
    teardown()
  })
})
