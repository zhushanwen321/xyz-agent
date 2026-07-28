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
import { connect, disconnect, getState, setRestarting, setFailed, setSubscribedSessions } from '../lib/ws-client'
import { bumpReconnectEpoch } from '../lib/terminal-reconnect-signal'
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
import type { ServerMessage, PresenceConnection } from '@xyz-agent/shared'
import { isRemoteMode, getActiveProfile, getClientId, getDeviceName } from '../lib/remote/connection-config'
import * as transport from '../api/transport'
import * as pending from '../api/pending'
import * as events from '../api/events'
import { session as sessionApi } from '@/api'
import { useChatStore } from '../stores/chat'
import { useSessionStore } from '../stores/session'
import { usePanelStore } from '../stores/panel'
import { useExtensionUIStore } from '../stores/extension-ui'
import { usePresenceStore } from '../stores/presence'
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

// ── P6 D6 session.delete 两步广播：全局兜底处理 ──────────────────
// session.deleting（预告，soft close panel）/ session.deleted（确认，cleanupSession）
// 是广播消息（broadcastExcept 排除发起方），含 sessionId 走 dispatchSession，
// 但其他客户端可能无订阅者（panel 未开该 session），故 routeInbound 全局兜底调用注册的 handler。
// useSidebar 在 onConnected 注册 cleanupSession + softClosePanel，避免 useConnection 依赖 useSidebar。
interface SessionDeleteHandlers {
  onDeleting: (sessionId: string) => void
  onDeleted: (sessionId: string) => void
}
let sessionDeleteHandlers: SessionDeleteHandlers | null = null
/**
 * 注册 session.delete 广播处理器（useSidebar.onConnected 调用）。
 * routeInbound 收到 session.deleting/deleted 广播时全局调用，不依赖 panel 订阅。
 */
