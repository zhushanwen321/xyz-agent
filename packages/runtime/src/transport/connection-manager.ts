/**
 * ConnectionManager — WS 连接生命周期 + 心跳 + 连接池管理（C2 从 server.ts 抽出）。
 *
 * 职责：
 * - 持有 clients 连接池（Set<WebSocket>），供 broker.broadcast 遍历。
 * - WS 服务器生命周期：start（listen + 注册 connection 回调）/ stop（关闭 wss + http）。
 * - 心跳：每条消息重置计时器，超时关闭连接（防僵尸连接）。
 * - HTTP /health 端点（与 WS 同端口，简单存活探针）。
 *
 * 不含：消息路由（server.ts handleMessage）、消息发送（broker）、业务逻辑（handlers）。
 * 连接建立后把 ws + 解析出的 msg 通过注入的回调交给上层（RuntimeServer）处理。
 */
import { createServer, type Server as HttpServer } from 'node:http'
import { WebSocketServer, WebSocket, type WebSocket as WsType } from 'ws'
import type { ClientMessage } from '@xyz-agent/shared'
import { toErrorMessage } from '../utils/errors.js'
import type { ErrorDetails } from './message-context.js'

const HTTP_OK = 200
const HTTP_NOT_FOUND = 404
const MAX_WS_CLOSE_CODE = 4000
const HEARTBEAT_TIMEOUT_MS = 45_000

/**
 * 连接事件回调（由 RuntimeServer 注入）。
 * - onMessage：收到合法 ClientMessage，交 server 路由（返回 Promise，错误由调用方 catch）。
 * - onConnect：新连接建立，交 broker 推送 initial state。
 * - sendError：连接级解析/兜底错误回复（注入 broker.sendError，避免 ConnectionManager 依赖 broker）。
 */
export interface ConnectionCallbacks {
  onConnect(ws: WsType): void
  onMessage(msg: ClientMessage, ws: WsType): Promise<void>
  sendError(ws: WsType, code: string, message: string, id?: string, details?: ErrorDetails): void
}

export class ConnectionManager {
  private httpServer: HttpServer
  private wss: WebSocketServer
  /** 连接池——broker.broadcast 遍历此集合向所有客户端推送。 */
  readonly clients = new Set<WsType>()
  private heartbeatTimers = new Map<WsType, ReturnType<typeof setTimeout>>()

  constructor(
    private port: number,
    private callbacks: ConnectionCallbacks,
  ) {
    this.httpServer = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(HTTP_OK, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }))
      } else {
        res.writeHead(HTTP_NOT_FOUND)
        res.end()
      }
    })
    this.wss = new WebSocketServer({ server: this.httpServer })
  }

  /** 启动 HTTP + WS 监听；注册 connection 回调。 */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss.on('connection', (ws) => this.handleConnection(ws))
      this.httpServer.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`[runtime] port ${this.port} already in use, exiting`)
          process.exit(1)
        }
        reject(err)
      })
      this.httpServer.listen(this.port, () => {
        console.log(`[runtime] listening on port ${this.port}`)
        resolve()
      })
    })
  }

  // ── Connection ────────────────────────────────────────────────

  private handleConnection(ws: WsType): void {
    this.clients.add(ws)
    console.log(`[runtime] client connected (total: ${this.clients.size})`)
    this.callbacks.onConnect(ws)
    this.resetHeartbeat(ws)
    ws.on('message', (data) => {
      try {
        const msg: ClientMessage = JSON.parse(data.toString())
        this.resetHeartbeat(ws)
        this.callbacks.onMessage(msg, ws).catch((err) => {
          console.error('[runtime] unhandled error in handleMessage:', err)
          try {
            this.callbacks.sendError(ws, 'handler_error', toErrorMessage(err), msg.id)
          // eslint-disable-next-line taste/no-silent-catch -- ws may have already closed
          } catch { /* ws 可能已关闭 */ }
        })
      } catch { this.callbacks.sendError(ws, 'parse_error', 'Invalid JSON') }
    })
    ws.on('close', () => {
      this.clients.delete(ws)
      this.clearHeartbeat(ws)
      console.log(`[runtime] client disconnected (total: ${this.clients.size})`)
    })
    ws.on('error', (err) => {
      console.error('[runtime] ws error:', err)
      this.clients.delete(ws)
      this.clearHeartbeat(ws)
    })
  }

  private resetHeartbeat(ws: WsType): void {
    const existing = this.heartbeatTimers.get(ws)
    if (existing) clearTimeout(existing)
    this.heartbeatTimers.set(ws, setTimeout(() => {
      console.warn('[runtime] heartbeat timeout, closing connection')
      ws.close(MAX_WS_CLOSE_CODE, 'Heartbeat timeout')
    }, HEARTBEAT_TIMEOUT_MS))
  }

  private clearHeartbeat(ws: WsType): void {
    const timer = this.heartbeatTimers.get(ws)
    if (timer) { clearTimeout(timer); this.heartbeatTimers.delete(ws) }
  }

  /** 关闭：清理心跳计时器 + 关闭 WS / HTTP。 */
  async stop(): Promise<void> {
    for (const timer of this.heartbeatTimers.values()) {
      clearInterval(timer)
    }
    this.heartbeatTimers.clear()
    this.wss.close()
    return new Promise((resolve) => { this.httpServer.close(() => resolve()) })
  }
}

/** WS OPEN 状态码——broker.send 检测连接态用。 */
export const WS_OPEN = WebSocket.OPEN
