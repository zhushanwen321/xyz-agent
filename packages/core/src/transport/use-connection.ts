/**
 * use-connection —— 连接生命周期编排（core 版，架构审计 §10.2 D-1 迁移）。
 *
 * 迁自 renderer composables/useConnection.ts（266 行），保留所有运行时不变量：
 * - init()：发现 runtime 端口 → connect WS（mock 模式走 mock://）
 * - 监听 runtime 重启（onRuntimePort 推新端口 → 断开重连）
 * - visibility 主动重连（切回前台且未连接时用最近 url 重连，不干等指数退避最长 30s）
 * - teardown()：取消全部监听 + 断开
 * - 模块级单例副作用 + initialised/dispatcherInstalled 幂等守卫（保持）
 *
 * 端口发现顺序（不变）：
 *   1. env.isMock → connect('mock://')（ws-client 经 platform 注入 mock factory）
 *   2. ipc.getRuntimePort()（main 已 spawn）→ connect(ws://localhost:port)
 *   3. fallback：BASE_PORT + offset（dev 模式 +DEV_PORT_OFFSET）
 *
 * headless 化改造（core 零 DOM / 零构建环境读取 / 零 renderer import，§10.2）：
 * - visibilityState / addEventListener → visibility 端口（isVisible/onVisibilityChange）
 * - VITE_MOCK/DEV 环境标志 → env 端口（isMock/isDev）
 * - 对话流清理（chat finalize / extension UI pending）→ onRuntimeUnavailable 端口
 * - 入站 dispatcher 经 configureRouteInbound(ports) 安装，effects 经端口注入——
 *   本文件零 import 任何 store（renderer useMessageEffects 实现回调，§11.4）
 * - WS 能力复用 core ws-client（同一模块级单例；renderer lib/ws-client 是 re-export shim）
 *
 * 依赖方向：use-connection → ws-client + coordination/route-inbound + shared（端口常量）。
 */
import { watch } from 'vue'
import { connect, disconnect, getState, onMessage, setFailed, setRestarting } from './ws-client'
import {
  configureRouteInbound,
  type InboundEffects,
  type TransportPorts,
} from '../coordination/route-inbound'
import { resubscribeAll } from '../coordination/subscription-state'
import { BASE_PORT, DEV_PORT_OFFSET } from '@xyz-agent/shared'

// ── 端口契约（§10.2 D-1：renderer 装配点注入实现） ─────────────────

/**
 * use-connection 的壳层端口面。
 *
 * renderer（composables/useConnection.ts 装配点）注入实现：
 * - ipc → lib/ipc（getRuntimePort/getRuntimePortOffset/onRuntimePort/restartRuntime 等）
 * - visibility → visibilityState + visibilitychange 监听（壳层 DOM 实现）
 * - env → VITE_MOCK / DEV（core 不能读构建环境标志，由壳读）
 * - pending/events/subscribe → TransportPorts 三件套（configureRouteInbound 透传）
 * - effects → useMessageEffects（renderer 层 store 副作用，§11.4）
 * - toast/t → 壳层 UI/i18n
 * - onRuntimeUnavailable → runtime 崩溃/重启用尽时的对话流清理
 */
export interface ConnectionPorts {
  ipc: {
    getRuntimePort(): Promise<number | undefined>
    getRuntimePortOffset(): Promise<number | undefined>
    onRuntimePort(cb: (port: number) => void): () => void
    onRuntimeRestarting(cb: () => void): () => void
    onRuntimeFailed(cb: () => void): () => void
    restartRuntime(): Promise<void>
  }
  visibility: {
    isVisible(): boolean
    onVisibilityChange(handler: () => void): () => void
  }
  env: {
    isMock: boolean
    isDev: boolean
  }
  pending: TransportPorts['pending']
  events: TransportPorts['events']
  subscribe: TransportPorts['subscribe']
  effects: InboundEffects
  toast: { error(message: string): void }
  t(key: string, params?: Record<string, unknown>): string
  /** runtime 崩溃/重启用尽清理（renderer 实现：chat finalize + extension UI pending 清理） */
  onRuntimeUnavailable(reason: 'restart' | 'disconnect'): void
}

