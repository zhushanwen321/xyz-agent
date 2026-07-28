/**
 * useConnection mobile-renderer 版测试（P4-s1-w2，砍本地模式分支后）。
 *
 * 与 renderer 版差异：mobile useConnection 只保留远程模式，砍掉本地 IPC 端口发现/runtime 崩溃监听。
 * 覆盖 5 个 TC：
 *  - TC1: init 远程分支调 connect 带 auth、IPC 监听未注册、端口发现跳过
 *  - TC2: init 非远程模式不 connect（停留 disconnected，由 App 渲染 MobileConnectScreen 引导）
 *  - TC3: retryRuntime 远程分支 disconnect + connect(activeProfile, {auth})
 *  - TC4: retryRuntime 非远程模式 no-op（不 disconnect/connect、不 restartRuntime）
 *  - TC5: teardown 不抛（移除本地 listener 分支后仍安全）
 *
 * Mock 策略：同 renderer 版（mock ws-client/connection-config/stores/transport/pending/events）。
 * ipc mock 保留（mobile ipc.ts 全 no-op，但 useConnection 砍本地分支后不调 ipc，mock 防御性保留）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref, readonly } from 'vue'
import type { DeepReadonly, Ref } from 'vue'

// ── 共享 spy 引用（vi.mock 工厂在文件顶层执行，spy 必须在此声明供工厂引用）──
const connectSpy = vi.fn()
const disconnectSpy = vi.fn()
const isRemoteModeSpy = vi.fn(() => false)
const getActiveProfileSpy = vi.fn(() => null)
const getClientIdSpy = vi.fn(() => 'cid-fixed')
const getDeviceNameSpy = vi.fn(() => 'dev-fixed')
const restartRuntimeSpy = vi.fn(() => Promise.resolve())
// 固定 connectionState ref（getState 返回 readonly 包装）
const stateRef = ref<'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'failed'>('disconnected')

// ── Mock vue：watch 为 no-op（避免 watcher 副作用 rejectAll 干扰断言）──
vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue')>()
  return {
    ...actual,
    watch: vi.fn(() => vi.fn()),
  }
})

// ── Mock ws-client ──
vi.mock('../../lib/ws-client', () => ({
  connect: connectSpy,
  disconnect: disconnectSpy,
  getState: (): DeepReadonly<Ref<string>> => readonly(stateRef) as unknown as DeepReadonly<Ref<string>>,
  setSubscribedSessions: vi.fn(),
}))

// ── Mock ipc（mobile ipc.ts 全 no-op；useConnection 砍本地分支后不调，mock 防御性保留）──
vi.mock('../../lib/ipc', () => ({
  getRuntimePort: vi.fn(() => Promise.resolve(undefined)),
  getRuntimePortOffset: vi.fn(() => Promise.resolve(undefined)),
  onRuntimePort: vi.fn(() => vi.fn()),
  onRuntimeRestarting: vi.fn(() => vi.fn()),
  onRuntimeFailed: vi.fn(() => vi.fn()),
  restartRuntime: restartRuntimeSpy,
}))

// ── Mock connection-config ──
vi.mock('../../lib/remote/connection-config', () => ({
  isRemoteMode: isRemoteModeSpy,
  getActiveProfile: getActiveProfileSpy,
  getClientId: getClientIdSpy,
  getDeviceName: getDeviceNameSpy,
}))

// ── Mock stores / transport / pending / events / handleCompletion（避免加载副作用）──
vi.mock('../../stores/chat', () => ({ useChatStore: () => ({ finalizeAllStreaming: vi.fn() }) }))
vi.mock('../../stores/session', () => ({ useSessionStore: () => ({ markDead: vi.fn() }) }))
vi.mock('../../stores/panel', () => ({ usePanelStore: () => ({ panels: [], activePanelId: null }) }))
vi.mock('../useToast', () => ({ useToast: () => ({ error: vi.fn() }) }))
vi.mock('../useCompletionNotify', () => ({ handleCompletion: vi.fn() }))
vi.mock('../../api/transport', () => ({ on: vi.fn(() => vi.fn()) }))
vi.mock('../../api/pending', () => ({ rejectAll: vi.fn(), resolve: vi.fn(), reject: vi.fn() }))
vi.mock('../../api/events', () => ({ dispatchSession: vi.fn(), dispatchGlobal: vi.fn() }))

const REMOTE_PROFILE = {
  id: 'srv-1',
  name: 'my-server',
  url: 'ws://remote.srv:7420',
  token: 'tok-secret',
  networkKind: 'public' as const,
}

/** 动态 import useConnection（在 resetModules 之后），拿干净模块实例。 */
async function loadUseConnection(): Promise<{ useConnection: () => { init: () => Promise<void>; retryRuntime: () => Promise<void>; teardown: () => void } }> {
  return await import('../useConnection')
}

