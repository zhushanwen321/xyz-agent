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
import { watch } from 'vue'
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
import { useChatStore } from '../stores/chat'
import { useSessionStore } from '../stores/session'
import { useToast } from './useToast'

/**
 * 处理 session.exited 事件（pi 进程异常退出）。
 *
 * 不能只依赖 session 通道的惰性订阅（ensureStreamSubscription 在首次 send 时建立）：
 * 进程可能在用户首次发消息前就死（如 extension 加载失败 exit(1)），此时无订阅者，
 * dispatchSession 会静默丢弃。因此 routeInbound 对 session.exited 做兜底处理，
 * 保证 markDead + markSessionError + toast 一定执行。
 */
function handleSessionExited(sessionId: string, payload: { code: number | null; reason: string }): void {
  useChatStore().markSessionError(sessionId, payload.reason)
  useSessionStore().markDead(sessionId)
  // reason 可能含多行 stderr，toast 只取首行（完整内容在聊天流 error 消息里）
  const shortReason = payload.reason.split('\n')[0]
  useToast().error(`会话进程已退出：${shortReason}`)
}

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
    // session.exited 兜底：进程退出必须标记 dead + toast，不能只依赖惰性的 session
    // 通道订阅（首次 send 前可能无订阅者 → dispatchSession no-op → 错误丢弃）。
    if (msg.type === 'session.exited') {
      handleSessionExited(sid, msg.payload as { code: number | null; reason: string })
    }
  } else {
    events.dispatchGlobal(msg)
    // L9：session 级消息（type 以 session./message. 开头）缺失 sessionId 时 warn，
    // 让 runtime bug 可见（违反规则 #7 隔离要求应有 fail-fast 信号，而非静默降级到 global 丢弃）
    if (msg.type.startsWith('session.') || msg.type.startsWith('message.')) {
      console.warn('[useConnection] session-level message missing sessionId, routed to global:', msg.type)
    }
    // 全局 error 兜底：无 sessionId、无 id 的 server-push error 此前静默丢弃。
    // 现 toast 提示（如 config 加载失败等全局错误）。
    if (msg.type === 'error' && !msg.id) {
      const payload = msg.payload as { message?: string }
      const message = typeof payload.message === 'string' ? payload.message : '未知错误'
      useToast().error(message)
    }
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
let removeStateWatch: (() => void) | null = null

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
    // runtime 崩溃 = pi 子进程没了 = 流不可能继续。重置 chat 活跃态 + 清理 pending，
    // 避免 UI 卡「思考中」+ in-flight Promise 永挂（runtime 重启后是全新实例，旧 pending 永远收不到响应）。
    removeRuntimeRestartingListener = onRuntimeRestarting(() => {
      setRestarting()
      pending.rejectAll(new Error('Runtime 正在重启'))
      useChatStore().finalizeAllStreaming('restart')
    })

    // 监听 runtime 重启用尽（主进程放弃 → 进 failed 态，等用户手动重试）
    removeRuntimeFailedListener = onRuntimeFailed(() => {
      setFailed()
      pending.rejectAll(new Error('Runtime 不可用'))
      useChatStore().finalizeAllStreaming('disconnect')
    })

    // 监听 WS 连接状态变化：connected → 断开时清理 pending（覆盖 runtime 未崩溃但 WS 断连的场景，
    // 如网络抖动。ws-client.onclose 不通知业务层，通过 watch state 变化间接感知）。
    const stopStateWatch = watch(getState(), (newState, oldState) => {
      if (oldState === 'connected' && newState !== 'connected') {
        pending.rejectAll(new Error('连接已断开'))
      }
    })
    removeStateWatch = stopStateWatch

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
    if (removeStateWatch) {
      removeStateWatch()
      removeStateWatch = null
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
