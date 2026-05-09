import { createServer, type Server as HttpServer } from 'node:http'
import { WebSocketServer, WebSocket, type WebSocket as WsType } from 'ws'
import type { ClientMessage, ServerMessage, ModelInfo } from '@xyz-agent/shared'
import { SessionPool } from './session-pool.js'
import * as providerStore from './provider-store.js'
import { updateToolPermissions } from './config-store.js'

const HTTP_OK = 200
const HTTP_NOT_FOUND = 404
const MAX_WS_CLOSE_CODE = 4000

const WS_OPEN = WebSocket.OPEN

/**
 * WebSocket server that routes ClientMessages to the appropriate
 * session-pool / provider-store handlers and pushes ServerMessages
 * back to the TUI client.
 */
export class SidecarServer {
  private httpServer: HttpServer
  private wss: WebSocketServer
  private pool = new SessionPool()
  private client: WsType | null = null
  private pushId = 0
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null

  private static HEARTBEAT_TIMEOUT = 30_000

  private nextPushId(): string {
    return `push_${++this.pushId}`
  }

  private resetHeartbeat(ws: WsType): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer)
    this.heartbeatTimer = setTimeout(() => {
      console.warn('[sidecar] heartbeat timeout, closing connection')
      ws.close(MAX_WS_CLOSE_CODE, 'Heartbeat timeout')
    }, SidecarServer.HEARTBEAT_TIMEOUT)
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  constructor(private port: number) {
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

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss.on('connection', (ws) => this.handleConnection(ws))
      this.httpServer.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`[sidecar] port ${this.port} already in use, exiting`)
          process.exit(1)
        }
        reject(err)
      })
      this.httpServer.listen(this.port, () => {
        console.log(`[sidecar] listening on port ${this.port}`)
        resolve()
      })
    })
  }

  // ── Connection handling ────────────────────────────────────────

  private handleConnection(ws: WsType): void {
    // 新连接踢掉旧连接（前端重连场景）
    if (this.client && this.client.readyState === WS_OPEN) {
      console.log('[sidecar] replacing existing client connection')
      this.client.close(MAX_WS_CLOSE_CODE, 'Replaced by new connection')
    }

    this.client = ws
    this.pool.bindWebSocket(ws)
    console.log('[sidecar] client connected')

    this.sendInitialState(ws)
    this.resetHeartbeat(ws)

    ws.on('message', (data) => {
      try {
        const msg: ClientMessage = JSON.parse(data.toString())
        // 收到任何消息都重置心跳
        this.resetHeartbeat(ws)
        this.handleMessage(msg, ws)
      } catch {
        this.sendError(ws, 'parse_error', 'Invalid JSON')
      }
    })

    ws.on('close', () => {
      if (this.client === ws) {
        this.client = null
        this.pool.unbindWebSocket()
      }
      this.clearHeartbeat()
      console.log('[sidecar] client disconnected')
    })

    ws.on('error', (err) => {
      console.error('[sidecar] ws error:', err)
      // ws error 后通常会触发 close，但如果没触发就主动清理
      if (this.client === ws) {
        this.client = null
        this.pool.unbindWebSocket()
      }
    })
  }

  private sendInitialState(ws: WsType): void {
    // Session list — 使用 grouped 格式，与 broadcastSessionList 一致
    const groups = this.pool.listGrouped()
    this.send(ws, { type: 'session.list', id: this.nextPushId(), payload: { groups } })

    // Provider list
    const providers = providerStore.listProviders()
    this.send(ws, { type: 'config.providers', id: this.nextPushId(), payload: { providers } })

    // Aggregated model list
    const models = this.aggregateModels(providers)
    this.send(ws, { type: 'model.list', id: this.nextPushId(), payload: { models } })
  }

  // ── Message routing ────────────────────────────────────────────

  private async handleMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    try {
      switch (msg.type) {
        // ── Ping ────────────────────────────────────────────────
        case 'ping':
          this.send(ws, { type: 'pong', id: msg.id, payload: {} })
          break

        // ── Session management ──────────────────────────────────
        case 'session.create': {
          const cwd = msg.payload.cwd as string | undefined
          console.log('[server] session.create cwd:', cwd)
          const session = await this.pool.create(cwd)
          console.log('[server] session.created:', session.id)
          this.send(ws, { type: 'session.created', id: msg.id, payload: { session } })
          this.broadcastSessionList()
          break
        }

        case 'session.delete': {
          const sessionId = msg.payload.sessionId as string
          await this.pool.delete(sessionId)
          this.send(ws, { type: 'session.deleted', id: msg.id, payload: { sessionId } })
          this.broadcastSessionList()
          break
        }

        case 'session.list': {
          const groups = this.pool.listGrouped()
          this.send(ws, { type: 'session.list', id: msg.id, payload: { groups } })
          break
        }

        case 'session.switch': {
          const sid = msg.payload.sessionId as string
          const summary = this.pool.getSummary(sid)
          if (summary) {
            // 推送 session 信息
            this.send(ws, { type: 'session.history', id: msg.id, payload: { session: summary } })
            // 推送历史消息
            try {
              const messages = await this.pool.getHistory(sid)
              this.send(ws, { type: 'session.history', payload: { sessionId: sid, messages } })
            } catch (e) {
              console.error('[sidecar] failed to load history for switch:', e)
            }
          } else {
            this.sendError(ws, 'not_found', `Session ${sid} not found`, msg.id)
          }
          break
        }

        case 'session.history': {
          const histId = msg.payload.sessionId as string
          const messages = await this.pool.getHistory(histId)
          this.send(ws, { type: 'session.history', id: msg.id, payload: { messages } })
          break
        }

        case 'session.compact': {
          const compactId = msg.payload.sessionId as string
          await this.pool.compact(compactId)
          this.send(ws, { type: 'session.compacting', id: msg.id, payload: { sessionId: compactId, status: 'compacting' } })
          break
        }

        case 'session.clear': {
          const clearId = msg.payload.sessionId as string
          await this.pool.clear(clearId)
          this.send(ws, { type: 'session.deleted', id: msg.id, payload: { sessionId: clearId } })
          break
        }

        // ── Messages ────────────────────────────────────────────
        case 'message.send': {
          const { sessionId, content } = msg.payload as { sessionId: string; content: string }
          await this.pool.sendMessage(sessionId, content)
          this.send(ws, { type: 'message.status', id: msg.id, payload: { sessionId, status: 'sent' } })
          break
        }

        case 'message.abort': {
          const abortId = msg.payload.sessionId as string
          await this.pool.abort(abortId)
          break
        }

        // ── Config ──────────────────────────────────────────────
        case 'config.getProviders': {
          const providers = providerStore.listProviders()
          this.send(ws, { type: 'config.providers', id: msg.id, payload: { providers } })
          break
        }

        case 'config.setProvider': {
          const { providerId, ...data } = msg.payload as Record<string, unknown>
          providerStore.setProvider(
            providerId as string,
            data as Parameters<typeof providerStore.setProvider>[1],
          )
          this.send(ws, {
            type: 'config.providerUpdated',
            id: msg.id,
            payload: { providerId },
          })
          this.broadcastProviderList()
          break
        }

        case 'config.deleteProvider': {
          const delId = msg.payload.providerId as string
          providerStore.deleteProvider(delId)
          this.send(ws, {
            type: 'config.providerUpdated',
            id: msg.id,
            payload: { providerId: delId, deleted: true },
          })
          this.broadcastProviderList()
          break
        }

        case 'config.setToolPermissions': {
          const permissions = msg.payload.permissions as Record<string, string>
          updateToolPermissions(permissions)
          this.send(ws, { type: 'config.providerUpdated', id: msg.id, payload: { saved: true } })
          break
        }

        // ── Models ──────────────────────────────────────────────
        case 'model.list': {
          const providers = providerStore.listProviders()
          const models = this.aggregateModels(providers)
          this.send(ws, { type: 'model.list', id: msg.id, payload: { models } })
          break
        }

        case 'model.switch': {
          const { sessionId, provider, modelId } = msg.payload as {
            sessionId: string
            provider: string
            modelId: string
          }
          await this.pool.switchModel(sessionId, provider, modelId)
          this.send(ws, {
            type: 'model.switched',
            id: msg.id,
            payload: { sessionId, provider, modelId },
          })
          break
        }

        // ── Tool approval ───────────────────────────────────────
        case 'tool.approve': {
          const { sessionId: taSid, toolCallId } = msg.payload as {
            sessionId: string
            toolCallId: string
          }
          await this.pool.approveTool(taSid, toolCallId)
          break
        }

        case 'tool.deny': {
          const { sessionId: tdSid, toolCallId: tdTid } = msg.payload as {
            sessionId: string
            toolCallId: string
          }
          await this.pool.denyTool(tdSid, tdTid)
          break
        }

        case 'tool.always_allow': {
          const { sessionId: alwSid, toolName } = msg.payload as {
            sessionId: string
            toolName: string
          }
          await this.pool.alwaysAllowTool(alwSid, toolName)
          break
        }

        default:
          this.sendError(ws, 'unknown_type', `Unknown message type: ${(msg as { type: string }).type}`, msg.id)
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.sendError(ws, 'handler_error', message, msg.id)
    }
  }

  // ── Helpers ────────────────────────────────────────────────────

  private send(ws: WsType, msg: ServerMessage): void {
    if (ws.readyState === WS_OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }

  private sendError(ws: WsType, code: string, message: string, id?: string): void {
    this.send(ws, { type: 'error', id, payload: { code, message } })
  }

  private broadcastSessionList(): void {
    if (!this.client) return
    const groups = this.pool.listGrouped()
    this.send(this.client, { type: 'session.list', id: this.nextPushId(), payload: { groups } })
  }

  private broadcastProviderList(): void {
    if (!this.client) return
    const providers = providerStore.listProviders()
    this.send(this.client, { type: 'config.providers', id: this.nextPushId(), payload: { providers } })
    const models = this.aggregateModels(providers)
    this.send(this.client, { type: 'model.list', id: this.nextPushId(), payload: { models } })
  }

  private aggregateModels(providers: ReturnType<typeof providerStore.listProviders>): ModelInfo[] {
    return providers.flatMap(p =>
      p.models.map(m => ({
        id: m,
        name: m,
        providerId: p.id,
        providerName: p.name,
      })),
    )
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  async stop(): Promise<void> {
    await this.pool.destroyAll()
    this.wss.close()
    return new Promise((resolve) => {
      this.httpServer.close(() => resolve())
    })
  }
}