export function registerSessionDeleteHandlers(handlers: SessionDeleteHandlers): void {
  sessionDeleteHandlers = handlers
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
      // type==='error' 已窄化 payload 为 error envelope（含 code + message + 可选 details）。
      // 透传 code 到 reject 的 Error（D-021：NodeState.reason 需要 error code 区分失败类型，
      // 如 out_of_cwd / permission_denied / timeout）。此前只透传 message 丢了 code。
      // R2：details.detail 展开到 reject 的 Error 上——
      // - worktree handler 把 WORKTREE_EXISTS 的 { cwd, dirName } 放 detail（对象，S5 后）；
      // - 把 SETUP_FAILED/GIT_FAILED 的 { exitCode, stderr } 放 detail。
      // 不展开则 CreateWorktreeModal error 态读不到 stderr、exists 态「直接开始」读不到 cwd。
      // 注：object 分支 Object.assign(enriched, d) 会把 cwd 和 dirName 都赋到 Error 上，
      // lastError.cwd 仍可读（onUseExisting 用），dirName 可用于前端核对是否同分支名碰撞。
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
        // 字符串 detail（如 WORKTREE_EXISTS 的 cwd）直接作 cwd 字段
        enriched.cwd = d
      } else if (d && typeof d === 'object') {
        // 对象 detail（如 { exitCode, stderr }）展开到 Error 上
        Object.assign(enriched, d)
      }
      pending.reject(msg.id, Object.assign(new Error(message), enriched))
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
    // P6 D6 session.delete 两步广播：全局兜底（不依赖 panel 订阅）。
    // session.deleting：soft close panel（预告，暂不清 store）。
    // session.deleted：cleanupSession（清 store 分区，防其他客户端内存泄漏）。
    // 发起方不收广播 deleted（broadcastExcept 排除），只走 reply → pending.resolve → deleteSession。
    if (msg.type === 'session.deleting') {
      sessionDeleteHandlers?.onDeleting(sid)
    } else if (msg.type === 'session.deleted') {
      sessionDeleteHandlers?.onDeleted(sid)
    }
    // P5 lease：session.busy/idle 更新 session store 占用状态（UI 标题旁占用指示器）。
    // busy：lease acquire 成功，payload 含 clientId（busyOwnerId）；idle：lease 释放，清除占用。
    if (msg.type === 'session.busy') {
      const p = msg.payload as { clientId: string; expiresAt?: number }
      useSessionStore().setSessionBusy(sid, p.clientId, p.expiresAt)
    } else if (msg.type === 'session.idle') {
      useSessionStore().clearSessionBusy(sid)
    }
    // message.complete：后台完成时提示音 + 未读标记
    if (msg.type === 'message.complete') {
      const payload = msg.payload as { sessionId?: string; stopReason?: string }
      const focusedSid = usePanelStore().panels.find(
        (p) => p.id === usePanelStore().activePanelId,
      )?.sessionId ?? null
      handleCompletion(sid, payload.stopReason ?? 'stop', focusedSid)
    }
  } else {
    events.dispatchGlobal(msg)
    // P5 presence：presence.update 是全局消息（无 sessionId），全量替换 presence store。
    // 来源：connection-manager broadcastPresence（上下线/setActive/lease 变化）+ ws-client 合成
    // （auth.ok presence 字段）。spec D9 全量替换语义。
    if (msg.type === 'presence.update') {
      const payload = msg.payload as { connections?: PresenceConnection[] }
      if (Array.isArray(payload.connections)) {
        usePresenceStore().setConnections(payload.connections)
      }
    }
    // L9：session 级消息（type 以 session./message. 开头）缺失 sessionId 时 warn，
    // 让 runtime bug 可见（违反规则 #7 隔离要求应有 fail-fast 信号，而非静默降级到 global 丢弃）
    if (msg.type.startsWith('session.') || msg.type.startsWith('message.')) {
      console.warn('[useConnection] session-level message missing sessionId, routed to global:', msg.type)
    }
    // 全局 error 兜底：无 sessionId、无 id 的 server-push error 此前静默丢弃。
    // 现 toast 提示（如 config 加载失败等全局错误）。
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

/**
 * 同步当前已订阅 session 列表到 ws-client（wave3 P2-s4 IF1，spec §6.1/FC2）。
 *
 * 把当前打开的 panel 承载的 sessionId 列表注入 ws-client.setSubscribedSessions，
 * 重连时 auth 携带此列表限定 server 回放范围（只回放订阅 session 的增量）。
 * 列表来源：usePanelStore().panels（已打开/可见的 panel 对应的 session 即已订阅），
 * 不用 sessionStore.all（未打开 panel 的 session 无 terminal 消费者，回放其 terminal.data 无意义）。
 *
 * 调用点：(1) init 末尾（初始注入）；(2) 首次连接成功；(3) 重连成功（确保重连 auth 携带最新订阅）。
 */
function syncSubscribedSessions(): void {
  const panels = usePanelStore().panels
  const sessionIds = panels
    .map((p) => p.sessionId)
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
  setSubscribedSessions(sessionIds)
}

/**
 * P5 presence（审查 Major3）：远程模式连接成功后主动调 presence.list RPC 拉一次全量 presence。
 *
 * spec §五要求 resume 路径（短断线，无 auth.ok 的 presence 字段）主动拉一次 presence——短断线 resume
 * 的客户端 presence store 仍是断线前的旧列表（resume 不走 onConnect，auth.ok 只在冷启动带 presence 兜底）。
 * 此前 renderer 无任何 listPresence 调用点，导致 resume 后 presence 不刷新。
 *
 * 取舍：远程模式每次连接成功都调一次（冷启动有 auth.ok.presence 兜底，resume 有 listPresence 兜底，
 * 两者幂等——setConnections 全量替换）。本地模式（isRemoteMode()===false）不调（本地单客户端无多端 presence 需求）。
 * 失败仅 warn，不阻断连接主流程（presence 是辅助视图，拉取失败可由后续 presence.update 广播自愈）。
 */
function refreshPresenceOnConnect(): void {
  if (!isRemoteMode()) return
  // fire-and-forget：连接成功后异步拉取，不阻塞 init；失败 warn 不传播。
  sessionApi.listPresence()
    .then((connections) => {
      usePresenceStore().setConnections(connections)
    })
    .catch((e) => {
      console.warn('[useConnection] listPresence on connect failed (non-blocking):', e)
    })
}

export function useConnection() {
  const state = getState()

  async function init(): Promise<void> {
    // 入站消息分发器在任何模式下都安装（mock 模式仅收到 pong，无副作用）
    ensureDispatcher()

    // wave3 P2-s4：初始注入当前已订阅 session 列表（供首连/重连 auth 携带，限定 server 回放范围）。
    // 后续 panel 变化由 watch(getState()) 的连接成功分支重新 sync（重连时拿最新 panel 列表）。
    syncSubscribedSessions()

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
      // wave3 P2-s4：重连成功检测——从非 connected（且非首次 connecting）翻回 connected。
      // oldState==='connecting' 是首次连接（不算重连，不 bump 清缓冲）；oldState 为
      // disconnected/reconnecting/failed → connected 才是重连（bump 信号触发 useTerminal 清 scrollback）。
      if (
        newState === 'connected' &&
        (oldState === 'disconnected' || oldState === 'reconnecting')
      ) {
        bumpReconnectEpoch()
        syncSubscribedSessions()
        // P5 presence（审查 Major3）：重连成功后主动拉 presence（resume 路径兜底）。
        refreshPresenceOnConnect()
      }
      // 首次连接成功（任意→connected）也注入订阅（供下次重连 auth 携带）
      if (newState === 'connected' && oldState === 'connecting') {
        syncSubscribedSessions()
        // P5 presence（审查 Major3）：首次连接成功也拉一次 presence（冷启动兜底，与 auth.ok.presence 幂等）。
        refreshPresenceOnConnect()
      }
    })
    removeStateWatch = stopStateWatch

    // mock 模式：走 mock，不需要端口发现，也不监听 runtime 崩溃事件（mock 无 runtime 进程）
    if (import.meta.env.VITE_MOCK === 'true') {
      connectWs('mock://localhost')
      return
    }

    // 远程模式：连远程 server（auth 握手），不走本地 IPC 端口发现、不注册 runtime 崩溃监听
    // （远程无本地 runtime 进程，IPC 监听空转 + restartRuntime 无 supervisor 无效）。
    // isRemoteMode() 内部 short-circuit mode==='remote' && getActiveProfile()!==null，
    // 进入分支时 profile 必非空（同步代码无 await 间隙，TOCTOU 风险极低 → profile! 非空断言安全）。
    // 直接调 connect(url, {auth}) 而非 connectWs(url)：connectWs 不传 auth opts 会让首连退化本地模式，
    // 远程首连必须显式传 auth（ws-client connect 据此设 currentAuthOpts + isRemote，重连复用）。
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
   * 手动重试（用户从「runtime 不可用」/远程 failed 状态条点重试触发）。
   *
   * 分模式：
   * - 远程：disconnect() + connect(activeProfile, {auth})（重连，非 IPC restart）。
   *   远程无本地 supervisor，restartRuntime IPC 无效；断开重连让 ws-client 重新走 auth 握手。
   * - 本地：委托 IPC runtime-restart → 主进程 supervisor.restartRuntime。
   *   supervisor 重启成功会广播 runtime-port（onRuntimePort 监听自动重连），逐字节不变。
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
      return
    }
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
