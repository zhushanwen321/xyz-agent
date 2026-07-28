/**
 * WebSocket 客户端 —— 连接状态机 + 心跳 + 指数退避重连 + 远程 auth 握手。
 *
 * 重建版：去掉 event-bus 依赖和消息队列（连接骨架不发送业务消息）。
 * 保留所有运行时不变量（违反必出 bug）：
 *
 * [HISTORICAL] 不变量：
 * 1. 4 态状态机：disconnected → connecting → connected（onclose → reconnecting → connecting...）
 * 2. 心跳：15s 发 ping，runtime 不回 pong 会主动断（触发重连）
 * 3. 指数退避重连：1s 起、×2、上限 30s
 * 4. generation 计数：新连接 ++generation，旧 WS 的残余回调（onopen/onclose/onmessage）
 *    检查 gen !== wsGeneration 时直接 return，不干扰新连接
 * 5. HMR 复连：import.meta.hot 保存 url，热重载后自动重连
 * 6. mock 分支：VITE_MOCK=true 走 mockConnect（不连真实 WS，状态由 mock 驱动）
 *
 * [wave1 远程化] 新增不变量（远程模式 currentAuthOpts !== null 时生效）：
 * 7. connected 语义升级（spec D2）：远程模式 connected = WS open + auth.ok，onopen 不翻转 connected，
 *    先发 auth 消息（buildAuthMessage 复用 probe.ts IF13 防漂移）+ 启动 10s auth 超时。
 * 8. intercept(msg) 拦截层（onmessage 最前）：authId 非空时消化 auth.ok/auth 失败/握手期其他消息，
 *    auth 完成后清 authId，业务消息回归 messageHandler。
 * 9. onclose 按 CloseEvent.code 分流（spec §4.2）：4001→failed(auth) 不重连、4002→failed(replaced)
 *    不重连、auth 超时标志→failed(auth) 不重连、其他→现状退避重连超限 failed(network)。
 * 10. 本地模式（currentAuthOpts === null）逐字节不变：onopen 即 connected、onclose 退避、
 *     setFailed() 时 failReason=null、isRemote=false。
 *
 * 依赖方向：依赖 remote/probe（buildAuthMessage）；暴露 connect/disconnect/send/getState/onMessage
 * + failReason/isRemote 只读 ref（远程化扩展）。
 */
import { ref, readonly } from 'vue'
import type { Ref, DeepReadonly } from 'vue'
import type { ClientMessage, ServerMessage } from '@xyz-agent/shared'
import { mockConnect, mockSend, mockDisconnect } from '../mock/mock-ws'
import { buildAuthMessage } from './remote/probe'

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'restarting' // runtime 崩溃，主进程正在拉起新实例（来自 IPC runtime-restarting）
  | 'failed'     // runtime 重启用尽 / 远程 auth 失败 / 被挤下线（failReason 区分来源）

/**
 * 失败原因（远程化扩展，spec §4.2）。
 * - 'auth'：远程 auth 握手失败（close 4001 或客户端 10s 超时）
 * - 'replaced'：被另一客户端挤下线（close 4002）
 * - 'network'：退避重连超限（本地 + 远程通用，对齐现状 MAX_RECONNECT 上限）
 * - null：未失败 / 本地模式 setFailed() 通用失败（兼容 useConnection runtime-failed IPC）
 */
export type FailReason = 'auth' | 'replaced' | 'network' | null

/** auth 握手参数（spec §7.4 + protocol ClientMessage.auth payload）。 */
export interface AuthOpts {
  /** 鉴权 token（明文经 WS 传输） */
  token: string
  /** 客户端唯一 ID（getClientId 惰性生成） */
  clientId: string
  /** 设备名（getDeviceName 推导） */
  deviceName?: string
}

/** connect 选项（wave1 远程化：auth opts 供远程握手）。 */
export interface ConnectOpts {
  auth?: AuthOpts
}

