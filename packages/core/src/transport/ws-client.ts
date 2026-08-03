/**
 * WebSocket 客户端 —— 连接状态机 + 心跳 + 指数退避重连（core 版）。
 *
 * 自 packages/renderer/src/lib/ws-client.ts（重建版）迁入，保留所有运行时不变量：
 *
 * [HISTORICAL] 不变量：
 * 1. 4 态状态机：disconnected → connecting → connected（onclose → reconnecting → connecting...）
 * 2. 心跳：15s 发 ping，runtime 不回 pong 会主动断（触发重连）
 * 3. 指数退避重连：1s 起、×2、上限 30s
 * 4. generation 计数：新连接 ++generation，旧 WS 的残余回调（onopen/onclose/onmessage）
 *    检查 gen !== wsGeneration 时直接 return，不干扰新连接
 *
 * 与 renderer 版的差异（迁移改造）：
 * - new WebSocket(url) → getPlatform().webSocket.create(url)（平台注入，mock 由 platform
 *   的 webSocket factory 决定，ws-client 不再感知 VITE_MOCK / mock-ws）
 * - 删除 import.meta.hot HMR 块（core headless 无 HMR）
 * - ConnectionState 含 restarting/failed（IPC 驱动，7 导出签名不变）
 *
 * 依赖方向：platform/port（getPlatform）→ 无下游（暴露 connect/disconnect/send/getState/onMessage）
 */
import { ref, readonly } from 'vue'
import type { ClientMessage, ServerMessage } from '@xyz-agent/shared'
import { getPlatform, WS_READY_STATE, type WebSocketLike } from '../platform/port'

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'restarting' // runtime 崩溃，主进程正在拉起新实例（来自 IPC runtime-restarting）
  | 'failed'     // runtime 重启用尽，需用户手动重试（来自 IPC runtime-failed）

// ── 常量 ────────────────────────────────────────────────────
const HEARTBEAT_INTERVAL_MS = 15_000
const RECONNECT_BASE_DELAY_MS = 1_000
const RECONNECT_BACKOFF_EXPONENT = 2
const MAX_RECONNECT_DELAY_MS = 30_000
/** 重连尝试上限（设计文档 A4 §3.3）：超此不再自动重连，置 failed 待用户手动重试 */
const MAX_RECONNECT_ATTEMPTS = 20
/** 重连总时长上限（ms）：超过即放弃，避免长时间无意义重试占用资源 */
const MAX_RECONNECT_DURATION_MS = 60_000

// ── 状态 ────────────────────────────────────────────────────
const state = ref<ConnectionState>('disconnected')
let ws: WebSocketLike | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempts = 0
let wsGeneration = 0
let currentUrl: string | null = null
/** 本轮重连起始时间戳（首次 scheduleReconnect 设置，connect 成功后置 null 重置） */
let reconnectStartedAt: number | null = null

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
export function getState() {
  return readonly(state)
}

/**
 * 设置为 restarting 态（收到 IPC runtime-restarting 时调，useConnection 编排）。
 * 断开当前 WS（死端口）并停止自动重连——等主进程拉起新实例后推新端口再 connect。
 */
export function setRestarting(): void {
  disconnect() // 停止在死端口上的自动重连，避免与 restarting 状态打架
  state.value = 'restarting'
}

/**
 * 设置为 failed 态（收到 IPC runtime-failed 时调）。
 * 停止自动重连，等用户手动重试。
 */
export function setFailed(): void {
  clearTimers()
  state.value = 'failed'
}

/** 建立连接（已连接/连接中时幂等 no-op） */
export function connect(url: string): void {
  currentUrl = url

  // 幂等：已连接或连接中，不重复建连
  if (ws && (ws.readyState === WS_READY_STATE.OPEN || ws.readyState === WS_READY_STATE.CONNECTING)) return

  state.value = 'connecting'
  const gen = ++wsGeneration
  ws = getPlatform().webSocket.create(url)
  console.log('[ws] connecting to', url)

  ws.onopen = () => {
    if (gen !== wsGeneration) return // 旧 WS 残余回调，忽略
    state.value = 'connected'
    reconnectAttempts = 0
    // 连接成功 → 重置重连计时窗口（下次掉线重新开始计数）
    reconnectStartedAt = null
    startHeartbeat()
  }

  ws.onmessage = (event) => {
    if (gen !== wsGeneration) return
    try {
      const msg = JSON.parse(String(event.data)) as ServerMessage
      messageHandler?.(msg)
    // eslint-disable-next-line taste/no-silent-catch -- 非 JSON 消息解析失败，跳过
    } catch (e) {
      console.error('[ws] parse error:', e)
    }
  }

  ws.onclose = () => {
    if (gen !== wsGeneration) return // 旧 WS 残余回调，不干扰新连接
    state.value = 'disconnected'
    stopHeartbeat()
    scheduleReconnect()
  }

  ws.onerror = (err) => {
    console.error('[ws] error:', err)
    ws?.close()
  }
}

/** 主动断开（不触发重连） */
export function disconnect(): void {
  // 递增 generation 使旧 WS 的回调失效
  wsGeneration++
  clearTimers()
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
 */
export function send(msg: ClientMessage): boolean {
  if (ws?.readyState === WS_READY_STATE.OPEN) {
    ws.send(JSON.stringify(msg))
    return true
  }
  return false
}

// ── 内部 ────────────────────────────────────────────────────

function scheduleReconnect(): void {
  if (!currentUrl) return
  // 重连上限兜底（设计文档 A4 §3.3）：尝试次数或总时长超限 → 放弃自动重连，置 failed
  if (reconnectStartedAt === null) reconnectStartedAt = Date.now()
  if (
    reconnectAttempts >= MAX_RECONNECT_ATTEMPTS ||
    Date.now() - reconnectStartedAt > MAX_RECONNECT_DURATION_MS
  ) {
    console.warn('[ws] reconnect attempts exhausted, giving up (state=failed)')
    setFailed()
    return
  }
  const delay = Math.min(
    RECONNECT_BASE_DELAY_MS * Math.pow(RECONNECT_BACKOFF_EXPONENT, reconnectAttempts),
    MAX_RECONNECT_DELAY_MS,
  )
  reconnectAttempts++
  state.value = 'reconnecting'
  console.log('[ws] reconnecting in', delay, 'ms (attempt', reconnectAttempts + ')')
  reconnectTimer = setTimeout(() => connect(currentUrl!), delay)
}

function startHeartbeat(): void {
  heartbeatTimer = setInterval(() => {
    if (ws?.readyState === WS_READY_STATE.OPEN) {
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

function clearTimers(): void {
  stopHeartbeat()
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}
