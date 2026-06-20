/**
 * useConnection —— 连接生命周期编排。
 *
 * 职责：
 * - init()：发现 runtime 端口 → connect WS（mock 模式走 mock://）
 * - 监听 onRuntimePort（runtime 重启后推新端口 → 断开重连）
 * - teardown()：取消监听 + 断开
 *
 * 端口发现顺序：
 * 1. VITE_MOCK=true → connect('mock://')（ws-client 内部走 mockConnect）
 * 2. IPC getRuntimePort（main 已 spawn）→ connect(ws://localhost:port)
 * 3. fallback：BASE_PORT + offset（dev 模式 +DEV_PORT_OFFSET）
 *
 * 依赖方向：useConnection → ws-client + ipc + shared（BASE_PORT/DEV_PORT_OFFSET）
 */
import { connect, disconnect, getState } from '../lib/ws-client'
import { getRuntimePort, getRuntimePortOffset, onRuntimePort } from '../lib/ipc'
import { BASE_PORT, DEV_PORT_OFFSET } from '@xyz-agent/shared'

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

/** 获取 fallback 端口（考虑 dev 偏移） */
async function resolveFallbackPort(): Promise<number> {
  const offset = await getRuntimePortOffset()
  if (offset !== undefined) return BASE_PORT + offset
  // DEV 环境下 runtime 在 BASE_PORT+100，不能 fallback 到 prod 端口
  if (import.meta.env.DEV) return BASE_PORT + DEV_PORT_OFFSET
  return BASE_PORT
}

let initialised = false
let removeRuntimePortListener: (() => void) | null = null

export function useConnection() {
  const state = getState()

  async function init(): Promise<void> {
    if (initialised) {
      // HMR 后重连
      if (import.meta.env.VITE_MOCK !== 'true') {
        connect('ws://localhost:' + await resolveFallbackPort())
      }
      return
    }
    initialised = true

    // mock 模式：走 mock，不需要端口发现
    if (import.meta.env.VITE_MOCK === 'true') {
      connect('mock://localhost')
      return
    }

    // 监听 runtime 端口推送（runtime 重启后重连）
    removeRuntimePortListener = onRuntimePort((newPort) => {
      if (newPort && state.value !== 'disconnected') {
        disconnect()
        connect('ws://localhost:' + newPort)
      }
    })

    // 尝试从主进程获取已知端口
    const knownPort = await getRuntimePort()
    if (knownPort) {
      connect('ws://localhost:' + knownPort)
      return
    }

    // Runtime 尚未启动：用 fallback 端口（ws-client 会自动重连，runtime 起来后连上）
    connect('ws://localhost:' + await resolveFallbackPort())
  }

  function teardown(): void {
    if (removeRuntimePortListener) {
      removeRuntimePortListener()
      removeRuntimePortListener = null
    }
    disconnect()
    initialised = false
  }

  return { state, init, teardown }
}
