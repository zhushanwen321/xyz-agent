/**
 * P3 解耦残留 minor-1：onSessionExit 清缓存的直接测试。
 *
 * 背景：P3 spec §2.1（T1 审计）要求 session 退出/pi 进程死亡时清 pending 缓存，
 * 否则孤儿请求会随 sendInitialState 第 14 段反复推给新连接。useConnection 中
 * onRuntimeRestarting / onRuntimeFailed（runtime 崩溃 = pi 子进程没了）回调调
 * extensionUIStore.clearAllPending() 清缓存。
 *
 * 现有 useConnection-clear-pending.test.ts 把整个 extension-ui store mock 掉，
 * 只断言 clearAllPending 这个 spy 被调——是间接覆盖，无法证明真实的 pending 缓存
 *（requestsBySession Map）确实被清空。本文件补直接覆盖：用真实 store（pinia），
 * 预填缓存 → 触发回调 → 断言真实 Map 已清空（直接证据，非 spy 调用计数）。
 *
 * 覆盖：
 * - onRuntimeRestarting → 真实 requestsBySession Map 清空（多 session 分区全清）
 * - onRuntimeFailed → 真实 requestsBySession Map 清空
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/useConnection-clear-pending-direct.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref, type Ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { ConnectionState } from '@/lib/ws-client'

// ── ws-client mock（init 需要）──────────────────────────────────────
const mockConnect = vi.fn()
const mockDisconnect = vi.fn()
let mockStateRef: Ref<ConnectionState> = ref('disconnected')
vi.mock('@/lib/ws-client', () => ({
  connect: (...args: unknown[]) => mockConnect(...args),
  disconnect: (...args: unknown[]) => mockDisconnect(...args),
  getState: () => mockStateRef,
  setRestarting: vi.fn(),
  setFailed: vi.fn(),
  setSubscribedSessions: vi.fn(),
}))

// ── ipc mock：捕获 onRuntimeRestarting/onRuntimeFailed/onRuntimePort 注册的回调 ──
let restartingCb: (() => void) | null = null
let failedCb: (() => void) | null = null
let portCb: ((port: number) => void) | null = null
vi.mock('@/lib/ipc', () => ({
  getRuntimePort: vi.fn().mockResolvedValue(undefined),
  getRuntimePortOffset: vi.fn().mockResolvedValue(undefined),
  onRuntimePort: (cb: (port: number) => void) => {
    portCb = cb
    return () => { portCb = null }
  },
  onRuntimeRestarting: (cb: () => void) => {
    restartingCb = cb
    return () => { restartingCb = null }
  },
  onRuntimeFailed: (cb: () => void) => {
    failedCb = cb
    return () => { failedCb = null }
  },
  restartRuntime: vi.fn().mockResolvedValue(undefined),
}))

// ── transport / pending / events mock：init 安装分发器时需要 ─────────
vi.mock('@/api/transport', () => ({
  on: () => () => {},
}))
vi.mock('@/api/pending', () => ({
  rejectAll: vi.fn(),
  resolve: vi.fn(),
  reject: vi.fn(),
}))
vi.mock('@/api/events', () => ({
  dispatchSession: vi.fn(),
  dispatchGlobal: vi.fn(),
}))

// ── useToast mock（handleSessionExited 会调）─────────────────────────
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: vi.fn() }),
}))

// ── 其他 store mock：chat/session/panel 仍 mock（本测试只关注 extension-ui）──
vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({ finalizeAllStreaming: vi.fn(), markSessionError: vi.fn() }),
}))
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ markDead: vi.fn() }),
}))
vi.mock('@/stores/panel', () => ({
  usePanelStore: () => ({ panels: [], activePanelId: 'root', focusedSessionId: null }),
}))
// 注：故意 NOT mock '@/stores/extension-ui' ——用真实 store + pinia，验证缓存真被清空。

import { useConnection } from '@/composables/useConnection'
import { useExtensionUIStore } from '@/stores/extension-ui'

describe('P3 minor-1: onSessionExit 清缓存直接测试（真实 store）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStateRef = ref('disconnected')
    restartingCb = null
    failedCb = null
    portCb = null
    // 真实 store 需要 active pinia
    setActivePinia(createPinia())
    // useConnection.init 在 VITE_MOCK='true' 时走 mock 分支提前 return，
    // 不注册 onRuntime* 监听。stub 为空串走非 mock 路径完成监听安装。
    vi.stubEnv('VITE_MOCK', '')
  })

  it('onRuntimeRestarting → 真实 requestsBySession Map 被清空（多 session 分区全清）', async () => {
    const store = useExtensionUIStore()
    // 预填缓存：两个 session 各有 pending（含 ask-user 富交互 + dialog 原语）
    store.addRequest('sess-A', { sessionId: 'sess-A', requestId: 'r-a', method: 'select', askUser: true })
    store.addRequest('sess-B', { sessionId: 'sess-B', requestId: 'r-b', method: 'confirm' })
    // 直接证据前置：缓存非空
    expect(store.requestsBySession.size).toBe(2)
    expect(store.hasPendingAskUser('sess-A')).toBe(true)
    expect(store.hasPendingDialog('sess-B')).toBe(true)

    const { init, teardown } = useConnection()
    await init()
    expect(restartingCb).not.toBeNull()

    // 触发 runtime 崩溃回调（pi 进程没了 → pending Promise 永挂 → 必须清缓存）
    restartingCb!()

    // 直接证据：真实 Map 清空（非 spy 调用计数）
    expect(store.requestsBySession.size).toBe(0)
    expect(store.getRequestsBySession('sess-A')).toEqual([])
    expect(store.getRequestsBySession('sess-B')).toEqual([])
    expect(store.hasPendingAskUser('sess-A')).toBe(false)
    expect(store.hasPendingDialog('sess-B')).toBe(false)
    teardown()
  })

  it('onRuntimeFailed → 真实 requestsBySession Map 被清空（runtime 重启用尽）', async () => {
    const store = useExtensionUIStore()
    store.addRequest('sess-A', { sessionId: 'sess-A', requestId: 'r-a', method: 'input' })
    store.addRequest('sess-C', { sessionId: 'sess-C', requestId: 'r-c', method: 'select', askUser: true })
    expect(store.requestsBySession.size).toBe(2)

    const { init, teardown } = useConnection()
    await init()
    expect(failedCb).not.toBeNull()

    failedCb!()

    // 直接证据：真实 Map 清空
    expect(store.requestsBySession.size).toBe(0)
    expect(store.getRequestsBySession('sess-A')).toEqual([])
    expect(store.getRequestsBySession('sess-C')).toEqual([])
    expect(store.hasPendingAskUser('sess-C')).toBe(false)
    teardown()
  })

  it('onRuntimePort（正常端口变化）→ 真实缓存保留（pi 还活着，pending 有效）', async () => {
    const store = useExtensionUIStore()
    store.addRequest('sess-A', { sessionId: 'sess-A', requestId: 'r-a', method: 'select', askUser: true })
    expect(store.requestsBySession.size).toBe(1)

    const { init, teardown } = useConnection()
    await init()
    expect(portCb).not.toBeNull()

    mockStateRef.value = 'connected'
    portCb!(9999)

    // 正常端口重连不清 pending（pi 还活着，缓存仍有效）
    expect(store.requestsBySession.size).toBe(1)
    expect(store.hasPendingAskUser('sess-A')).toBe(true)
    teardown()
  })
})