// ── 端口注入（C1 范式：模块级实现变量 + 注入函数 + 未注入 warn 降级） ──

let portsImpl: ConnectionPorts | null = null

/** 注入壳层端口（renderer 装配点调用；幂等，重复注入用最新实现）。 */
export function setConnectionPorts(ports: ConnectionPorts): void {
  portsImpl = ports
}

/** 读取端口；未注入时 warn 并返回 null（调用方 return 降级，不抛不挂起，对齐 subscription-state）。 */
function requirePorts(): ConnectionPorts | null {
  if (!portsImpl) {
    console.warn(
      '[core/use-connection] ConnectionPorts not injected — call setConnectionPorts() (renderer assembly) before useConnection().init()',
    )
  }
  return portsImpl
}

// ── 模块级单例状态（W4/幂等守卫） ─────────────────────────────────

let dispatcherInstalled = false
let removeTransportListener: (() => void) | null = null
let initialised = false
let removeRuntimePortListener: (() => void) | null = null
let removeRuntimeRestartingListener: (() => void) | null = null
let removeRuntimeFailedListener: (() => void) | null = null
let removeStateWatch: (() => void) | null = null
/** visibility 监听的取消函数（teardown 时调用；非空即已安装） */
let removeVisibilityListener: (() => void) | null = null
/**
 * 最近一次 connect 使用的 url（W4 visibility 重连复用）。
 * 用户从后台切回前台且未连接时，用此 url 主动重连，不干等 ws-client 指数退避（最长 30s）。
 * null 表示从未连过（此时也无 url 可复用，visibility 不触发重连）。
 */
let lastConnectedUrl: string | null = null

/**
 * 安装入站分发器（幂等：仅安装一次）。onMessage 占用 ws-client 单槽。
 *
 * configureRouteInbound 一次性注入三件套端口（pending/events/subscribe）+ effect 回调
 * （session.exited/message.complete/session.subagents/session.workflowUpdate/全局 error），
 * 内部 setSubscriptionPorts 把端口灌入 core subscription-state（gap 检测副作用依赖）。
 */
