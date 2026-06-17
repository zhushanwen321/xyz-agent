import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { nextTick, type Ref } from 'vue'

/**
 * Phase-5 guardrails 5.2：D1 启动时序契约（renderer 侧）+ G5 重连收尾。
 *
 * useConnection 是 renderer 侧 runtime 端口重连 + G5 信号的唯一编排点：
 *   - D1：onRuntimePort 推新端口（runtime 重启）→ disconnect + connect 新 url
 *   - G5：连接状态 reconnecting→connected → api.events._notifyConnectionRestored()
 *
 * mock 策略：ws-client.getState 返回可响应 ref（async factory + hoisted holder），
 * 让 useConnection 的 watch(getState(), ...) 能被状态变化触发。
 */

// holder 持有 factory 创建的 ref 单例；factory 是 async（await import('vue')），
// 在 useConnection 模块加载时执行一次，it 执行时 holder.connRef 已就绪。
const holder = vi.hoisted(() => ({ connRef: null as Ref<string> | null }))
// vi.hoisted 的 vi.fn：mock factory 引用同一实例，测试中可断言调用。
const ws = vi.hoisted(() => ({ connect: vi.fn(), disconnect: vi.fn() }))
const notify = vi.hoisted(() => vi.fn())

vi.mock('../../lib/ws-client', async () => {
  const { ref } = await import('vue')
  holder.connRef = ref<string>('disconnected')
  return {
    connect: ws.connect,
    disconnect: ws.disconnect,
    getState: () => holder.connRef!,
  }
})

vi.mock('../../api', () => {
  // runtimePort 经 window.electronAPI 读取（模拟真实 singleton 经 IpcTransport 绑定）。
  // 测试在 beforeAll 注入 window.electronAPI 后，runtimePort 方法才能取到值。
  const ipc = () => (window as unknown as { electronAPI?: unknown }).electronAPI as
    | { onRuntimePort?: Function; getRuntimePort?: Function; getRuntimePortOffset?: Function }
    | undefined
  return {
    api: {
      events: { _notifyConnectionRestored: notify },
      runtimePort: {
        getPort: () => ipc()?.getRuntimePort?.(),
        getPortOffset: () => ipc()?.getRuntimePortOffset?.(),
        onPort: (cb: (port: number) => void) => ipc()?.onRuntimePort?.(cb) ?? (() => {}),
        onError: () => () => {},
      },
    },
  }
})

let onRuntimePortCb: ((port: number) => void) | null = null

beforeAll(async () => {
  // 触发 ws-client mock 的 async factory（await import('vue') 建 ref），让 holder.connRef 就绪。
  await import('../useConnection')
  // happy-dom 提供 window；注入 electronAPI（preload 契约的最小实现）。
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    onRuntimePort: (cb: (port: number) => void) => {
      onRuntimePortCb = cb
      return () => {
        onRuntimePortCb = null
      }
    },
    getRuntimePort: vi.fn().mockResolvedValue(null),
    getRuntimePortOffset: vi.fn().mockResolvedValue(0),
  }
})

describe('useConnection — D1 runtime 端口重连 + G5 收尾信号', () => {
  beforeEach(() => {
    ws.connect.mockClear()
    ws.disconnect.mockClear()
    notify.mockClear()
    holder.connRef!.value = 'disconnected'
  })

  it('G5：状态 reconnecting→connected 触发 _notifyConnectionRestored；其他转换不触发', async () => {
    const { useConnection } = await import('../useConnection')
    const { init } = useConnection()
    await init() // 首次 init：注册 watch + onRuntimePort listener + fallback connect

    // connected（但非来自 reconnecting）不应触发
    holder.connRef!.value = 'connected'
    await nextTick()
    expect(notify).not.toHaveBeenCalled()

    // 进入 reconnecting，再回到 connected → 触发一次
    holder.connRef!.value = 'reconnecting'
    await nextTick()
    holder.connRef!.value = 'connected'
    await nextTick()
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('D1：onRuntimePort 推新端口（state 非 disconnected）→ disconnect + connect 新 url', async () => {
    // 复用上一 case 的 init 注册的 listener（onRuntimePortCb 已就绪）
    holder.connRef!.value = 'connected'
    expect(onRuntimePortCb).not.toBeNull()
    onRuntimePortCb!(4000)
    expect(ws.disconnect).toHaveBeenCalledTimes(1)
    expect(ws.connect).toHaveBeenCalledWith('ws://localhost:4000')
  })

  it('D1：state=disconnected 时 onRuntimePort 不重连（避免连接已断还触发）', () => {
    holder.connRef!.value = 'disconnected'
    expect(onRuntimePortCb).not.toBeNull()
    onRuntimePortCb!(5000)
    expect(ws.disconnect).not.toHaveBeenCalled()
    expect(ws.connect).not.toHaveBeenCalledWith('ws://localhost:5000')
  })
})
