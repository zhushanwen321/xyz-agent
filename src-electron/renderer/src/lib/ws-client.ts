/**
 * WebSocket 客户端 —— 连接状态机 + 心跳 + 指数退避重连。
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
 * 依赖方向：无下游（暴露 connect/disconnect/send/getState/onMessage）
 */
import { ref, readonly } from 'vue'
import type { ClientMessage, ServerMessage } from '@xyz-agent/shared'
import { mockConnect, mockSend, mockDisconnect } from '../mock/mock-ws'

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

// ── 常量 ────────────────────────────────────────────────────
const HEARTBEAT_INTERVAL_MS = 15_000
const RECONNECT_BASE_DELAY_MS = 1_000
const RECONNECT_BACKOFF_EXPONENT = 2
const MAX_RECONNECT_DELAY_MS = 30_000

// ── 状态 ────────────────────────────────────────────────────
const state = ref<ConnectionState>('disconnected')
let ws: WebSocket | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempts = 0
let wsGeneration = 0
let currentUrl: string | null = null

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
export function getState() {
  return readonly(state)
}

/** 建立连接（已连接/连接中时幂等 no-op） */
export function connect(url: string): void {
  currentUrl = url

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
  ws = new WebSocket(url)
  console.log('[ws] connecting to', url)

  ws.onopen = () => {
    if (gen !== wsGeneration) return // 旧 WS 残余回调，忽略
    state.value = 'connected'
    reconnectAttempts = 0
    startHeartbeat()
  }

  ws.onmessage = (event) => {
    if (gen !== wsGeneration) return
    try {
      const msg = JSON.parse(event.data) as ServerMessage
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
  if (isMock) {
    mockDisconnect()
    state.value = 'disconnected'
    return
  }
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

/** 发送消息（连接骨架阶段仅用于心跳 ping） */
export function send(msg: ClientMessage): void {
  if (isMock) {
    mockSend(msg)
    return
  }
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

// ── 内部 ────────────────────────────────────────────────────

function scheduleReconnect(): void {
  if (!currentUrl) return
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

function clearTimers(): void {
  stopHeartbeat()
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
