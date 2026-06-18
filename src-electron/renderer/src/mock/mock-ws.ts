/**
 * Mock WebSocket —— VITE_MOCK=true 时替代真实 WS 连接。
 *
 * 重建最小版：只模拟连接状态机（connecting → connected），
 * 不灌业务数据（连接骨架不需要 session/chat 数据）。
 * mockSend 只处理 ping → pong（维持心跳语义）。
 *
 * 后续加业务功能时，在此扩展 mock 数据响应（参考 git 历史的 mock/data.ts）。
 *
 * 依赖方向：被 ws-client 调用（ws-client 把状态回调 + 消息回调注入）。
 * 注意：mock-ws 不 import ws-client（避免循环依赖），回调由 ws-client 传入。
 */
import type { ClientMessage, ServerMessage } from '@xyz-agent/shared'

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

let stateCallback: ((state: ConnectionState) => void) | null = null
let messageCallback: ((msg: ServerMessage) => void) | null = null

/**
 * 模拟连接：200ms 延迟后进入 connected。
 * @param onStateChange 状态回调（ws-client 注入）
 * @param onMessage 消息回调（ws-client 注入，mock 回灌消息时调用）
 */
export function mockConnect(
  onStateChange: (state: ConnectionState) => void,
  onMessage: (msg: ServerMessage) => void,
): void {
  stateCallback = onStateChange
  messageCallback = onMessage
  onStateChange('connecting')
  setTimeout(() => {
    onStateChange('connected')
  }, 200)
}

/** 模拟断开 */
export function mockDisconnect(): void {
  stateCallback?.('disconnected')
  stateCallback = null
  messageCallback = null
}

/** 模拟消息发送：ping → pong，其余 no-op */
export function mockSend(msg: ClientMessage): void {
  if (msg.type === 'ping') {
    // 心跳响应：延迟回灌 pong，模拟网络往返
    const pong: ServerMessage = { type: 'pong', payload: {} }
    setTimeout(() => messageCallback?.(pong), 10)
  }
  // 其余消息类型：连接骨架阶段不处理，后续扩展
}

