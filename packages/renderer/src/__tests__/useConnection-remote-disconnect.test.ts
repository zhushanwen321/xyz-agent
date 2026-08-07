/**
 * useConnection 远程模式 WS 断开收口测试（CRITICAL fix）。
 *
 * 背景：远程模式没有本地 IPC runtime 监听（onRuntimeRestarting/onRuntimeFailed 在
 * 远程分支提前 return 跳过注册），WS 断开是唯一的断开信号。state watch 的
 * connected→not-connected 分支必须在 isRemoteMode() 时调 finalizeAllStreaming('disconnect')，
 * 否则 streaming assistant 消息停留 streaming 态（isGenerating=true），UI 卡「思考中」
 * 直到 10 分钟 streaming timeout 兜底。
 *
 * 覆盖：
 *  - TC1: 远程模式 connected→disconnected 触发 finalizeAllStreaming('disconnect')
 *  - TC2: 本地模式 connected→disconnected 不触发 finalizeAllStreaming（由 IPC listener 兜底，
 *         避免双重 finalize）
 *  - TC3: 远程模式 connected→reconnecting（短断线重连尝试）也触发 finalize（任意 not-connected）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/useConnection-remote-disconnect.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref, nextTick, type Ref } from 'vue'
import type { ConnectionState } from '@/lib/ws-client'

// ── ws-client mock：提供 mockStateRef（init watch 的数据源）──
const mockConnect = vi.fn()
const mockDisconnect = vi.fn()
const mockStateRef: Ref<ConnectionState> = ref('disconnected')
vi.mock('@/lib/ws-client', () => ({
  connect: (...args: unknown[]) => mockConnect(...args),
  disconnect: (...args: unknown[]) => mockDisconnect(...args),
  getState: () => mockStateRef,
  setRestarting: vi.fn(),
  setFailed: vi.fn(),
  setSubscribedSessions: vi.fn(),
}))

// ── terminal-reconnect-signal mock ──
vi.mock('@/lib/terminal-reconnect-signal', () => ({
  bumpReconnectEpoch: vi.fn(),
}))

// ── ipc mock ──
vi.mock('@/lib/ipc', () => ({
  getRuntimePort: vi.fn().mockResolvedValue(undefined),
  getRuntimeToken: vi.fn(),
    getRuntimePortOffset: vi.fn().mockResolvedValue(undefined),
  onRuntimePort: () => () => {},
  onRuntimeRestarting: () => () => {},
  onRuntimeFailed: () => () => {},
  restartRuntime: vi.fn().mockResolvedValue(undefined),
}))

// ── remote connection-config mock：可切换 isRemoteMode ──
const isRemoteModeSpy = vi.fn(() => false)
vi.mock('@/lib/remote/connection-config', () => ({
  isRemoteMode: (...args: unknown[]) => isRemoteModeSpy(...args),
  getActiveProfile: () => ({ id: 'srv-1', name: 'srv', url: 'ws://remote:7420', token: 'tok', networkKind: 'public' as const }),
  getClientId: () => 'cid-test',
  getDeviceName: () => 'dev-test',
}))

// ── transport / pending / events mock ──
vi.mock('@/api/transport', () => ({ on: () => () => {} }))
vi.mock('@/api/pending', () => ({ rejectAll: vi.fn(), resolve: vi.fn(), reject: vi.fn() }))
vi.mock('@/api/events', () => ({ dispatchSession: vi.fn(), dispatchGlobal: vi.fn() }))

// ── useToast / stores mock ──
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: vi.fn() }),
}))
// 捕获 finalizeAllStreaming 调用（核心断言对象）
const finalizeAllStreamingSpy = vi.fn()
vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({ finalizeAllStreaming: (...args: unknown[]) => finalizeAllStreamingSpy(...args), markSessionError: vi.fn() }),
}))
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ markDead: vi.fn() }),
}))
vi.mock('@/stores/extension-ui', () => ({
  useExtensionUIStore: () => ({ clearAllPending: vi.fn() }),
}))
vi.mock('@/stores/panel', () => ({
  usePanelStore: () => ({ panels: [], activePanelId: 'root', focusedSessionId: null }),
}))

import { useConnection } from '@/composables/useConnection'

describe('useConnection 远程 WS 断开收口（finalizeAllStreaming）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStateRef.value = 'disconnected'
    isRemoteModeSpy.mockReturnValue(false)
    // init 在 VITE_MOCK='true' 时走 mock 分支提前 return，不安装 watch getState。
    // 本测试需触发 watch，故 stub VITE_MOCK 为空串走非 mock 路径。
    vi.stubEnv('VITE_MOCK', '')
  })

  it('TC1: 远程模式 connected→disconnected 触发 finalizeAllStreaming(disconnect)', async () => {
    isRemoteModeSpy.mockReturnValue(true)
    const { init, teardown } = useConnection()
    await init()

    // 先到 connected，再断到 disconnected（每步 await nextTick 让 watch 跑）
    mockStateRef.value = 'connecting'
    await nextTick()
    mockStateRef.value = 'connected'
    await nextTick()
    // 清掉之前的调用计数，专注验断开分支
    finalizeAllStreamingSpy.mockClear()
    mockStateRef.value = 'disconnected'
    await nextTick()

    expect(finalizeAllStreamingSpy).toHaveBeenCalledOnce()
    expect(finalizeAllStreamingSpy).toHaveBeenCalledWith('disconnect')
    teardown()
  })

  it('TC2: 本地模式 connected→disconnected 不触发 finalizeAllStreaming（IPC listener 兜底，避免双重）', async () => {
    // 本地模式（默认 isRemoteModeSpy=false）
    const { init, teardown } = useConnection()
    await init()

    mockStateRef.value = 'connecting'
    await nextTick()
    mockStateRef.value = 'connected'
    await nextTick()
    finalizeAllStreamingSpy.mockClear()
    mockStateRef.value = 'disconnected'
    await nextTick()

    // 本地模式：state watch 不调 finalizeAllStreaming（由 onRuntimeFailed IPC listener 兜底）
    expect(finalizeAllStreamingSpy).not.toHaveBeenCalled()
    teardown()
  })

  it('TC3: 远程模式 connected→reconnecting 也触发 finalize（任意 not-connected 均收口）', async () => {
    isRemoteModeSpy.mockReturnValue(true)
    const { init, teardown } = useConnection()
    await init()

    mockStateRef.value = 'connecting'
    await nextTick()
    mockStateRef.value = 'connected'
    await nextTick()
    finalizeAllStreamingSpy.mockClear()
    // 短断线进入 reconnecting（ws-client 自动重连）——仍是 not-connected，streaming 必须收口
    mockStateRef.value = 'reconnecting'
    await nextTick()

    expect(finalizeAllStreamingSpy).toHaveBeenCalledOnce()
    expect(finalizeAllStreamingSpy).toHaveBeenCalledWith('disconnect')
    teardown()
  })
})
