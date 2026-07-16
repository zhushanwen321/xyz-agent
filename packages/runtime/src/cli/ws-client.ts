/**
 * CLI WS client：连 runtime WebSocket，发 config.* 消息，等 reply。
 * 无业务逻辑，纯 transport。
 */
import { WebSocket } from 'ws'
import { randomUUID } from 'node:crypto'
import { discoverPort } from './port-discovery.js'

export interface RpcOptions {
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 5000

/**
 * 发一条 WS 消息给 runtime，等 reply（按 id 匹配）。
 * @param type ClientMessage type（如 'config.getProviders'）
 * @param payload 消息负载
 * @param options 超时配置
 * @returns runtime 的 reply 消息
 */
export async function rpc<T = Record<string, unknown>>(
  type: string,
  payload: Record<string, unknown>,
  options?: RpcOptions
): Promise<T> {
  const port = discoverPort()
  const id = randomUUID()
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return new Promise<T>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    let settled = false

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        ws.close()
        reject(new Error(`WebSocket RPC timeout (${timeoutMs}ms): ${type}`))
      }
    }, timeoutMs)

    ws.on('open', () => {
      ws.send(JSON.stringify({ type, id, payload }))
    })

    ws.on('message', (data) => {
      if (settled) return
      try {
        const msg = JSON.parse(data.toString())
        if (msg.id === id) {
          settled = true
          clearTimeout(timer)
          ws.close()
          resolve(msg as T)
        }
      } catch {
        // ignore non-JSON messages (heartbeat etc.)
      }
    })

    ws.on('error', (err) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        ws.close()
        reject(new Error(`Cannot connect to xyz-agent runtime: ${err.message}`))
      }
    })

    ws.on('close', () => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error('WebSocket closed unexpectedly'))
      }
    })
  })
}
