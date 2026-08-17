/**
 * WebSocket 客户端 —— 连接状态机 + 心跳 + 指数退避重连（core 版）。
 *
 * 自 packages/renderer/src/lib/ws-client.ts（重建版）迁入，保留所有运行时不变量：
 *
 * [HISTORICAL] 不变量：
 * 1. 4 态状态机：disconnected → connecting → connected（onclose → reconnecting → connecting...）
 * 2. 心跳：15s 发 ping 保活（仅 keepalive，不跟踪 pong；死连接检测靠 TCP 层 + IPC supervisor
 *    事件 runtime-restarting/runtime-failed 驱动，非 pong 超时）
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
/** 重连总时长上限（ms）：超过即放弃，置 failed 待用户手动重试，避免长时间无意义重试占用资源。
 *  说明：曾配 attempts 计数上限（MAX_RECONNECT_ATTEMPTS=20），但指数退避（1+2+4+8+16+30…）
 *  累积约第 6-7 次即跨 60s → duration cap 先触发，attempts 永不可达，该常量为死代码已删除。
 *  放弃自动重连的判定唯由本时长上限决定。 */
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
  // 重置重连簿记：failed 为终止态，残留的 reconnectAttempts/reconnectStartedAt（约 60s 前的旧值）
  // 会让后续用户重试 / visibility 重连在首次掉线时立即被判超时 → 一次失败即回 failed，指数退避失效。
  reconnectAttempts = 0
  reconnectStartedAt = null
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
    let parsed: unknown
    try {
      parsed = JSON.parse(String(event.data))
    } catch (e) {
      // JSON 解析失败：仅记日志跳过（dispatch 已移出 try，handler 抛错不再被此处吞掉）
      console.error('[ws] parse error:', e)
      return
    }
    if (!isServerMessage(parsed)) {
      console.warn('[ws] dropping malformed (non-ServerMessage) inbound:', parsed)
      return
    }
    messageHandler?.(parsed)
  }

  ws.onclose = () => {
    if (gen !== wsGeneration) return // 旧 WS 残余回调，不干扰新连接
    state.value = 'disconnected'
    stopHeartbeat()
    scheduleReconnect()
  }

  ws.onerror = (err) => {
    if (gen !== wsGeneration) return // 旧 WS 残余回调，忽略（避免误 close 掉已被新 gen 取代的当前 socket）
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

/**
 * 入站消息运行时形状守卫（MF-5：替代 `JSON.parse(...) as ServerMessage` unsafe cast）。
 * 仅做最小形状校验：type 为字符串 + payload 非 null。不验证 type 是否在已知 ServerMessageType
 * 联合内（未知 type 由下游 dispatcher 兜底分支处理），避免过度收紧静默丢弃合法 runtime 消息。
 * ServerMessage 的 payload 恒为对象（pong / session.writeSegments:result 为 Record<string,never>={}），
 * 故 payload!=null 不会误杀任何合法变体。
 */
function isServerMessage(x: unknown): x is ServerMessage {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { type?: unknown }).type === 'string' &&
    (x as { payload?: unknown }).payload != null
  )
}

function scheduleReconnect(): void {
  if (!currentUrl) return
  // 重连时长上限兜底（设计文档 A4 §3.3）：总时长超 MAX_RECONNECT_DURATION_MS → 放弃自动重连，置 failed。
  if (reconnectStartedAt === null) reconnectStartedAt = Date.now()
  if (Date.now() - reconnectStartedAt > MAX_RECONNECT_DURATION_MS) {
    console.warn('[ws] reconnect duration exceeded, giving up (state=failed)')
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
