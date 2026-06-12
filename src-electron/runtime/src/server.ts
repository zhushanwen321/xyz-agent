/* eslint max-lines: ["warn", {"max": 600, "skipBlankLines": true, "skipComments": true}] */

/**
 * SidecarServer — pure Transport layer.
 * Routes ClientMessages to Service instances and pushes
 * ServerMessages back to TUI clients via WebSocket.
 */
import { createServer, type Server as HttpServer } from 'node:http'
import { resolve } from 'node:path'
import { WebSocketServer, WebSocket, type WebSocket as WsType } from 'ws'
import type { ClientMessage, ServerMessage } from '@xyz-agent/shared'
import type { ISessionService, IConfigService, IModelService, IMessageBroker, IExtensionService, IPluginService } from './interfaces.js'
import { ExtensionTimeoutManager } from './extension-timeout-manager.js'
import { BridgeHandler } from './bridge-handler.js'
import { SettingsMessageHandler } from './settings-message-handler.js'
import { SessionMessageHandler } from './session-message-handler.js'
import { ExtensionMessageHandler } from './extension-message-handler.js'
import { PluginMessageHandler } from './plugin-message-handler.js'
import { TreeMessageHandler } from './tree-message-handler.js'
import { getPiAgentDir } from './pi-config-bridge.js'

const HTTP_OK = 200
const HTTP_NOT_FOUND = 404
const MAX_WS_CLOSE_CODE = 4000
const WS_OPEN = WebSocket.OPEN
const HEARTBEAT_TIMEOUT_MS = 45_000

export class SidecarServer implements IMessageBroker {
  private httpServer: HttpServer
  private wss: WebSocketServer
  private clients = new Set<WsType>()
  private pushId = 0
  private heartbeatTimers = new Map<WsType, ReturnType<typeof setTimeout>>()
  private projectRoot: string
  private sessionService!: ISessionService
  private configService!: IConfigService
  private modelService!: IModelService
  private treeService!: import('./services/tree-service.js').TreeService
  private extensionService?: IExtensionService
  private pluginService!: IPluginService

  // ── Message handlers (extracted) ────────────────────────────────
  private extensionTimeoutMgr = new ExtensionTimeoutManager()
  private bridgeHandler = new BridgeHandler(null)
  private settingsHandler = new SettingsMessageHandler(this as unknown as import('./settings-message-handler.js').SettingsHandlerContext)
  private sessionHandler = new SessionMessageHandler(this as unknown as import('./session-message-handler.js').SessionHandlerContext)
  private extensionHandler = new ExtensionMessageHandler(this as unknown as import('./extension-message-handler.js').ExtensionHandlerContext)
  private pluginMessageHandler = new PluginMessageHandler(this as unknown as import('./plugin-message-handler.js').PluginHandlerContext)
  private treeMessageHandler = new TreeMessageHandler(this as unknown as import('./tree-message-handler.js').TreeHandlerContext)

  setServices(session: ISessionService, config: IConfigService, model: IModelService, tree: import('./services/tree-service.js').TreeService, extension?: IExtensionService, plugin?: IPluginService): void {
    this.sessionService = session
    this.configService = config
    this.modelService = model
    this.treeService = tree
    if (extension) this.extensionService = extension
    if (plugin) {
      this.pluginService = plugin
      this.bridgeHandler = new BridgeHandler(plugin)
    }
  }