// ── 常量 ────────────────────────────────────────────────────
const HEARTBEAT_INTERVAL_MS = 15_000
const RECONNECT_BASE_DELAY_MS = 1_000
const RECONNECT_BACKOFF_EXPONENT = 2
const MAX_RECONNECT_DELAY_MS = 30_000
/** 重连尝试上限（设计文档 A4 §3.3）：超此不再自动重连，置 failed 待用户手动重试 */
const MAX_RECONNECT_ATTEMPTS = 20
/** 重连总时长上限（ms）：超过即放弃，避免长时间无意义重试占用资源 */
const MAX_RECONNECT_DURATION_MS = 60_000
/** 远程 auth 握手超时（spec §7.5 + §4.1）：onopen 发 auth 后 10s 内未收 auth.ok → 主动 close 走 failed(auth) */
const AUTH_TIMEOUT_MS = 10_000

/** 服务端 close code：auth 失败（spec §7.4 / runtime ConnectionManager TC3） */
const CLOSE_CODE_AUTH_FAILURE = 4001
/** 服务端 close code：被挤下线（spec §7.4：该 clientId 在别处登录） */
const CLOSE_CODE_REPLACED = 4002

// ── 状态 ────────────────────────────────────────────────────
const state = ref<ConnectionState>('disconnected')
/**
 * 失败原因（远程化扩展）。本地模式恒 null；
 * 远程模式按 onclose 分流设置 'auth'/'replaced'/'network'。
 * 单独导出只读 ref（failReason），getState() 仍返回 readonly(state) 不破坏现有契约。
 */
const failReasonRef = ref<FailReason>(null)
/**
 * 是否远程模式（从 connect auth opts 推导）。本地模式恒 false；
 * 远程模式 connect(url,{auth}) 时置 true，disconnect 不重置（下次 connect 重新推导）。
 */
const isRemoteRef = ref<boolean>(false)

let ws: WebSocket | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
/** auth 超时定时器（远程模式 onopen 启动，auth.ok/失败/close 时清理） */
let authTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempts = 0
let wsGeneration = 0
let currentUrl: string | null = null
/**
 * 本轮 connect 的 auth opts（远程模式保存供重连复用，与 currentUrl/hmrUrl 同级）。
 * null = 本地模式（无 auth 握手，onopen 即 connected）。
 */
let currentAuthOpts: AuthOpts | null = null
/** 本轮重连起始时间戳（首次 scheduleReconnect 设置，connect 成功后置 null 重置） */
let reconnectStartedAt: number | null = null

/**
 * 当前 auth 握手的消息 id（onopen 发 auth 时记录，auth.ok/失败/disconnect 时清空）。
 * 非空 = 握手进行中（intercept 介入）；空 = 本地模式或 auth 已完成（intercept 放行）。
 */
let authId: string | null = null
/**
 * auth 超时标志（10s 定时器触发时置 true，主动 close 后让 onclose 走 failed(auth) 分支）。
 * onclose 优先检查此标志（超时 close 的 event.code 是 1000/1006 而非 4001，需靠标志区分）。
 */
let authTimedOut = false

// Vite HMR：热重载前保存 url，重载后自动重连
let hmrUrl = (import.meta.hot?.data as { wsUrl?: string } | undefined)?.wsUrl ?? null

const isMock = import.meta.env.VITE_MOCK === 'true'

/** 消息回调（连接骨架阶段不注册；后续业务层注册处理 ServerMessage） */
let messageHandler: ((msg: ServerMessage) => void) | null = null

/** 注册消息回调，返回取消函数 */
export function onMessage(cb: (msg: ServerMessage) => void): () => void {
  messageHandler = cb
  return () => {
    if (messageHandler === cb) messageHandler = null
  }
}

/** 连接状态（只读 ref，供 UI 消费） */
export function getState(): DeepReadonly<Ref<ConnectionState>> {
  return readonly(state)
}

/** 失败原因（远程化扩展，只读 ref）。本地模式恒 null。 */
export function getFailReason(): DeepReadonly<Ref<FailReason>> {
  return readonly(failReasonRef)
}

/** 是否远程模式（只读 ref，从 connect auth opts 推导）。 */
export function getIsRemote(): DeepReadonly<Ref<boolean>> {
  return readonly(isRemoteRef)
}

