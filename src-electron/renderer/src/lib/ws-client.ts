import { ref, readonly } from 'vue'
import type { ClientMessage, ServerMessage } from '@xyz-agent/shared'
import { emit } from './event-bus'
import { mockConnect, mockSend, mockDisconnect } from '../mock/mock-ws'

// Vite HMR data — persists WebSocket URL across hot reloads
let hmrUrl = (import.meta.hot?.data as { wsUrl?: string } | undefined)?.wsUrl ?? null

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

const state = ref<ConnectionState>('disconnected')
let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let messageQueue: ClientMessage[] = []
let reconnectAttempts = 0
let wsGeneration = 0
const RECONNECT_BASE_DELAY_MS = 1000
const RECONNECT_BACKOFF_EXPONENT = 2
const HEARTBEAT_INTERVAL_MS = 15000
const MAX_RECONNECT_DELAY = 30000
const MAX_QUEUE_SIZE = 100

const isMock = import.meta.env.VITE_MOCK === 'true'

export function connect(url: string): void {
  if (isMock) {
    mockConnect((s) => { state.value = s })
    return
  }

  // Save URL for HMR reconnect
  hmrUrl = url

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return

  state.value = 'connecting'
  const gen = ++wsGeneration
  ws = new WebSocket(url)
  console.log('[ws] connecting to', url)

  ws.onopen = () => {
    if (gen !== wsGeneration) return  // 旧 WS 的残余回调，忽略
    state.value = 'connected'
    reconnectAttempts = 0
    // G5: runtime 重启后旧 session-scoped 消息无意义，清空队列不重发。
    // 心跳由独立定时器发送，不受影响。
    if (messageQueue.length > 0) {
      console.log('[ws] connected, dropping ' + messageQueue.length + ' queued messages (runtime restart)')
      messageQueue = []
    }
    startHeartbeat()
  }

  ws.onmessage = (event) => {
    try {
      const msg: ServerMessage = JSON.parse(event.data)
      emit(msg.type, msg)
    // eslint-disable-next-line taste/no-silent-catch -- parse failure on non-JSON message, skip
    } catch (e) {
      console.error('[ws] parse error:', e)
    }
  }

  ws.onclose = () => {
    if (gen !== wsGeneration) return  // 旧 WS 的残余回调，不干扰新 WS 的心跳/重连
    console.log('[ws] disconnected')
    state.value = 'disconnected'
    stopHeartbeat()
    scheduleReconnect(url)
  }

  ws.onerror = (err) => {
    console.error('[ws] error:', err)
    ws?.close()
  }
}

function scheduleReconnect(url: string): void {
  const delay = Math.min(RECONNECT_BASE_DELAY_MS * Math.pow(RECONNECT_BACKOFF_EXPONENT, reconnectAttempts), MAX_RECONNECT_DELAY)
  reconnectAttempts++
  state.value = 'reconnecting'
  console.log('[ws] reconnecting in', delay, 'ms (attempt', reconnectAttempts + ')')
  reconnectTimer = setTimeout(() => connect(url), delay)
}

function startHeartbeat(): void {
  heartbeatTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping', payload: {} }))
    }
  }, HEARTBEAT_INTERVAL_MS)
}

function stopHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = null
}

export function disconnect(): void {
  if (isMock) {
    mockDisconnect()
    state.value = 'disconnected'
    return
  }
  console.log('[ws] disconnecting')
  // 递增 generation 使旧 WS 的回调失效
  wsGeneration++
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = null
  stopHeartbeat()
  ws?.close()
  ws = null
  state.value = 'disconnected'
}

export function send(msg: ClientMessage): void {
  if (isMock) {
    mockSend(msg)
    return
  }
  if (ws?.readyState === WebSocket.OPEN) {
    if (import.meta.env.DEV) {
      console.debug('[ws] send:', msg.type, msg.payload)
    }
    try {
      ws.send(JSON.stringify(msg))
    } catch(e) {
      console.error('[ws] send error:', e)
      // 发送失败，入列等待重连后重发
      enqueueMessage(msg)
    }
  } else {
    console.warn('[ws] queuing message (ws not open):', msg.type, 'readyState=' + ws?.readyState + ', queueSize=' + messageQueue.length)
    enqueueMessage(msg)
  }
}

function enqueueMessage(msg: ClientMessage): void {
  if (messageQueue.length >= MAX_QUEUE_SIZE) {
    const dropped = messageQueue.shift()
    console.warn('[ws] queue full, dropping oldest message:', dropped?.type)
  }
  messageQueue.push(msg)
}

export function getState() {
  return readonly(state)
}

// ── Vite HMR — reconnect WebSocket after hot reload ───────────
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    // Save WS URL for the new module instance
    if (hmrUrl) {
      (import.meta.hot!.data as Record<string, unknown>).wsUrl = hmrUrl
    }
    // Close old WebSocket so reconnect can happen
    if (ws) {
      const old = ws
      ws = null
      old.onclose = null
      old.onerror = null
      old.onmessage = null
      old.close()
    }
  })

  // Reconnect if we had a URL before HMR
  if (hmrUrl) {
    connect(hmrUrl)
  }
}