  constructor(private port: number, projectRoot?: string) {
    this.projectRoot = projectRoot ?? process.cwd()
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

  private nextPushId(): string { return `push_${++this.pushId}` }

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
    this.sendInitialState(ws)
    this.resetHeartbeat(ws)
    ws.on('message', (data) => {
      try {
        const msg: ClientMessage = JSON.parse(data.toString())
        this.resetHeartbeat(ws)
        this.handleMessage(msg, ws).catch((err) => {
          console.error('[runtime] unhandled error in handleMessage:', err)
          try {
            this.sendError(ws, 'handler_error', err instanceof Error ? err.message : String(err), msg.id)
          // eslint-disable-next-line taste/no-silent-catch -- ws may have already closed
          } catch { /* ws 可能已关闭 */ }
        })
      } catch { this.sendError(ws, 'parse_error', 'Invalid JSON') }
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

  private sendInitialState(ws: WsType): void {
    try {
      const groups = this.sessionService.listPersistedSessions()
      this.send(ws, { type: 'session.list', id: this.nextPushId(), payload: { groups } })
    // eslint-disable-next-line taste/no-silent-catch -- init: best-effort, single failure must not block others
    } catch (e) { console.error('[runtime] sendInitialState: session.list failed:', e) }
    try {
      const providers = this.configService.listProviders()
      this.send(ws, { type: 'config.providers', id: this.nextPushId(), payload: { providers } })
      const models = this.modelService.aggregateModels(providers)
      this.send(ws, { type: 'model.list', id: this.nextPushId(), payload: { models } })
    // eslint-disable-next-line taste/no-silent-catch -- init: best-effort, single failure must not block others
    } catch (e) { console.error('[runtime] sendInitialState: config.providers/model.list failed:', e) }
    try {
      const defaultModel = this.configService.getDefaultModel()
      if (defaultModel) {
        this.send(ws, { type: 'config.defaults', id: this.nextPushId(), payload: { defaultModel: `${defaultModel.provider}/${defaultModel.modelId}` } })
      }
    // eslint-disable-next-line taste/no-silent-catch -- init: best-effort, single failure must not block others
    } catch (e) { console.error('[runtime] sendInitialState: config.defaults failed:', e) }
    try {
      const skills = this.configService.loadSkills(this.projectRoot)
      this.send(ws, { type: 'config.skills', id: this.nextPushId(), payload: { skills } })
    // eslint-disable-next-line taste/no-silent-catch -- init: best-effort, single failure must not block others
    } catch (e) { console.error('[runtime] sendInitialState: config.skills failed:', e) }
    try {
      const agents = this.configService.loadAgents(this.projectRoot)
      this.send(ws, { type: 'config.agents', id: this.nextPushId(), payload: { agents } })
    // eslint-disable-next-line taste/no-silent-catch -- init: best-effort, single failure must not block others
    } catch (e) { console.error('[runtime] sendInitialState: config.agents failed:', e) }
    try {
      if (this.pluginService) {
        const plugins = this.pluginService.getDiscoveredPlugins()
        this.send(ws, { type: 'config.plugins', id: this.nextPushId(), payload: { plugins } })
      }
    // eslint-disable-next-line taste/no-silent-catch -- init: best-effort, single failure must not block others
    } catch (e) { console.error('[runtime] sendInitialState: config.plugins failed:', e) }
  }

  // ── Message routing ───────────────────────────────────────────

  private async handleMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    try {
      switch (msg.type) {
        case 'ping':
          return this.send(ws, { type: 'pong', id: msg.id, payload: {} })
        case 'session.create':
        case 'session.delete':
        case 'session.list':
        case 'session.switch':
        case 'session.history':
        case 'session.rename':
        case 'message.send':
        case 'message.abort':
        case 'message.steer':
        case 'message.follow_up':
          return this.sessionHandler.handleSessionMessage(msg, ws)
        case 'session.compact':
          return this.sessionHandler.handleSessionCompact(msg, ws)
        case 'session.tree-data':
        case 'session.tree-navigate':
        case 'session.tree-fork':
        case 'session.tree-capability':
        case 'session.tree-clone':
          return this.treeMessageHandler.handleTreeMessage(msg, ws)
        case 'extension.ui_response':
        case 'extension.list':
        case 'extension.toggle':
        case 'extension.install':
        case 'extension.uninstall':
        case 'extension.installDir':
        case 'extension.installGit':
        case 'extension.finishInstall':
        case 'extension.cancelInstall':
          return this.extensionHandler.handleExtensionMessage(msg, ws)
        case 'plugin.list':
        case 'plugin.toggle':
        case 'plugin.uninstall':
        case 'plugin.approvePermissions':
        case 'plugin.revokePermissions':
        case 'plugin.executeCommand':
        case 'plugin.config.get':
        case 'plugin.config.set':
        case 'plugin.install':
        case 'plugin.uiResponse':
          return this.pluginMessageHandler.handlePluginMessage(msg, ws)
        case 'file.read':
          return this.handleFileRead(msg, ws)
        default:
          if (!await this.settingsHandler.handleSettingsMessage(msg, ws)) {
            const rawMsg = msg as { type: string; payload?: { sessionId?: string } }
            this.sendError(ws, 'unknown_type', `Unknown message type: ${rawMsg.type}`, msg.id, rawMsg.payload?.sessionId)
          }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const sessionId = ('sessionId' in msg.payload ? msg.payload.sessionId : undefined) as string | undefined
      this.sendError(ws, 'handler_error', message, msg.id, sessionId)
    }
  }

  // ── IMessageBroker ──────────────────────────────────────────────

  send(ws: unknown, msg: ServerMessage): void {
    const typed = ws as WsType
    if (typed.readyState === WS_OPEN) typed.send(JSON.stringify(msg))
  }

  broadcast(msg: ServerMessage): void {
    for (const ws of this.clients) this.send(ws, msg)
  }

  sendError(ws: unknown, code: string, message: string, id?: string, sessionId?: string): void {
    const payload: Record<string, unknown> = { code, message }
    if (sessionId) payload.sessionId = sessionId
    this.send(ws, { type: 'error', id, payload })
  }

  // ── Broadcast helpers ──────────────────────────────────────────

  private broadcastSessionList(): void {
    this.broadcast({ type: 'session.list', id: this.nextPushId(), payload: { groups: this.sessionService.listPersistedSessions() } })
  }
  private broadcastProviderList(): void {
    const providers = this.configService.listProviders()
    this.broadcast({ type: 'config.providers', id: this.nextPushId(), payload: { providers } })
    this.broadcast({ type: 'model.list', id: this.nextPushId(), payload: { models: this.modelService.aggregateModels(providers) } })
  }
  private broadcastSkillList(): void {
    this.broadcast({ type: 'config.skills', id: this.nextPushId(), payload: { skills: this.configService.loadSkills(this.projectRoot) } })
  }
  private broadcastAgentList(): void {
    this.broadcast({ type: 'config.agents', id: this.nextPushId(), payload: { agents: this.configService.loadAgents(this.projectRoot) } })
  }

  // ── Extension timeout delegation ─────────────────────────────────

  registerExtensionTimeout(sessionId: string, requestId: string, method: string): void {
    this.extensionTimeoutMgr.registerTimeout(sessionId, requestId, method, () => {
      const defaultResponse = method === 'confirm' ? false : null
      const client = this.sessionService.getRpcClient(sessionId)
      if (client) {
        client.sendCommand('extension_ui_response', { id: requestId, response: defaultResponse }).catch((e: unknown) => {
          console.error('[runtime] extension timeout response failed:', e)
        })
      }
      this.broadcast({
        type: 'extension.ui_timeout',
        id: this.nextPushId(),
        payload: { sessionId, requestId },
      })
    })
  }

  clearExtensionTimeout(requestId: string): void {
    this.extensionTimeoutMgr.clearTimeout(requestId)
  }

  clearExtensionTimeoutsForSession(sessionId: string): void {
    this.extensionTimeoutMgr.clearForSession(sessionId)
  }

  async handleBridgeRequest(sessionId: string, requestId: string, method: string, data: Record<string, unknown>): Promise<void> {
    const client = this.sessionService.getRpcClient(sessionId)
    if (!client) {
      console.warn(`[server] bridge request for inactive session: ${sessionId}, method: ${method}`)
      return
    }
    await this.bridgeHandler.handleBridgeRequest(sessionId, requestId, method, data, client)
  }

  handleStatusSetUpdate(payload: { sessionId: string; key: string; text: string }): void {
    this.bridgeHandler.handleStatusSetUpdate(payload)
  }

  /** Handle file.read — reads a skill file and returns its text content.
   *  Restricted to skill directories for security (no arbitrary file read). */
  private async handleFileRead(msg: ClientMessage, ws: WsType): Promise<void> {
    const { path: filePath } = msg.payload as { path: string }
    if (!filePath || typeof filePath !== 'string') {
      this.send(ws, { type: 'file.read:error', id: msg.id, payload: { error: 'Missing or invalid path' } })
      return
    }
    const normalize = (p: string) => p.split(/[/\\]/).join('/')
    const absPath = normalize(resolve(filePath))
    const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? ''
    const allowedPrefixes = [
      // ~/.agents/skills is a global skill directory (not affected by XYZ_AGENT_DATA_DIR)
      normalize(resolve(homeDir, '.agents/skills')),
      normalize(resolve(getPiAgentDir(), 'skills')),
      normalize(resolve(getPiAgentDir(), 'npm')),
    ]
    if (!allowedPrefixes.some(prefix => absPath.startsWith(prefix + '/'))) {
      this.send(ws, { type: 'file.read:error', id: msg.id, payload: { error: 'Path outside allowed skill directories', path: filePath } })
      return
    }
    try {
      const fs = await import('fs/promises')
      const content = await fs.readFile(filePath, 'utf-8')
      this.send(ws, { type: 'file.read:result', id: msg.id, payload: { content, path: filePath } })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.send(ws, { type: 'file.read:error', id: msg.id, payload: { error: message, path: filePath } })
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  async stop(): Promise<void> {
    if (this.pluginService) await this.pluginService.shutdown()
    await this.sessionService.destroyAll()
    for (const timer of this.heartbeatTimers.values()) {
      clearInterval(timer)
    }
    this.heartbeatTimers.clear()
    this.wss.close()
    return new Promise((resolve) => { this.httpServer.close(() => resolve()) })
  }
}