function ensureDispatcher(ports: ConnectionPorts): void {
  if (dispatcherInstalled) return
  dispatcherInstalled = true
  const dispatcher = configureRouteInbound(
    { pending: ports.pending, events: ports.events, subscribe: ports.subscribe },
    ports.effects,
  )
  // route-inbound 是消息分发单一真相源（ADR-0060：raw-message-tap 旁路已移除）。
  // ExtensionHost 经 events.onCrossSession/onGlobal 正规通道订阅。
  removeTransportListener = onMessage(dispatcher)
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
async function resolveFallbackPort(ports: ConnectionPorts): Promise<number> {
  const offset = await ports.ipc.getRuntimePortOffset()
  if (offset !== undefined) return BASE_PORT + offset
  // DEV 环境下 runtime 在 BASE_PORT+100，不能 fallback 到 prod 端口
  if (ports.env.isDev) return BASE_PORT + DEV_PORT_OFFSET
  return BASE_PORT
}

export function useConnection() {
  const state = getState()

  async function init(): Promise<void> {
    const ports = requirePorts()
    if (!ports) return

    // 入站消息分发器在任何模式下都安装（mock 模式仅收到 pong，无副作用）
    ensureDispatcher(ports)

    // W4：安装 visibilitychange 监听（幂等——removeVisibilityListener 守卫防重复注册）。
    // 用户从其它标签页 / 系统切回应用（visibilityState 变 visible）且当前未连接时，
    // 用最近一次 url 主动重连，不干等 ws-client 指数退避（最长 30s）。
    if (!removeVisibilityListener) {
      removeVisibilityListener = ports.visibility.onVisibilityChange(() => {
        // 守卫 1：只有切回可见（visible）才重连，切到后台（hidden）不触发
        if (!ports.visibility.isVisible()) return
        // 守卫 2：已连接就不重连（避免无谓连接触发）
        if (getState().value === 'connected') return
        // 守卫 3：从未连过（无 url 复用）则不触发
        if (!lastConnectedUrl) return
        connectWs(lastConnectedUrl)
      })
    }

    if (initialised) {
      // HMR 后重连
      if (!ports.env.isMock) {
        connectWs('ws://localhost:' + await resolveFallbackPort(ports))
      }
      return
    }
    initialised = true

    // L10：WS 连接状态监听在任何模式都安装（含 mock），确保 mock 断连时也 rejectAll pending。
    // 此前在 mock 分支之后，mock 模式跳过安装 → mock 断连时 pending 永不 reject。
    // M1（W09 follow-up）：connected false→true 迁移时恢复全部 bus 订阅——runtime 侧
    // ws onDisconnect → bus.unsubscribeAll(ws) 已清空该连接订阅，core 侧幂等守卫
    // （subscribed 标记）不会自行失效，不主动重发则重连后 session 级消息永久丢失
    // （W09 删除 broadcast 兜底腿后 publish 定向推送是唯一通道）。首次连接时
    // subscriptionStates 为空 → no-op，无副作用。
    const stopStateWatch = watch(getState(), (newState, oldState) => {
      if (oldState === 'connected' && newState !== 'connected') {
        // code='disconnected' 供调用方（useFileTree catch 等）识别传输断开类失败（对齐 request.ts send-fail reject）
        ports.pending.rejectAll(
          Object.assign(new Error(ports.t('connection.disconnectedError')), { code: 'disconnected' }),
        )
      }
      if (newState === 'connected' && oldState !== 'connected') {
        resubscribeAll()
      }
    })
    removeStateWatch = stopStateWatch

    // mock 模式：走 mock，不需要端口发现，也不监听 runtime 崩溃事件（mock 无 runtime 进程）
    if (ports.env.isMock) {
      connectWs('mock://localhost')
      return
    }

    // 监听 runtime 端口推送（runtime 重启成功后推新端口 → 断开重连）
    removeRuntimePortListener = ports.ipc.onRuntimePort((newPort) => {
      if (newPort && state.value !== 'disconnected') {
        disconnect()
        connectWs('ws://localhost:' + newPort)
      }
    })

    // 监听 runtime 崩溃重启中（主进程正在拉起新实例 → 进 restarting 态，停自动重连）
    // runtime 崩溃 = pi 子进程没了 = 流不可能继续。重置 chat 活跃态 + 清理 pending，
    // 避免 UI 卡「思考中」+ in-flight Promise 永挂（runtime 重启后是全新实例，旧 pending 永远收不到响应）。
    // ask-user pending 同理：pi 死了 ask-user 的 Promise 永远不会被 resolve，必须清空（T5）。
    removeRuntimeRestartingListener = ports.ipc.onRuntimeRestarting(() => {
      setRestarting()
      ports.pending.rejectAll(
        Object.assign(new Error(ports.t('connection.runtimeRestarting')), { code: 'disconnected' }),
      )
      ports.onRuntimeUnavailable('restart')
    })

    // 监听 runtime 重启用尽（主进程放弃 → 进 failed 态，等用户手动重试）
    removeRuntimeFailedListener = ports.ipc.onRuntimeFailed(() => {
      setFailed()
      ports.pending.rejectAll(
        Object.assign(new Error(ports.t('connection.runtimeUnavailable')), { code: 'disconnected' }),
      )
      ports.onRuntimeUnavailable('disconnect')
    })

    // 尝试从主进程获取已知端口
    const knownPort = await ports.ipc.getRuntimePort()
    if (knownPort) {
      connectWs('ws://localhost:' + knownPort)
      return
    }

    // Runtime 尚未启动：用 fallback 端口（ws-client 会自动重连，runtime 起来后连上）
    connectWs('ws://localhost:' + await resolveFallbackPort(ports))
  }

  /**
   * 手动重试（用户从「runtime 不可用」状态条点重试触发）。
   * 委托 IPC runtime-restart → 主进程 supervisor.restartRuntime。
   * supervisor 重启成功会广播 runtime-port（onRuntimePort 监听自动重连）。
   */
  async function retryRuntime(): Promise<void> {
    const ports = requirePorts()
    if (!ports) return
    await ports.ipc.restartRuntime()
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
    // W4：卸载 visibilitychange 监听（与 init 的安装配对，防内存泄漏 + 重复触发）
    if (removeVisibilityListener) {
      removeVisibilityListener()
      removeVisibilityListener = null
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