/**
 * 设置为 restarting 态（收到 IPC runtime-restarting 时调，useConnection 编排）。
 * 断开当前 WS（死端口）并停止自动重连——等主进程拉起新实例后推新端口再 connect。
 */
export function setRestarting(): void {
  if (isMock) return
  disconnect() // 停止在死端口上的自动重连，避免与 restarting 状态打架
  state.value = 'restarting'
}

/**
 * 设置为 failed 态（wave1 改签名接可选 failReason）。
 *
 * - `failReason === undefined`：兼容现有 useConnection setFailed() 无参调用（runtime-failed IPC），
 *   failReason 保持当前值（通常 null），语义同现状。
 * - `failReason` 有值：远程模式失败分流（'auth'/'replaced'/'network'），写 failReasonRef + state='failed'。
 *
 * 停止自动重连（clearTimers），等用户手动重试。
 */
export function setFailed(failReason?: Exclude<FailReason, null>): void {
  if (isMock) return
  clearTimers()
  if (failReason !== undefined) {
    failReasonRef.value = failReason
  }
  state.value = 'failed'
}

/** 建立连接（已连接/连接中时幂等 no-op）。wave1 远程化：opts.auth 触发远程握手分支。 */
export function connect(url: string, opts?: ConnectOpts): void {
  currentUrl = url
  // 推导远程模式 + 保存 auth opts 供重连复用：
  // 仅当显式传 opts 时更新 currentAuthOpts；重连（scheduleReconnect → connect(url) 无 opts）
  // 复用首次 connect 存的 currentAuthOpts，避免重连退化为本地模式（plan R3）。
  if (opts !== undefined) {
    currentAuthOpts = opts.auth ?? null
  }
  isRemoteRef.value = currentAuthOpts !== null

  if (isMock) {
    mockConnect(
      (s) => { state.value = s },
      (msg) => { messageHandler?.(msg) },
    )
    return
  }

  // 保存 url 供 HMR 复连
  hmrUrl = url

  // 幂等：已连接或连接中，不重复建连
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return

  state.value = 'connecting'
  const gen = ++wsGeneration
  // 新连接前清 auth 握手状态（防止上一轮残余）
  authId = null
  authTimedOut = false
  ws = new WebSocket(url)
  console.log('[ws] connecting to', url, currentAuthOpts ? '(remote auth)' : '(local)')

  ws.onopen = () => {
    if (gen !== wsGeneration) return // 旧 WS 残余回调，忽略
    if (currentAuthOpts !== null) {
      // ── 远程模式：onopen 发 auth + 启动超时，不翻转 connected（spec D2）──
      const authMsg = buildAuthMessage(currentAuthOpts)
      authId = authMsg.id
      authTimedOut = false
      try {
        ws?.send(JSON.stringify(authMsg))
      // eslint-disable-next-line taste/no-silent-catch -- onopen→close 竞态下 send 抛 InvalidStateError，留给 onclose 接管
      } catch (e) {
        console.error('[ws] send auth failed:', e)
      }
      // 10s auth 超时：设标志后主动 close，让 onclose 统一走 failed(auth)（spec §7.5）
      authTimer = setTimeout(() => {
        if (gen !== wsGeneration) return
        authTimedOut = true
        console.warn('[ws] auth timeout, closing')
        try {
          ws?.close()
        // eslint-disable-next-line taste/no-silent-catch -- close 抛（已 close）吞掉，onclose 会接管或已触发
        } catch {
          // 吞 close 异常
        }
      }, AUTH_TIMEOUT_MS)
    } else {
      // ── 本地模式：现状逐字节不变，onopen 即 connected ──
      state.value = 'connected'
      reconnectAttempts = 0
      // 连接成功 → 重置重连计时窗口（下次掉线重新开始计数）
      reconnectStartedAt = null
      startHeartbeat()
    }
  }

  ws.onmessage = (event) => {
    if (gen !== wsGeneration) return
    try {
      const msg = JSON.parse(event.data) as ServerMessage
      // intercept 优先：远程模式 auth 握手期消化 auth 回复 + 丢弃握手期业务消息
      if (intercept(msg)) return
      messageHandler?.(msg)
    // eslint-disable-next-line taste/no-silent-catch -- 非 JSON 消息解析失败，跳过
    } catch (e) {
      console.error('[ws] parse error:', e)
    }
  }

  ws.onclose = (event: CloseEvent) => {
    if (gen !== wsGeneration) return // 旧 WS 残余回调，不干扰新连接
    stopHeartbeat()
    clearAuthTimer()
    // ── 远程模式失败分流（spec §4.2）：4001/4002/超时不重连，直接 failed ──
    if (event.code === CLOSE_CODE_AUTH_FAILURE) {
      console.warn('[ws] closed by server: auth failure (4001)')
      setFailed('auth')
      return
    }
    if (event.code === CLOSE_CODE_REPLACED) {
      console.warn('[ws] closed by server: replaced (4002)')
      setFailed('replaced')
      return
    }
    if (authTimedOut) {
      // 客户端 auth 超时主动 close（event.code 通常是 1000/1006），走 failed(auth)（D11 统一收口）
      console.warn('[ws] closed after auth timeout')
      setFailed('auth')
      return
    }
    // ── 其他 close code（含本地模式）：现状退避重连，超限 failed(network) ──
    authId = null
    state.value = 'disconnected'
    scheduleReconnect()
  }

  ws.onerror = (err) => {
    console.error('[ws] error:', err)
    ws?.close()
  }
}

