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
import i18n from '@/i18n'

const t = i18n.global.t
import {
  getRuntimePort,
  getRuntimePortOffset,
  onRuntimePort,
  onRuntimeRestarting,
  onRuntimeFailed,
  restartRuntime,
} from '../lib/ipc'
import { BASE_PORT, DEV_PORT_OFFSET } from '@xyz-agent/shared'
import * as transport from '../api/transport'
import * as pending from '../api/pending'
import * as events from '../api/events'
import { session as sessionApi } from '../api'
import { configureRouteInbound } from '@xyz-agent/core'
import { useChatStore } from '../stores/chat'
import { useSessionStore } from '../stores/session'
import { usePanelStore } from '../stores/panel'
import { useExtensionUIStore } from '../stores/extension-ui'
import { useSubagentStore } from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'
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
  | 'restarting'
  | 'failed'

let dispatcherInstalled = false
let removeTransportListener: (() => void) | null = null

/** 安装入站分发器（幂等：仅安装一次）。transport.on 占用 ws-client 单槽 onMessage。 */
function ensureDispatcher(): void {
  if (dispatcherInstalled) return
  dispatcherInstalled = true
  // 入站路由归位 @xyz-agent/core（wave:renderer-rebuild-v2 W2）：configureRouteInbound 一次性
  // 注入三件套端口（pending/events/subscribe）+ effect 回调（session.exited/message.complete/
  // session.subagents/session.workflowUpdate/全局 error），内部 setSubscriptionPorts 把端口灌入
  // core subscription-state（gap 检测副作用依赖）。返回的 dispatcher 等价原 routeInbound
  // （pending 分流 + ROUTE_TABLE 精确 type + FALLBACK 兜底），行为不变（AC4/AC5/AC7/AC8/AC10）。
  const dispatcher = configureRouteInbound(
    {
      pending,
      events,
      subscribe: sessionApi.subscribe,
    },
    {
      onSessionExited: handleSessionExited,
      onMessageComplete: (sid, payload) => {
        const focusedSid =
          usePanelStore().panels.find((p) => p.id === usePanelStore().activePanelId)?.sessionId ?? null
        handleCompletion(sid, payload.stopReason ?? 'stop', focusedSid)
      },
      onSubagents: (sid, subagents) => {
        useSubagentStore().applyRecords(sid, subagents)
      },
      onWorkflowUpdate: (sid, update) => {
        useWorkflowStore().triggerWorkflowReload(sid, update.status ?? 'unknown')
      },
      onGlobalError: (message) => {
        useToast().error(message)
      },
    },
  )
  removeTransportListener = transport.on(dispatcher)
}

/**
 * 连接 WS 并记录 url（W4 visibility 重连复用）。
 * 包装 ws-client connect：调前把 url 存入 lastConnectedUrl，供用户切回前台时主动重连。
 */
function connectWs(url: string): void {
  lastConnectedUrl = url
  connect(url)
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
/**
 * 最近一次 connect 使用的 url（W4 visibility 重连复用）。
 * 用户从后台切回前台且未连接时，用此 url 主动重连，不干等 ws-client 指数退避（最长 30s）。
 * null 表示从未连过（此时也无 url 可复用，visibility 不触发重连）。
 */
let lastConnectedUrl: string | null = null
/** visibilitychange handler 引用（teardown 时 removeEventListener 用） */
let visibilityHandler: (() => void) | null = null

export function useConnection() {
  const state = getState()

  async function init(): Promise<void> {
    // 入站消息分发器在任何模式下都安装（mock 模式仅收到 pong，无副作用）
    ensureDispatcher()

    // W4：安装 visibilitychange 监听（幂等——visibilityHandler 守卫防重复注册）。
    // 用户从其它标签页 / 系统切回应用（visibilityState 变 visible）且当前未连接时，
    // 用最近一次 url 主动重连，不干等 ws-client 指数退避（最长 30s）。
    if (!visibilityHandler) {
      visibilityHandler = () => {
        // 守卫 1：只有切回可见（visible）才重连，切到后台（hidden）不触发
        if (document.visibilityState !== 'visible') return
        // 守卫 2：已连接就不重连（避免无谓连接触发）
        if (getState().value === 'connected') return
        // 守卫 3：从未连过（无 url 复用）则不触发
        if (!lastConnectedUrl) return
        connectWs(lastConnectedUrl)
      }
      document.addEventListener('visibilitychange', visibilityHandler)
    }

    if (initialised) {
      // HMR 后重连
      if (import.meta.env.VITE_MOCK !== 'true') {
        connectWs('ws://localhost:' + await resolveFallbackPort())
      }
      return
    }
    initialised = true

    // L10：WS 连接状态监听在任何模式都安装（含 mock），确保 mock 断连时也 rejectAll pending。
    // 此前在 mock 分支之后，mock 模式跳过安装 → mock 断连时 pending 永不 reject。
    const stopStateWatch = watch(getState(), (newState, oldState) => {
      if (oldState === 'connected' && newState !== 'connected') {
        pending.rejectAll(new Error(t('connection.disconnectedError')))
      }
    })
    removeStateWatch = stopStateWatch

    // mock 模式：走 mock，不需要端口发现，也不监听 runtime 崩溃事件（mock 无 runtime 进程）
    if (import.meta.env.VITE_MOCK === 'true') {
      connectWs('mock://localhost')
      return
    }

    // 监听 runtime 端口推送（runtime 重启成功后推新端口 → 断开重连）
    removeRuntimePortListener = onRuntimePort((newPort) => {
      if (newPort && state.value !== 'disconnected') {
        disconnect()
        connectWs('ws://localhost:' + newPort)
      }
    })

    // 监听 runtime 崩溃重启中（主进程正在拉起新实例 → 进 restarting 态，停自动重连）
    // runtime 崩溃 = pi 子进程没了 = 流不可能继续。重置 chat 活跃态 + 清理 pending，
    // 避免 UI 卡「思考中」+ in-flight Promise 永挂（runtime 重启后是全新实例，旧 pending 永远收不到响应）。
    // ask-user pending 同理：pi 死了 ask-user 的 Promise 永远不会被 resolve，必须 clearAllPending（T5）。
    removeRuntimeRestartingListener = onRuntimeRestarting(() => {
      setRestarting()
      pending.rejectAll(new Error(t('connection.runtimeRestarting')))
      useChatStore().finalizeAllStreaming('restart')
      useExtensionUIStore().clearAllPending()
    })

    // 监听 runtime 重启用尽（主进程放弃 → 进 failed 态，等用户手动重试）
    removeRuntimeFailedListener = onRuntimeFailed(() => {
      setFailed()
      pending.rejectAll(new Error(t('connection.runtimeUnavailable')))
      useChatStore().finalizeAllStreaming('disconnect')
      useExtensionUIStore().clearAllPending()
    })

    // 尝试从主进程获取已知端口
    const knownPort = await getRuntimePort()
    if (knownPort) {
      connectWs('ws://localhost:' + knownPort)
      return
    }

    // Runtime 尚未启动：用 fallback 端口（ws-client 会自动重连，runtime 起来后连上）
    connectWs('ws://localhost:' + await resolveFallbackPort())
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
    // W4：卸载 visibilitychange 监听（与 init 的 addEventListener 配对，防内存泄漏 + 重复触发）
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
