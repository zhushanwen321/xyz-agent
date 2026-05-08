import { createServer, type Server as HttpServer } from 'node:http'
import { WebSocketServer, WebSocket, type WebSocket as WsType } from 'ws'
import type { ClientMessage, ServerMessage, ModelInfo } from '@xyz-agent/shared'
import { SessionPool } from './session-pool.js'
import * as providerStore from './provider-store.js'

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
    if (this.client) {
      ws.close(MAX_WS_CLOSE_CODE, 'Only one client allowed')
      return
    }

    this.client = ws
    this.pool.bindWebSocket(ws)
    console.log('[sidecar] client connected')

    this.sendInitialState(ws)

    ws.on('message', (data) => {
      try {
        const msg: ClientMessage = JSON.parse(data.toString())
        this.handleMessage(msg, ws)
      } catch {
        this.sendError(ws, 'parse_error', 'Invalid JSON')
      }
    })

    ws.on('close', () => {
      this.client = null
      this.pool.unbindWebSocket()
      console.log('[sidecar] client disconnected')
    })

    ws.on('error', (err) => {
      console.error('[sidecar] ws error:', err)
    })
  }

  private sendInitialState(ws: WsType): void {
    // Session list
    const sessions = this.pool.listAll()
    this.send(ws, { type: 'session.list', payload: { sessions } })

    // Provider list
    const providers = providerStore.listProviders()
    this.send(ws, { type: 'config.providers', payload: { providers } })

    // Aggregated model list
    const models = this.aggregateModels(providers)
    this.send(ws, { type: 'model.list', payload: { models } })
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
          const session = await this.pool.create(cwd)
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
            this.send(ws, { type: 'session.history', id: msg.id, payload: { session: summary } })
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

        // ── Messages ────────────────────────────────────────────
        case 'message.send': {
          const { sessionId, content } = msg.payload as { sessionId: string; content: string }
          await this.pool.sendMessage(sessionId, content)
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
    this.send(this.client, { type: 'session.list', payload: { groups } })
  }

  private broadcastProviderList(): void {
    if (!this.client) return
    const providers = providerStore.listProviders()
    this.send(this.client, { type: 'config.providers', payload: { providers } })
    const models = this.aggregateModels(providers)
    this.send(this.client, { type: 'model.list', payload: { models } })
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