/** 主动断开（不触发重连） */
export function disconnect(): void {
  if (isMock) {
    mockDisconnect()
    state.value = 'disconnected'
    return
  }
  // 递增 generation 使旧 WS 的回调失效
  wsGeneration++
  clearTimers()
  // 清 auth 握手状态（防止残余 intercept 介入下次连接）
  authId = null
  authTimedOut = false
  if (ws) {
    // 先摘回调再 close，避免触发 onclose → scheduleReconnect
    ws.onclose = null
    ws.onerror = null
    ws.onmessage = null
    ws.close()
    ws = null
  }
  state.value = 'disconnected'
}

/**
 * 发送消息（W4：返回 boolean，让调用方 fast-fail）。
 *
 * 返回契约：
 * - readyState=OPEN → 实际发送，返回 true（已发送确认）
 * - readyState≠OPEN（CONNECTING/CLOSED）→ 不发送，返回 false（调用方可立即 reject / 重试）
 *
 * mock 模式：mock 始终「可发送」，返回 true（mockSend 不抛即视为发送成功）。
 * 透传 mockSend 返回值以支持测试桩精确控制（mockSend 返回 boolean 时以它为准）。
 */
export function send(msg: ClientMessage): boolean {
  if (isMock) {
    const ret = mockSend(msg)
    // mockSend 桩默认返回 undefined（视为发送成功 → true）；测试桩可返回 boolean 精确控制
    return typeof ret === 'boolean' ? ret : true
  }
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
    return true
  }
  return false
}

/**
 * 重置模块级状态（仅测试用，模拟「新模块实例」）。
 *
 * ws-client 是单例——state/failReasonRef/isRemoteRef 等 ref + currentUrl/currentAuthOpts/authId
 * 等模块级变量在单测间会残留（disconnect 只复位连接态，不复位 failReason）。多用例测试需在
 * beforeEach 调此函数清空，确保用例隔离（与 connection-config.__resetForTest 同模式）。
 *
 * @internal
 */
export function __resetForTest(): void {
  state.value = 'disconnected'
  failReasonRef.value = null
  isRemoteRef.value = false
  reconnectAttempts = 0
  wsGeneration = 0
  currentUrl = null
  currentAuthOpts = null
  reconnectStartedAt = null
  authId = null
  authTimedOut = false
  clearTimers()
  if (ws) {
    // 摘回调避免触发 onclose 干扰重置后的状态
    ws.onclose = null
    ws.onerror = null
    ws.onmessage = null
    ws = null
  }
}

// ── 内部 ────────────────────────────────────────────────────

