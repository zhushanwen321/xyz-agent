/**
 * SidecarServer — pure Transport layer.
 * Routes ClientMessages to Service instances and pushes
 * ServerMessages back to TUI clients via WebSocket.
 */
import { createServer, type Server as HttpServer } from 'node:http'
import { WebSocketServer, WebSocket, type WebSocket as WsType } from 'ws'
import type { ClientMessage, ServerMessage } from '@xyz-agent/shared'
import type { ISessionService, IConfigService, IModelService, IMessageBroker, IExtensionService, IPluginService } from './interfaces.js'
import { ExtensionTimeoutManager } from './extension-timeout-manager.js'
import { BridgeHandler } from './bridge-handler.js'
import { SettingsMessageHandler } from './settings-message-handler.js'
import { PluginMessageHandler } from './plugin-message-handler.js'
import { TreeMessageHandler } from './tree-message-handler.js'

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
  private extensionService!: IExtensionService
  private pluginService!: IPluginService

  // ── Extension UI request timeout tracking ───────────────────────
  private extensionTimeoutMgr = new ExtensionTimeoutManager()
  private bridgeHandler = new BridgeHandler(null)
  private settingsHandler = new SettingsMessageHandler(this as unknown as import('./settings-message-handler.js').SettingsHandlerContext)
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
        this.handleMessage(msg, ws)
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
    // 每个 init 消息独立 try-catch：单个失败不阻塞后续
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
        case 'session.clear':
        case 'session.restore':
        case 'session.rename':
        case 'message.send':
        case 'message.abort':
        case 'message.steer':
        case 'message.follow_up':
          return this.handleSessionMessage(msg, ws)
        case 'session.compact': return this.handleSessionCompact(msg, ws)
        case 'session.tree-data':
        case 'session.tree-navigate':
        case 'session.tree-fork':
        case 'session.tree-capability':
        case 'session.tree-clone':
          return this.treeMessageHandler.handleTreeMessage(msg, ws)
        // ── Extension messages ──────────────────────────────────────────
        case 'extension.ui_response':
        case 'extension.list':
        case 'extension.toggle':
        case 'extension.install':
        case 'extension.uninstall':
          return this.handleExtensionMessage(msg, ws)
        // ── Plugin messages ───────────────────────────────────────────
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

  /** Handle session.* and message.* messages */
  private async handleSessionMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    switch (msg.type) {
      case 'session.create': {
        const session = await this.sessionService.create(msg.payload.cwd, msg.payload.label)
        this.send(ws, { type: 'session.created', id: msg.id, payload: { session } })
        return this.broadcastSessionList()
      }
      case 'session.delete': {
        const delSid = msg.payload.sessionId
        this.extensionTimeoutMgr.clearForSession(delSid)
        await this.sessionService.delete(delSid)
        this.send(ws, { type: 'session.deleted', id: msg.id, payload: { sessionId: delSid } })
        return this.broadcastSessionList()
      }
      case 'session.list':
        return this.send(ws, { type: 'session.list', id: msg.id, payload: { groups: this.sessionService.listPersistedSessions() } })
      case 'session.switch': {
        const switchId = msg.payload.sessionId
        const summary = this.sessionService.getSummary(switchId)
        if (summary) {
          try {
            const messages = await this.sessionService.getHistory(switchId)
            this.send(ws, { type: 'session.history', id: msg.id, payload: { sessionId: switchId, session: summary, messages } })
          } catch (e) {
            console.error('[runtime] failed to load history for switch:', e)
            this.send(ws, { type: 'session.history', id: msg.id, payload: { sessionId: switchId, session: summary, messages: [] } })
          }
        } else {
          try {
            const restored = await this.sessionService.restoreSession(switchId)
            const messages = await this.sessionService.getHistory(switchId)
            this.send(ws, { type: 'session.history', id: msg.id, payload: { sessionId: switchId, session: restored, messages } })
          } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e)
            const isENOENT = errMsg.includes('ENOENT')
            const userMsg = isENOENT
              ? `Session file missing — the session was not saved properly. Error: ${errMsg}`
              : `Session ${switchId} not found or restore failed`
            console.error('[runtime] session.switch auto-restore failed:', errMsg)
            this.sendError(ws, isENOENT ? 'file_not_found' : 'not_found', userMsg, msg.id, switchId)
          }
        }
        return
      }
      case 'session.history': {
        const messages = await this.sessionService.getHistory(msg.payload.sessionId)
        return this.send(ws, { type: 'session.history', id: msg.id, payload: { sessionId: msg.payload.sessionId, messages } })
      }
      case 'session.clear': {
        await this.sessionService.clear(msg.payload.sessionId)
        return this.send(ws, { type: 'session.deleted', id: msg.id, payload: { sessionId: msg.payload.sessionId } })
      }
      case 'session.restore': {
        const session = await this.sessionService.restoreSession(msg.payload.sessionId)
        this.send(ws, { type: 'session.restored', id: msg.id, payload: { session } })
        return this.broadcastSessionList()
      }
      case 'session.rename': {
        await this.sessionService.renameSession(msg.payload.sessionId, msg.payload.name)
        this.send(ws, { type: 'session.renamed', id: msg.id, payload: { sessionId: msg.payload.sessionId, name: msg.payload.name } })
        return this.broadcastSessionList()
      }
      case 'message.send': {
        const { sessionId, content, subagent } = msg.payload
        if (subagent) {
          await this.sessionService.sendSubagentMessage(sessionId, subagent.agent, subagent.task, content)
        } else {
          await this.sessionService.sendMessage(sessionId, content)
        }
        return this.send(ws, { type: 'message.status', id: msg.id, payload: { sessionId, status: 'sent' } })
      }
      case 'message.steer': {
        const steerSid = msg.payload.sessionId
        // Abort current processing then send new message
        try { await this.sessionService.abort(steerSid) } catch { /* session may not be active */ }
        await this.sessionService.sendMessage(steerSid, msg.payload.content)
        return this.send(ws, { type: 'message.status', id: msg.id, payload: { sessionId: steerSid, status: 'sent' } })
      }
      case 'message.follow_up': {
        // Queue message without interrupting — just send, pi will queue internally
        const followSid = msg.payload.sessionId
        await this.sessionService.sendMessage(followSid, msg.payload.content)
        return this.send(ws, { type: 'message.status', id: msg.id, payload: { sessionId: followSid, status: 'queued' } })
      }
      case 'message.abort':
        return await this.sessionService.abort(msg.payload.sessionId)
    }
  }

  /** Handle session.tree-* messages */
  private async handleExtensionMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    switch (msg.type) {
      case 'extension.ui_response': {
        const { sessionId: extSid, requestId, result: extResult } = msg.payload

        if (this.extensionTimeoutMgr.isBridgeRequest(requestId)) {
          this.extensionTimeoutMgr.removeBridgeRequest(requestId)
          return
        }

        const client = this.sessionService.getRpcClient(extSid)
        if (!client) {
          this.extensionTimeoutMgr.clearTimeout(requestId)
          return this.sendError(ws, 'handler_error', `No active session for extension response: ${extSid}`, msg.id, extSid)
        }
        await client.sendCommand('extension_ui_response', { id: requestId, response: extResult ?? null })
        // Only clear timeout after successful sendCommand — if it throws, timeout callback will handle it
        this.extensionTimeoutMgr.clearTimeout(requestId)
        return
      }
      case 'extension.list': {
        if (!this.extensionService) {
          return this.send(ws, { type: 'config.extensions', id: msg.id, payload: { extensions: [] } })
        }
        const extensions = await this.extensionService.scanExtensions()
        return this.send(ws, { type: 'config.extensions', id: msg.id, payload: { extensions } })
      }
      case 'extension.toggle': {
        if (!this.extensionService) {
          return this.sendError(ws, 'handler_error', 'Extension service not available', msg.id)
        }
        try {
          await this.extensionService.toggleExtension(msg.payload.name, msg.payload.enabled)
          const extensions = await this.extensionService.scanExtensions()
          return this.send(ws, { type: 'config.extensions', id: msg.id, payload: { extensions } })
        } catch (e) {
          return this.sendError(ws, 'toggle_failed', e instanceof Error ? e.message : String(e), msg.id)
        }
      }
      case 'extension.install': {
        if (!this.extensionService) {
          return this.sendError(ws, 'handler_error', 'Extension service not available', msg.id)
        }
        try {
          await this.extensionService.installExtension(msg.payload.source)
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e)
          return this.sendError(ws, 'install_failed', errMsg, msg.id)
        }
        const installed = await this.extensionService.scanExtensions()
        return this.send(ws, { type: 'config.extensions', id: msg.id, payload: { extensions: installed } })
      }
      case 'extension.uninstall': {
        if (!this.extensionService) {
          return this.sendError(ws, 'handler_error', 'Extension service not available', msg.id)
        }
        try {
          await this.extensionService.uninstallExtension(msg.payload.name)
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e)
          return this.sendError(ws, 'uninstall_failed', errMsg, msg.id)
        }
        const uninstalled = await this.extensionService.scanExtensions()
        return this.send(ws, { type: 'config.extensions', id: msg.id, payload: { extensions: uninstalled } })
      }
    }
  }
  private handleSessionCompact(msg: Extract<ClientMessage, { type: 'session.compact' }>, ws: WsType): void {
    const compactId = msg.payload.sessionId
    const startTime = Date.now()
    console.log('[server] session.compact: sessionId=' + compactId)
    const runCompact = async () => {
      // eslint-disable-next-line taste/no-silent-catch -- compact: error already logged, caller informed via broadcast
      try { await this.sessionService.compact(compactId) } catch (e) {
        console.error('[server] session.compact: failed, sessionId=' + compactId + ', error=' + (e instanceof Error ? e.message : String(e)))
      }
      console.log('[server] session.compact: completed, sessionId=' + compactId + ', elapsed=' + (Date.now() - startTime) + 'ms')
    }
    if (!this.sessionService.hasActiveSession(compactId)) {
      this.sessionService.restoreSession(compactId).then(() => {
        console.log('[server] session.compact: auto-restored, sessionId=' + compactId)
        runCompact()
      }).catch((e) => {
        console.error('[server] session.compact: auto-restore failed, sessionId=' + compactId)
        this.sendError(ws, 'session.compact_failed', 'Failed to restore session for compact: ' + (e instanceof Error ? e.message : String(e)), msg.id, compactId)
      })
    } else { runCompact() }
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

  // ── Extension timeout management ─────────────────────────────────


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
