/**
 * Transport 层 —— 封装 ws-client（R5），提供 connect/send/on 统一管道。
 *
 * 依赖方向：lib/ws-client（transport 是业务层对 ws-client 的唯一适配点）。
 *
 * 注：连接生命周期由 useConnection 统一管理（端口发现 + DEV 偏移 + runtime 重启重连）。
 * transport.connect 只做「确保就绪」——mock 自举 / 已知端口直连，不重复 useConnection
 * 的完整 fallback 链。业务命令发送前应确保 useConnection 已 init。
 */
import { watch } from 'vue'
import type { ClientMessage, ServerMessage } from '@xyz-agent/shared'
import { BASE_PORT } from '@xyz-agent/shared'
import * as wsClient from '@/lib/ws-client'
import { getRuntimePort } from '@/lib/ipc'

/** mock 模式自举 url（ws-client 内部按 isMock 走 mockConnect，url 仅占位） */
const MOCK_URL = 'mock://bootstrap'

/** 连接超时（ms）—— real 模式 runtime 不可达时避免 Promise 永挂 */
const CONNECT_TIMEOUT = 10_000

/** 建立 WS 连接（mock 模式 200ms 直进 connected）。幂等：ws-client 已处理重入。
 *  @throws 超过 CONNECT_TIMEOUT 仍未连接（联调阶段对齐用） */
export async function connect(): Promise<void> {
  const url = import.meta.env.VITE_MOCK === 'true'
    ? MOCK_URL
    : `ws://localhost:${(await getRuntimePort()) ?? BASE_PORT}`
  wsClient.connect(url)
  await waitForConnected()
}

/** 发送 ClientMessage（未连接时由 ws-client 决定丢弃，见 ws-client.send） */
export function send(msg: ClientMessage): void {
  wsClient.send(msg)
}

/** 订阅 ServerMessage（第 1 层：所有消息），返回取消函数 */
export function on(handler: (msg: ServerMessage) => void): () => void {
  return wsClient.onMessage(handler)
}

/** 等待 ws-client 进入 connected（mock 200ms；real 取决于 runtime）。
 *  超时防 Promise 永挂，错误场景有界。 */
function waitForConnected(): Promise<void> {
  const connState = wsClient.getState()
  if (connState.value === 'connected') return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      stop()
      reject(new Error(`transport: 连接超时（${CONNECT_TIMEOUT}ms，状态=${connState.value}）`))
    }, CONNECT_TIMEOUT)
    const stop = watch(connState, (s) => {
      if (s === 'connected') {
        clearTimeout(timer)
        stop()
        resolve()
      }
    })
  })
}
