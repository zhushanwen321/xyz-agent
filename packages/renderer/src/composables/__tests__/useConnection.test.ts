/**
 * useConnection 远程分支改造测试（wave p1-s2-w2-useconnection-remote-branch）。
 *
 * 覆盖 5 个 TC：
 *  - TC1: init 远程分支调 connect 带 auth、IPC 监听未注册、端口发现跳过
 *  - TC2: init 本地分支维持现状（IPC 监听注册 + 端口发现、不传 auth）
 *  - TC3: retryRuntime 远程分支 disconnect + connect(activeProfile, {auth})
 *  - TC4: retryRuntime 本地分支维持现状（restartRuntime、不 disconnect/connect）
 *  - TC5: teardown 远程模式空检查兜底不抛（removeRuntimePortListener 恒 null）
 *
 * Mock 策略：
 *  - vi.mock('vue')：watch 为 no-op（避免 watcher 副作用 rejectAll 干扰断言）
 *  - vi.mock('../lib/ipc')：onRuntimePort/onRuntimeRestarting/onRuntimeFailed 返回卸载 spy，
 *    getRuntimePort/getRuntimePortOffset/restartRuntime 为 spy
 *  - vi.mock('../lib/ws-client')：connect/disconnect/setRestarting/setFailed 为 spy，
 *    getState 返回固定 readonly ref
 *  - vi.mock('../lib/remote/connection-config')：isRemoteMode 可切换、getActiveProfile/getClientId/getDeviceName 返固定值
 *  - vi.mock stores / transport / pending / events / handleCompletion：避免模块加载副作用
 *
 * VITE_MOCK 处理：vitest.config.ts 默认注入 VITE_MOCK='true'，会让 useConnection init 走 mock 分支
 * 早于远程分支 return。故 vi.stubEnv('VITE_MOCK','false') + 动态 import 在 stubEnv 之后加载
 * useConnection（与 ws-client.test.ts 同模式），确保 import.meta.env.VITE_MOCK 读到 'false'。
 *
 * 模块级状态隔离：useConnection.ts 的 removeRuntimePortListener / initialised 等是模块级私有变量，
 * 跨用例残留会污染断言。每用例 beforeEach 用 vi.resetModules + 动态 import 拿干净模块实例。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref, readonly } from 'vue'
import type { DeepReadonly, Ref } from 'vue'

// ── 共享 spy 引用（vi.mock 工厂在文件顶层执行，spy 必须在此声明供工厂引用）──
const connectSpy = vi.fn()
const disconnectSpy = vi.fn()
const setRestartingSpy = vi.fn()
const setFailedSpy = vi.fn()
const onRuntimePortSpy = vi.fn(() => vi.fn())
const onRuntimeRestartingSpy = vi.fn(() => vi.fn())
const onRuntimeFailedSpy = vi.fn(() => vi.fn())
const getRuntimePortSpy = vi.fn(() => Promise.resolve(0))
const getRuntimePortOffsetSpy = vi.fn(() => Promise.resolve(undefined))
const restartRuntimeSpy = vi.fn(() => Promise.resolve())
const isRemoteModeSpy = vi.fn(() => false)
const getActiveProfileSpy = vi.fn(() => null)
const getClientIdSpy = vi.fn(() => 'cid-fixed')
const getDeviceNameSpy = vi.fn(() => 'dev-fixed')
// 固定 connectionState ref（getState 返回 readonly 包装）
const stateRef = ref<'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'restarting' | 'failed'>('disconnected')

// ── Mock vue：watch / readonly 为 no-op 透传（避免 watcher 副作用）──
// 保留 ref 给 mock 的 ws-client getState 用。watch 必须桩——useConnection init 会 watch(getState())。
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
  setRestarting: setRestartingSpy,
  setFailed: setFailedSpy,
}))

// ── Mock ipc ──
vi.mock('../../lib/ipc', () => ({
  getRuntimePort: getRuntimePortSpy,
  getRuntimePortOffset: getRuntimePortOffsetSpy,
  onRuntimePort: onRuntimePortSpy,
  onRuntimeRestarting: onRuntimeRestartingSpy,
  onRuntimeFailed: onRuntimeFailedSpy,
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
vi.mock('../../stores/extension-ui', () => ({ useExtensionUIStore: () => ({ clearAllPending: vi.fn() }) }))
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

/** 动态 import useConnection（在 stubEnv + resetModules 之后），拿干净模块实例。 */
async function loadUseConnection(): Promise<{ useConnection: () => { init: () => Promise<void>; retryRuntime: () => Promise<void>; teardown: () => void } }> {
  return await import('../useConnection')
}

