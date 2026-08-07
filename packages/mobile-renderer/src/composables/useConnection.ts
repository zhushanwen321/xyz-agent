/**
 * useConnection —— 连接生命周期编排（mobile-renderer 版，砍本地模式分支，spec P4 C3）。
 *
 * 与 renderer 版差异：
 * - 砍掉本地模式分支：getRuntimePort/getRuntimePortOffset IPC 端口发现、
 *   BASE_PORT+DEV_PORT_OFFSET fallback、import.meta.env.DEV 分支、HMR 复连、VITE_MOCK 分支。
 * - 只保留远程模式（isRemoteMode + ws-client auth 握手）。
 * - 砍掉 runtime 崩溃监听（onRuntimeRestarting/onRuntimeFailed/restartRuntime）——
 *   移动端连远程 server，无本地 runtime 进程，IPC 监听在 mobile ipc.ts 恒 no-op。
 * - 保留：入站消息分发（routeInbound）、WS 状态监听（重连 rejectAll pending）、
 *   visibilitychange 主动重连、subscribed sessions 同步（P2 seq 回放 auth 携带）。
 *
 * 此文件是 MANUAL_FORK 分叉点（sync 脚本 --force 跳过，renderer 改远程模式逻辑时人工 diff 合并）。
 *
 * 依赖方向：useConnection → ws-client + shared + connection-config + api/{transport,pending,events} + stores
 */
import { watch } from 'vue'
import { connect, disconnect, getState, setSubscribedSessions } from '../lib/ws-client'
import { bumpReconnectEpoch } from '../lib/terminal-reconnect-signal'
import i18n from '@/i18n'

const t = i18n.global.t
import type { ServerMessage } from '@xyz-agent/shared'
import { isRemoteMode, getActiveProfile, getClientId, getDeviceName } from '../lib/remote/connection-config'
import * as transport from '../api/transport'
import * as pending from '../api/pending'
import * as events from '../api/events'
import { useChatStore } from '../stores/chat'
import { useSessionStore } from '../stores/session'
import { usePanelStore } from '../stores/panel'
import { useToast } from './useToast'
import { handleCompletion } from './useCompletionNotify'

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
  useToast().error(t('connection.runtimeExited', { reason: shortReason }))
}

export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed'

/**
 * 入站消息分发器（features 层串联 transport→pending/events 的唯一桥）。
 *
 * 对每条入站 ServerMessage：
 *   1. 若 msg.id 命中 pending → resolve（普通响应）/ reject（error envelope）
 *   2. 按 payload.sessionId 是否存在分流：
 *      - 有 sessionId → events.dispatchSession（session 通道）
 *      - 无 sessionId → events.dispatchGlobal（global 通道，config.* 及 model.list 等广播）
 */
