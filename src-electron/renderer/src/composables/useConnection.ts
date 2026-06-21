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
import type { ServerMessage } from '@xyz-agent/shared'
import * as transport from '../api/transport'
import * as pending from '../api/pending'
import * as events from '../api/events'

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

/**
 * 入站消息分发器（features 层串联 transport→pending/events 的唯一桥）。 [HISTORICAL]
 *
 * ws-client.onMessage 是单槽回调，零调用方时渲染层退化为「只写不读」：
 * pending.resolve/reject 永不触发 → await chatApi.send/getHistory/abort 永挂；
 * events.dispatch 永不触发 → streamSubscribe handler 永不触发。
 *
 * 本函数对每条入站 ServerMessage：
 *   1. 若 msg.id 命中 pending → resolve（普通响应）/ reject（error envelope）
 *   2. 按 payload.sessionId 派发到 events（触发 streamSubscribe handler）
 * 两者独立：一条 message.status 既 resolve send 的 pending，又安全地走 dispatch（store 无此 case→no-op）。
 */
function routeInbound(msg: ServerMessage): void {
  if (msg.id) {
    if (msg.type === 'error') {
      const message = typeof msg.payload?.message === 'string' ? msg.payload.message : 'request failed'
      pending.reject(msg.id, new Error(message))
    } else {
      pending.resolve(msg.id, msg.payload)
    }
  }
  const sid = typeof msg.payload?.sessionId === 'string' ? msg.payload.sessionId : undefined
  if (sid) events.dispatch(sid, msg)
}

let dispatcherInstalled = false
let removeTransportListener: (() => void) | null = null

/** 安装入站分发器（幂等：仅安装一次）。transport.on 占用 ws-client 单槽 onMessage。 */
function ensureDispatcher(): void {
  if (dispatcherInstalled) return
  dispatcherInstalled = true
  removeTransportListener = transport.on(routeInbound)
}

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
    // 入站消息分发器在任何模式下都安装（mock 模式仅收到 pong，无副作用）
    ensureDispatcher()

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
    if (removeTransportListener) {
      removeTransportListener()
      removeTransportListener = null
    }
    dispatcherInstalled = false
    disconnect()
    initialised = false
  }

  return { state, init, teardown }
}
