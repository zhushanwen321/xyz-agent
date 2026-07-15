/**
 * useConnection 可见性切换回归测试（W4）。
 *
 * 锁定 W4 改动：当用户从其它标签页 / 系统切回应用（document.visibilityState 变为
 * 'visible'）且当前 WS 未连接时，useConnection 应主动调用 connect() 尝试重连，
 * 而不是干等 ws-client 的指数退避（最长 30s）—— 用户回来后还想看对话进展。
 *
 * 当前实现问题：useConnection.init() 不监听 document 的 visibilitychange 事件，
 * 切回应用后即使连接已断也不会主动重连。
 *
 * 预期（W4 后）：init() 安装 visibilitychange 监听；teardown() 卸载。
 * 以下断言在 W4 未实现前应全部红灯。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/useConnection-visibility.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ref, type Ref } from 'vue'
import type { ConnectionState } from '@/lib/ws-client'

// ── ws-client mock：捕获 connect 调用 + 可控 state ref ──────────────
const mockConnect = vi.fn()
const mockDisconnect = vi.fn()
// 默认 disconnected；每个测试可改 mockStateRef.value 模拟当前连接态
let mockStateRef: Ref<ConnectionState> = ref('disconnected')

vi.mock('@/lib/ws-client', () => ({
  connect: (...args: unknown[]) => mockConnect(...args),
  disconnect: (...args: unknown[]) => mockDisconnect(...args),
  // getState 返回 readonly ref，但测试里通过改 mockStateRef.value 模拟状态变化
  getState: () => mockStateRef,
  setRestarting: vi.fn(),
  setFailed: vi.fn(),
}))

// ── ipc mock：全部返回空（init 会调 getRuntimePort 等）──────────────
vi.mock('@/lib/ipc', () => ({
  getRuntimePort: vi.fn().mockResolvedValue(undefined),
  getRuntimePortOffset: vi.fn().mockResolvedValue(undefined),
  onRuntimePort: vi.fn().mockReturnValue(() => {}),
  onRuntimeRestarting: vi.fn().mockReturnValue(() => {}),
  onRuntimeFailed: vi.fn().mockReturnValue(() => {}),
  restartRuntime: vi.fn().mockResolvedValue(undefined),
}))

// ── transport / pending / events mock：init 安装分发器时需要 ─────────
vi.mock('@/api/transport', () => ({
  on: vi.fn().mockReturnValue(() => {}),
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

// ── useToast mock：handleSessionExited 会调 ──────────────────────────
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: vi.fn() }),
}))

import { useConnection } from '@/composables/useConnection'

describe('useConnection 可见性切换主动重连（W4）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStateRef = ref('disconnected')
  })
  afterEach(() => {
    // 清掉可能残留的 visibilitychange 监听（每个测试 init 后会 teardown）
    document.removeEventListener('visibilitychange', () => {})
    document.visibilityState // 触发一次读，无害
  })

  it('切回应用（visible）且未连接时 → connect 被调用', async () => {
    const { init, teardown } = useConnection()
    await init()

    // 当前处于 disconnected（模拟标签页后台时连接掉了）
    mockStateRef.value = 'disconnected'
    mockConnect.mockClear()

    // W4：init 应已注册 visibilitychange 监听。模拟切回前台。
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
    document.dispatchEvent(new Event('visibilitychange'))

    // 关键断言：切回可见 + 未连接 → 主动重连（当前无 visibilitychange 处理，红灯预期）
    expect(mockConnect).toHaveBeenCalled()

    teardown()
    // 还原 visibilityState，避免污染后续测试
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
  })

  it('切回应用（visible）但已 connected 时 → connect 不被调用', async () => {
    const { init, teardown } = useConnection()
    await init()

    // 当前已连接（不需要重连）
    mockStateRef.value = 'connected'
    mockConnect.mockClear()

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
    document.dispatchEvent(new Event('visibilitychange'))

    // 关键断言：已连接就不重连（这条测守卫正确性，W4 实现后应通过）
    expect(mockConnect).not.toHaveBeenCalled()

    teardown()
  })

  it('切到后台（hidden）时 → 不触发重连（只有切回 visible 才重连）', async () => {
    const { init, teardown } = useConnection()
    await init()

    mockStateRef.value = 'disconnected'
    mockConnect.mockClear()

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    })
    document.dispatchEvent(new Event('visibilitychange'))

    // 关键断言：切后台不应触发重连（避免无谓连接触发）
    expect(mockConnect).not.toHaveBeenCalled()

    teardown()
    // 还原
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
  })
})
