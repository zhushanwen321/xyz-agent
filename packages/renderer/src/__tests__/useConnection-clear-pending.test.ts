/**
 * CW wave `session-active-ssot` T5：runtime 重连清理 ask-user pending。
 *
 * 锁定改动：onRuntimeRestarting / onRuntimeFailed 分支除原有 finalizeAllStreaming 外，
 * 额外调用 extensionUIStore.clearAllPending()。原因：pi 进程死了之后 ask-user 的
 * extension.ui_request Promise 永远不会被 resolve（runtime 重启是全新实例），
 * 必须清空 pending，否则 UI 卡 waiting 态 + Promise 永挂。
 *
 * 注意：onRuntimePort（正常端口重连，pi 还活着）不清 pending。
 *
 * 覆盖（TC7）：
 * - onRuntimeRestarting → clearAllPending 被调
 * - onRuntimeFailed → clearAllPending 被调
 * - onRuntimePort（正常端口变化）→ clearAllPending 不被调（pi 还活着，pending 有效）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/useConnection-clear-pending.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref, type Ref } from 'vue'
import type { ConnectionState } from '@/lib/ws-client'

// ── ws-client mock：最小占位（init 需要）──────────────────────────────
const mockConnect = vi.fn()
const mockDisconnect = vi.fn()
let mockStateRef: Ref<ConnectionState> = ref('disconnected')
vi.mock('@/lib/ws-client', () => ({
  connect: (...args: unknown[]) => mockConnect(...args),
  disconnect: (...args: unknown[]) => mockDisconnect(...args),
  getState: () => mockStateRef,
  setRestarting: vi.fn(),
  setFailed: vi.fn(),
}))

// ── ipc mock：捕获 onRuntimeRestarting/onRuntimeFailed/onRuntimePort 注册的回调 ──
// 每个 onRuntime* 返回一个 unregister，同时把传入的 cb 暴露给测试触发。
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

// ── useToast mock（handleSessionExited 会调）─────────────────────────
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: vi.fn() }),
}))

// ── store mock：捕获 finalizeAllStreaming / clearAllPending 调用 ─────
const mockFinalizeAllStreaming = vi.fn()
vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({ finalizeAllStreaming: mockFinalizeAllStreaming, markSessionError: vi.fn() }),
}))
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ markDead: vi.fn() }),
}))
// T5 核心：spy extensionUIStore.clearAllPending
const mockClearAllPending = vi.fn()
vi.mock('@/stores/extension-ui', () => ({
  useExtensionUIStore: () => ({ clearAllPending: mockClearAllPending }),
}))

import { useConnection } from '@/composables/useConnection'

describe('T5: runtime 重连清理 ask-user pending（clearAllPending）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStateRef = ref('disconnected')
    restartingCb = null
    failedCb = null
    portCb = null
    // useConnection.init 在 VITE_MOCK='true' 时会走 mock 分支提前 return（L219），
    // 不注册 onRuntimePort/onRuntimeRestarting/onRuntimeFailed 监听。本测试需触发这些
    // 监听回调，故 stub VITE_MOCK 为空串，让 init 走非 mock 路径完成监听安装。
    vi.stubEnv('VITE_MOCK', '')
  })

  it('onRuntimeRestarting → clearAllPending 被调（pi 死了 ask-user Promise 永挂，必须清）', async () => {
    const { init, teardown } = useConnection()
    await init()
    expect(restartingCb).not.toBeNull()

    restartingCb!()
    expect(mockClearAllPending).toHaveBeenCalledTimes(1)
    // finalizeAllStreaming 也应被调（既有行为不回归）
    expect(mockFinalizeAllStreaming).toHaveBeenCalledTimes(1)
    teardown()
  })

  it('onRuntimeFailed → clearAllPending 被调（runtime 重启用尽，pending 同样永挂）', async () => {
    const { init, teardown } = useConnection()
    await init()
    expect(failedCb).not.toBeNull()

    failedCb!()
    expect(mockClearAllPending).toHaveBeenCalledTimes(1)
    expect(mockFinalizeAllStreaming).toHaveBeenCalledTimes(1)
    teardown()
  })

  it('onRuntimePort（正常端口变化）→ clearAllPending 不被调（pi 还活着，pending 有效）', async () => {
    const { init, teardown } = useConnection()
    await init()
    expect(portCb).not.toBeNull()

    // 模拟 runtime 重启成功推新端口（state 非 disconnected 才会重连，但清理与 connect 无关）
    mockStateRef.value = 'connected'
    portCb!(9999)
    // 关键断言：正常端口重连不清 pending
    expect(mockClearAllPending).not.toHaveBeenCalled()
    teardown()
  })
})