function routeInbound(msg: ServerMessage): void {
  if (msg.id) {
    if (msg.type === 'error') {
      const payload = msg.payload as {
        code?: string
        message?: string
        details?: { detail?: unknown }
      }
      const message = typeof payload.message === 'string' ? payload.message : 'request failed'
      const code = typeof payload.code === 'string' ? payload.code : 'unknown'
      const enriched: Record<string, unknown> = { code }
      const d = payload.details?.detail
      if (typeof d === 'string') {
        enriched.cwd = d
      } else if (d && typeof d === 'object') {
        Object.assign(enriched, d)
      }
      pending.reject(msg.id, Object.assign(new Error(message), enriched))
    } else {
      pending.resolve(msg.id, msg.payload)
    }
  }
  const sid = (msg.payload as { sessionId?: string }).sessionId
  if (typeof sid === 'string' && sid) {
    events.dispatchSession(sid, msg)
    if (msg.type === 'session.exited') {
      handleSessionExited(sid, msg.payload as { code: number | null; reason: string })
    }
    if (msg.type === 'message.complete') {
      const payload = msg.payload as { sessionId?: string; stopReason?: string }
      const focusedSid = usePanelStore().panels.find(
        (p) => p.id === usePanelStore().activePanelId,
      )?.sessionId ?? null
      handleCompletion(sid, payload.stopReason ?? 'stop', focusedSid)
    }
  } else {
    events.dispatchGlobal(msg)
    if (msg.type.startsWith('session.') || msg.type.startsWith('message.')) {
      console.warn('[useConnection] session-level message missing sessionId, routed to global:', msg.type)
    }
    if (msg.type === 'error' && !msg.id) {
      const payload = msg.payload as { message?: string }
      const message = typeof payload.message === 'string' ? payload.message : t('connection.unknownError')
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

/**
 * 连接 WS 并记录 url（visibility 重连复用）。
 * 包装 ws-client connect：调前把 url 存入 lastConnectedUrl，供用户切回前台时主动重连。
 */
function connectWs(url: string): void {
  lastConnectedUrl = url
  connect(url)
}

let initialised = false
let removeStateWatch: (() => void) | null = null
/**
 * 最近一次 connect 使用的 url（visibility 重连复用）。
 * 用户从后台切回前台且未连接时，用此 url 主动重连，不干等 ws-client 指数退避。
 * null 表示从未连过。
 */
let lastConnectedUrl: string | null = null
/** visibilitychange handler 引用（teardown 时 removeEventListener 用） */
let visibilityHandler: (() => void) | null = null

/**
 * 同步当前已订阅 session 列表到 ws-client（P2-s4 IF1，seq 回放 auth 携带）。
 *
 * 把当前打开的 panel 承载的 sessionId 列表注入 ws-client.setSubscribedSessions，
 * 重连时 auth 携带此列表限定 server 回放范围（只回放订阅 session 的增量）。
 */
function syncSubscribedSessions(): void {
  const panels = usePanelStore().panels
  const sessionIds = panels
    .map((p) => p.sessionId)
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
  setSubscribedSessions(sessionIds)
}

export function useConnection() {
  const state = getState()

  async function init(): Promise<void> {
    // 入站消息分发器在任何模式下都安装
    ensureDispatcher()

    // 初始注入当前已订阅 session 列表（供首连/重连 auth 携带，限定 server 回放范围）。
    syncSubscribedSessions()

    // visibilitychange 监听（幂等——visibilityHandler 守卫防重复注册）。
    // 用户从其它标签页/系统切回应用（visibilityState 变 visible）且当前未连接时，
    // 用最近一次 url 主动重连。
    if (!visibilityHandler) {
      visibilityHandler = () => {
        if (document.visibilityState !== 'visible') return
        if (getState().value === 'connected') return
        if (!lastConnectedUrl) return
        connectWs(lastConnectedUrl)
      }
      document.addEventListener('visibilitychange', visibilityHandler)
    }

    if (initialised) return
    initialised = true

    // WS 连接状态监听：断连时 rejectAll pending；重连成功时 bump 信号（清 scrollback）+ sync 订阅。
    const stopStateWatch = watch(getState(), (newState, oldState) => {
      if (oldState === 'connected' && newState !== 'connected') {
        pending.rejectAll(new Error(t('connection.disconnectedError')))
      }
      if (
        newState === 'connected' &&
        (oldState === 'disconnected' || oldState === 'reconnecting')
      ) {
        bumpReconnectEpoch()
        syncSubscribedSessions()
      }
      if (newState === 'connected' && oldState === 'connecting') {
        syncSubscribedSessions()
      }
    })
    removeStateWatch = stopStateWatch

    // 移动端只走远程模式（spec P4 C3）：连远程 server，ws-client auth 握手。
    // isRemoteMode() 内部 short-circuit mode==='remote' && getActiveProfile()!==null，
    // 进入分支时 profile 必非空（同步代码无 await 间隙，TOCTOU 风险极低 → profile! 非空断言安全）。
    if (isRemoteMode()) {
      const profile = getActiveProfile()
      lastConnectedUrl = profile!.url
      connect(profile!.url, {
        auth: {
          token: profile!.token,
          clientId: getClientId(),
          deviceName: getDeviceName(),
        },
      })
      return
    }

    // 未配置远程模式：移动端无本地 runtime fallback，停留在 disconnected 态。
    // 由 App.vue 连接态门控渲染 MobileConnectScreen 引导用户粘贴连接信息（s2 实现）。
  }

  /**
   * 手动重试（远程模式下用户从 failed 状态条点重试触发）。
   * 移动端无本地 supervisor，断开重连让 ws-client 重新走 auth 握手。
   */
  async function retryRuntime(): Promise<void> {
    if (isRemoteMode()) {
      const profile = getActiveProfile()
      disconnect()
      connect(profile!.url, {
        auth: {
          token: profile!.token,
          clientId: getClientId(),
          deviceName: getDeviceName(),
        },
      })
    }
  }

  function teardown(): void {
    if (removeStateWatch) {
      removeStateWatch()
      removeStateWatch = null
    }
    if (visibilityHandler) {
      document.removeEventListener('visibilitychange', visibilityHandler)
      visibilityHandler = null
    }
    if (removeTransportListener) {
      removeTransportListener()
      removeTransportListener = null
    }
    dispatcherInstalled = false
    disconnect()
    initialised = false
    lastConnectedUrl = null
  }

  return { state, init, teardown, retryRuntime }
}
