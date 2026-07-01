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
import { connect, disconnect, getState, setRestarting, setFailed } from '../lib/ws-client'
import {
  getRuntimePort,
  getRuntimePortOffset,
  onRuntimePort,
  onRuntimeRestarting,
  onRuntimeFailed,
  restartRuntime,
} from '../lib/ipc'
import { BASE_PORT, DEV_PORT_OFFSET } from '@xyz-agent/shared'
import type { ServerMessage } from '@xyz-agent/shared'
import * as transport from '../api/transport'
import * as pending from '../api/pending'
import * as events from '../api/events'

export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'restarting'
  | 'failed'

/**
 * 入站消息分发器（features 层串联 transport→pending/events 的唯一桥）。
 *
 * 对每条入站 ServerMessage：
 *   1. 若 msg.id 命中 pending → resolve（普通响应）/ reject（error envelope）
 *   2. 按 payload.sessionId 是否存在分流：
 *      - 有 sessionId → events.dispatchSession（session 通道，CLAUDE.md line 98 隔离）
 *      - 无 sessionId → events.dispatchGlobal（global 通道，config.* 及 model.list 等广播）
 *
 * session 隔离规则不变：session 级消息仍按 sessionId 路由；新增的是全局通道，
 * 承接 sendInitialState 推送的 7 条无 sessionId server-push（config.providers/model.list 等），
 * 不再静默丢弃。两通道互不串扰。
 */
function routeInbound(msg: ServerMessage): void {
  if (msg.id) {
    if (msg.type === 'error') {
      // type==='error' 已窄化 payload 为 error envelope（含 code + message）。
      // 透传 code 到 reject 的 Error（D-021：NodeState.reason 需要 error code 区分失败类型，
      // 如 out_of_cwd / permission_denied / timeout）。此前只透传 message 丢了 code。
      const payload = msg.payload as { code?: string; message?: string }
      const message = typeof payload.message === 'string' ? payload.message : 'request failed'
      const code = typeof payload.code === 'string' ? payload.code : 'unknown'
      pending.reject(msg.id, Object.assign(new Error(message), { code }))
    } else {
      pending.resolve(msg.id, msg.payload)
    }
  }
  // payload 跨多种 type：有的含 sessionId（session 通道），有的不含（global 通道）。
  // 联合类型无法直接 .sessionId，窄断言为可选字段做路由判定（CLAUDE.md line 98 隔离规则不变）。
  const sid = (msg.payload as { sessionId?: string }).sessionId
  if (typeof sid === 'string' && sid) {
    events.dispatchSession(sid, msg)
  } else {
    events.dispatchGlobal(msg)
  }
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
let removeRuntimeRestartingListener: (() => void) | null = null
let removeRuntimeFailedListener: (() => void) | null = null

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

    // mock 模式：走 mock，不需要端口发现，也不监听 runtime 崩溃事件（mock 无 runtime 进程）
    if (import.meta.env.VITE_MOCK === 'true') {
      connect('mock://localhost')
      return
    }

    // 监听 runtime 端口推送（runtime 重启成功后推新端口 → 断开重连）
    removeRuntimePortListener = onRuntimePort((newPort) => {
      if (newPort && state.value !== 'disconnected') {
        disconnect()
        connect('ws://localhost:' + newPort)
      }
    })

    // 监听 runtime 崩溃重启中（主进程正在拉起新实例 → 进 restarting 态，停自动重连）
    removeRuntimeRestartingListener = onRuntimeRestarting(() => {
      setRestarting()
    })

    // 监听 runtime 重启用尽（主进程放弃 → 进 failed 态，等用户手动重试）
    removeRuntimeFailedListener = onRuntimeFailed(() => {
      setFailed()
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

  /**
   * 手动重试（用户从「runtime 不可用」状态条点重试触发）。
   * 委托 IPC runtime-restart → 主进程 supervisor.restartRuntime。
   * supervisor 重启成功会广播 runtime-port（onRuntimePort 监听自动重连）。
   */
  async function retryRuntime(): Promise<void> {
    await restartRuntime()
  }

  function teardown(): void {
    if (removeRuntimePortListener) {
      removeRuntimePortListener()
      removeRuntimePortListener = null
    }
    if (removeRuntimeRestartingListener) {
      removeRuntimeRestartingListener()
      removeRuntimeRestartingListener = null
    }
    if (removeRuntimeFailedListener) {
      removeRuntimeFailedListener()
      removeRuntimeFailedListener = null
    }
    if (removeTransportListener) {
      removeTransportListener()
      removeTransportListener = null
    }
    dispatcherInstalled = false
    disconnect()
    initialised = false
  }

  return { state, init, teardown, retryRuntime }
}