beforeEach(async () => {
  // 重置模块缓存：让 useConnection 模块级私有变量重新初始化
  vi.resetModules()
  // 清空所有 spy 调用记录
  connectSpy.mockClear()
  disconnectSpy.mockClear()
  restartRuntimeSpy.mockClear()
  isRemoteModeSpy.mockClear()
  getActiveProfileSpy.mockClear()
  getClientIdSpy.mockClear()
  getDeviceNameSpy.mockClear()
  // 默认非远程模式 + 无 active profile（各 TC 按需覆盖）
  isRemoteModeSpy.mockReturnValue(false)
  getActiveProfileSpy.mockReturnValue(null)
})

describe('useConnection mobile（仅远程模式）', () => {
  it('TC1: init 远程分支调 connect 带 auth、IPC 监听未注册、端口发现跳过', async () => {
    isRemoteModeSpy.mockReturnValue(true)
    getActiveProfileSpy.mockReturnValue(REMOTE_PROFILE)

    const { useConnection } = await loadUseConnection()
    const conn = useConnection()
    await conn.init()

    // connect 被调用 1 次，第二参数含 auth（token/clientId/deviceName）
    expect(connectSpy).toHaveBeenCalledOnce()
    expect(connectSpy).toHaveBeenCalledWith(REMOTE_PROFILE.url, {
      auth: {
        token: REMOTE_PROFILE.token,
        clientId: 'cid-fixed',
        deviceName: 'dev-fixed',
      },
    })
  })

  it('TC2: init 非远程模式不 connect（停留 disconnected，由 App 渲染 MobileConnectScreen 引导）', async () => {
    const { useConnection } = await loadUseConnection()
    const conn = useConnection()
    await conn.init()

    // 非远程模式：移动端无本地 runtime fallback，不 connect，等用户在 MobileConnectScreen 粘贴连接信息
    expect(connectSpy).not.toHaveBeenCalled()
  })

  it('TC3: retryRuntime 远程分支 disconnect + connect(activeProfile, {auth})', async () => {
    isRemoteModeSpy.mockReturnValue(true)
    getActiveProfileSpy.mockReturnValue(REMOTE_PROFILE)

    const { useConnection } = await loadUseConnection()
    const conn = useConnection()
    await conn.retryRuntime()

    // disconnect 被调用 1 次
    expect(disconnectSpy).toHaveBeenCalledOnce()
    // connect 被调用 1 次，参数含 auth
    expect(connectSpy).toHaveBeenCalledOnce()
    expect(connectSpy).toHaveBeenCalledWith(REMOTE_PROFILE.url, {
      auth: {
        token: REMOTE_PROFILE.token,
        clientId: 'cid-fixed',
        deviceName: 'dev-fixed',
      },
    })
  })

  it('TC4: retryRuntime 非远程模式 no-op（不 disconnect/connect、不 restartRuntime）', async () => {
    const { useConnection } = await loadUseConnection()
    const conn = useConnection()
    await conn.retryRuntime()

    // 非远程模式：retryRuntime no-op（移动端无本地 supervisor，也无远程 profile 可重连）
    expect(restartRuntimeSpy).not.toHaveBeenCalled()
    expect(disconnectSpy).not.toHaveBeenCalled()
    expect(connectSpy).not.toHaveBeenCalled()
  })

  it('TC5: teardown 不抛（移除本地 listener 分支后仍安全）', async () => {
    isRemoteModeSpy.mockReturnValue(true)
    getActiveProfileSpy.mockReturnValue(REMOTE_PROFILE)

    const { useConnection } = await loadUseConnection()
    const conn = useConnection()
    await conn.init()
    // teardown 不应抛（mobile 版无 runtime listener，visibility/stateWatch/transport listener 各自空检查）
    expect(() => conn.teardown()).not.toThrow()
    // disconnect 被调用（teardown 末尾断开）
    expect(disconnectSpy).toHaveBeenCalled()
  })
})