beforeEach(async () => {
  // 重置模块缓存：让 useConnection 模块级私有变量（removeRuntimePortListener/initialised 等）重新初始化
  vi.resetModules()
  // VITE_MOCK='false'：让 useConnection 跳过 mock 分支触达远程/本地分支（必须在动态 import 前 stub）
  vi.stubEnv('VITE_MOCK', 'false')
  // 清空所有 spy 调用记录（不重置 mockReturnValue——isRemoteMode 等在各 TC 内单独设）
  connectSpy.mockClear()
  disconnectSpy.mockClear()
  setRestartingSpy.mockClear()
  setFailedSpy.mockClear()
  onRuntimePortSpy.mockClear()
  onRuntimeRestartingSpy.mockClear()
  onRuntimeFailedSpy.mockClear()
  getRuntimePortSpy.mockClear()
  getRuntimePortOffsetSpy.mockClear()
  restartRuntimeSpy.mockClear()
  isRemoteModeSpy.mockClear()
  getActiveProfileSpy.mockClear()
  getClientIdSpy.mockClear()
  getDeviceNameSpy.mockClear()
  // 默认本地模式 + 无 active profile（各 TC 按需覆盖）
  isRemoteModeSpy.mockReturnValue(false)
  getActiveProfileSpy.mockReturnValue(null)
  // getRuntimePort 默认返回 0（无已知端口）→ 本地分支走 fallback
  getRuntimePortSpy.mockResolvedValue(0)
})

describe('useConnection 远程分支', () => {
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
    // IPC 监听三个均未注册（远程分支跳过）
    expect(onRuntimePortSpy).not.toHaveBeenCalled()
    expect(onRuntimeRestartingSpy).not.toHaveBeenCalled()
    expect(onRuntimeFailedSpy).not.toHaveBeenCalled()
    // 端口发现跳过
    expect(getRuntimePortSpy).not.toHaveBeenCalled()
  })

  it('TC2: init 本地分支维持现状（IPC 监听注册 + 端口发现、不传 auth）', async () => {
    // 已知端口场景：getRuntimePort 返回 54321 → connectWs('ws://localhost:54321')
    getRuntimePortSpy.mockResolvedValue(54321)

    const { useConnection } = await loadUseConnection()
    const conn = useConnection()
    await conn.init()

    // connect 被调用 1 次，参数 = ['ws://localhost:54321']（无第二参数）
    expect(connectSpy).toHaveBeenCalledOnce()
    expect(connectSpy).toHaveBeenCalledWith('ws://localhost:54321')
    // 三个 IPC 监听各注册 1 次
    expect(onRuntimePortSpy).toHaveBeenCalledOnce()
    expect(onRuntimeRestartingSpy).toHaveBeenCalledOnce()
    expect(onRuntimeFailedSpy).toHaveBeenCalledOnce()
    // 端口发现被调用 1 次
    expect(getRuntimePortSpy).toHaveBeenCalledOnce()
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
    // restartRuntime IPC 未调用（远程不走本地 supervisor）
    expect(restartRuntimeSpy).not.toHaveBeenCalled()
  })

  it('TC4: retryRuntime 本地分支维持现状（restartRuntime、不 disconnect/connect）', async () => {
    const { useConnection } = await loadUseConnection()
    const conn = useConnection()
    await conn.retryRuntime()

    // restartRuntime 被调用 1 次
    expect(restartRuntimeSpy).toHaveBeenCalledOnce()
    // 不主动 disconnect / connect（本地靠 onRuntimePort 广播新端口重连）
    expect(disconnectSpy).not.toHaveBeenCalled()
    expect(connectSpy).not.toHaveBeenCalled()
  })

  it('TC5: teardown 远程模式空检查兜底不抛（removeRuntimePortListener 恒 null）', async () => {
    isRemoteModeSpy.mockReturnValue(true)
    getActiveProfileSpy.mockReturnValue(REMOTE_PROFILE)

    const { useConnection } = await loadUseConnection()
    const conn = useConnection()
    // 远程 init（IPC 监听未注册 → removeRuntimePortListener 恒 null）
    await conn.init()
    // teardown 不应抛（空检查 if(x){x();x=null} 自动跳过 null listener）
    expect(() => conn.teardown()).not.toThrow()
    // disconnect 被调用（teardown 末尾断开）
    expect(disconnectSpy).toHaveBeenCalled()
  })
})
