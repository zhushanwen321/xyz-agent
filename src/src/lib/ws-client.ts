import { ref, readonly } from 'vue'
import type { ClientMessage, ServerMessage } from '@xyz-agent/shared'
import { emit } from './event-bus'

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

const state = ref<ConnectionState>('disconnected')
let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let messageQueue: ClientMessage[] = []
let reconnectAttempts = 0
const RECONNECT_BASE_DELAY_MS = 1000
const RECONNECT_BACKOFF_EXPONENT = 2
const HEARTBEAT_INTERVAL_MS = 30000
const MAX_RECONNECT_DELAY = 30000

export function connect(url: string): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return

  state.value = 'connecting'
  ws = new WebSocket(url)

  ws.onopen = () => {
    state.value = 'connected'
    reconnectAttempts = 0
    // Flush queued messages
    for (const msg of messageQueue) {
      ws?.send(JSON.stringify(msg))
    }
    messageQueue = []
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
    state.value = 'disconnected'
    stopHeartbeat()
    scheduleReconnect(url)
  }

  ws.onerror = () => {
    ws?.close()
  }
}

function scheduleReconnect(url: string): void {
  const delay = Math.min(RECONNECT_BASE_DELAY_MS * Math.pow(RECONNECT_BACKOFF_EXPONENT, reconnectAttempts), MAX_RECONNECT_DELAY)
  reconnectAttempts++
  state.value = 'reconnecting'
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
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = null
  stopHeartbeat()
  ws?.close()
  ws = null
  state.value = 'disconnected'
}

export function send(msg: ClientMessage): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  } else {
    messageQueue.push(msg)
  }
}

export function getState() {
  return readonly(state)
}