/**
 * 拦截 auth 握手消息（远程模式 onmessage 最前调用，返回 true=消化不进 messageHandler）。
 *
 * 三态逻辑（spec D12）：
 * 1. authId 非空 + msg.id===authId：
 *    - type==='auth.ok' → 清 auth 超时 + 翻转 connected + 重置 reconnectAttempts + 清 authId + startHeartbeat（return true 消化）
 *    - 其他（type:'error' / 非预期 auth reply）→ 视为 auth 失败：设 authTimedOut 标志 + ws.close 触发 onclose→failed(auth)（return true）
 * 2. authId 非空 + msg.id!==authId（auth 完成前的握手期业务消息）→ warn + return true 丢弃（防止污染状态）
 * 3. authId 为空（本地模式或 auth 已完成）→ return false，走 messageHandler
 */
function intercept(msg: ServerMessage): boolean {
  if (authId === null) return false // 本地模式或 auth 已完成，放行
  if (msg.id === authId) {
    if (msg.type === ('auth.ok' as ServerMessage['type'])) {
      // auth 成功：清超时 + 翻转 connected（spec D2：connected = WS open + auth.ok）
      clearAuthTimer()
      authId = null
      state.value = 'connected'
      reconnectAttempts = 0
      reconnectStartedAt = null
      startHeartbeat()
      console.log('[ws] auth ok, connected')
      return true
    }
    // id 匹配但非 auth.ok（如 type:'error'）→ 视为 auth 失败，close 触发 onclose→failed(auth)
    console.warn('[ws] auth failed (non-ok reply), closing:', msg.type)
    authTimedOut = true
    try {
      ws?.close()
    // eslint-disable-next-line taste/no-silent-catch -- close 抛（已 close）吞掉，onclose 接管
    } catch {
      // 吞 close 异常
    }
    return true
  }
  // authId 非空但 id 不匹配：握手期收到业务消息，丢弃 + warn（不进 messageHandler）
  console.warn('[ws] message before auth ok, dropping:', msg.type, msg.id)
  return true
}

function scheduleReconnect(): void {
  if (!currentUrl) return
  // 重连上限兜底（设计文档 A4 §3.3）：尝试次数或总时长超限 → 放弃自动重连，置 failed(network)
  if (reconnectStartedAt === null) reconnectStartedAt = Date.now()
  if (
    reconnectAttempts >= MAX_RECONNECT_ATTEMPTS ||
    Date.now() - reconnectStartedAt > MAX_RECONNECT_DURATION_MS
  ) {
    console.warn('[ws] reconnect attempts exhausted, giving up (state=failed, reason=network)')
    setFailed('network')
    return
  }
  const delay = Math.min(
    RECONNECT_BASE_DELAY_MS * Math.pow(RECONNECT_BACKOFF_EXPONENT, reconnectAttempts),
    MAX_RECONNECT_DELAY_MS,
  )
  reconnectAttempts++
  state.value = 'reconnecting'
  console.log('[ws] reconnecting in', delay, 'ms (attempt', reconnectAttempts + ')')
  reconnectTimer = setTimeout(() => {
    // 重连时 opts 为 undefined，connect 内部从 currentAuthOpts 读（已保存供复用）
    connect(currentUrl!)
  }, delay)
}

function startHeartbeat(): void {
  heartbeatTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      send({ type: 'ping', payload: {} })
    }
  }, HEARTBEAT_INTERVAL_MS)
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

function clearAuthTimer(): void {
  if (authTimer) {
    clearTimeout(authTimer)
    authTimer = null
  }
}

function clearTimers(): void {
  stopHeartbeat()
  clearAuthTimer()
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

// ── Vite HMR：热重载后自动重连 ──────────────────────────────
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    // 保存 url 给新模块实例
    if (hmrUrl) {
      ;(import.meta.hot!.data as Record<string, unknown>).wsUrl = hmrUrl
    }
    // 关闭旧 WS，让新实例重连
    if (ws) {
      const old = ws
      ws = null
      old.onclose = null
      old.onerror = null
      old.onmessage = null
      old.close()
    }
    clearTimers()
  })

  // 热重载后若曾有 url，自动重连
  if (hmrUrl) {
    connect(hmrUrl)
  }
}
