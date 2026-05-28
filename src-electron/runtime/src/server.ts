/**
 * SidecarServer — pure Transport layer.
 * Routes ClientMessages to Service instances and pushes
 * ServerMessages back to TUI clients via WebSocket.
 */
import { createServer, type Server as HttpServer } from 'node:http'
import { WebSocketServer, WebSocket, type WebSocket as WsType } from 'ws'
import type { ClientMessage, ServerMessage } from '@xyz-agent/shared'
import type { ISessionService, IConfigService, IModelService, IMessageBroker, IExtensionService, IPluginService } from './interfaces.js'

const HTTP_OK = 200
const HTTP_NOT_FOUND = 404
const MAX_WS_CLOSE_CODE = 4000
const WS_OPEN = WebSocket.OPEN
const HEARTBEAT_TIMEOUT_MS = 45_000

/** Timeout for extension UI requests before auto-responding with defaults */
const EXTENSION_UI_REQUEST_TIMEOUT_MS = 300_000 // 5 minutes

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
  /** Pending timeout timers keyed by requestId */
  private extensionTimeouts = new Map<string, NodeJS.Timeout>()
  /** sessionId → Set of requestIds for session-scoped cleanup */
  private extensionSessionRequests = new Map<string, Set<string>>()
  /** Bridge request IDs (no frontend timeout) */
  private bridgeRequestIds = new Set<string>()

  setServices(session: ISessionService, config: IConfigService, model: IModelService, tree: import('./services/tree-service.js').TreeService, extension?: IExtensionService, plugin?: IPluginService): void {
    this.sessionService = session
    this.configService = config
    this.modelService = model
    this.treeService = tree
    if (extension) this.extensionService = extension
    if (plugin) this.pluginService = plugin
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
        case 'session.create': {
          const session = await this.sessionService.create(msg.payload.cwd, msg.payload.label)
          this.send(ws, { type: 'session.created', id: msg.id, payload: { session } })
          return this.broadcastSessionList()
        }
        case 'session.delete': {
          const delSid = msg.payload.sessionId
          this.clearExtensionTimeoutsForSession(delSid)
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
            // Auto-restore inactive session
            try {
              const restored = await this.sessionService.restoreSession(switchId)
              const messages = await this.sessionService.getHistory(switchId)
              this.send(ws, { type: 'session.history', id: msg.id, payload: { sessionId: switchId, session: restored, messages } })
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e)
              // ENOENT: session 文件不存在（pi 异常退出未 flush、文件被外部删除）
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
        case 'session.compact': return this.handleSessionCompact(msg, ws)
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
        case 'message.abort':
          return await this.sessionService.abort(msg.payload.sessionId)
        case 'session.tree-data': {
          const sid = msg.payload.sessionId
          try {
            const treeData = await this.treeService.getTree(sid)
            return this.send(ws, { type: 'session.tree-data', id: msg.id, payload: { ...treeData } })
          } catch (e) {
            if ((e instanceof Error && e.message.includes('not found')) || !this.sessionService.getSummary(sid)) {
              try {
                await this.sessionService.restoreSession(sid)
                const treeData = await this.treeService.getTree(sid)
                return this.send(ws, { type: 'session.tree-data', id: msg.id, payload: { ...treeData } })
              } catch (restoreErr) {
                console.error('[tree-data] auto-restore failed:', restoreErr)
                return this.send(ws, { type: 'session.tree-data', id: msg.id, payload: { sessionId: sid, tree: [], leafId: null, branchCount: 0, navigateCapable: false, error: 'Session not available' } })
              }
            }
            throw e
          }
        }
        case 'session.tree-navigate': {
          const sid = msg.payload.sessionId
          const targetEntryId = msg.payload.targetEntryId
          try {
            const result = await this.treeService.navigateTree(sid, targetEntryId)
            return this.send(ws, { type: 'session.tree-navigate-result', id: msg.id, payload: { sessionId: sid, ...result } })
          } catch (e) {
            if (e instanceof Error && e.message.includes('not found')) {
              return this.send(ws, { type: 'session.tree-navigate-result', id: msg.id, payload: { sessionId: sid, success: false, error: 'Session not active' } })
            }
            throw e
          }
        }
        case 'session.tree-fork': {
          const sid = msg.payload.sessionId
          const entryId = msg.payload.entryId
          try {
            const result = await this.treeService.forkFromEntry(sid, entryId)
            if (result.success && result.newSessionId) {
              // Fork 后 pi 进程已被 rebind 到新 session，需要更新 runtime 的 session 注册
              // 必须同步等待，确保 tree/adapter/command 全部就绪后再响应前端
              await this.sessionService.rebindAfterFork(sid, result.newSessionId, result.sessionFile)
              this.broadcastSessionList()
            }
            return this.send(ws, { type: 'session.tree-fork-result', id: msg.id, payload: { sessionId: sid, ...result } })
          } catch (e) {
            if (e instanceof Error && e.message.includes('not found')) {
              return this.send(ws, { type: 'session.tree-fork-result', id: msg.id, payload: { sessionId: sid, success: false, error: 'Session not active' } })
            }
            throw e
          }
        }
        case 'session.tree-capability': {
          const sid = msg.payload.sessionId
          try {
            return this.send(ws, { type: 'session.tree-capability', id: msg.id, payload: { sessionId: sid, navigateCapable: this.treeService.isNavigateCapable(sid) } })
          } catch (e) {
            if (e instanceof Error && e.message.includes('not found')) {
              return this.send(ws, { type: 'session.tree-capability', id: msg.id, payload: { sessionId: sid, navigateCapable: false } })
            }
            throw e
          }
        }
        case 'session.tree-clone': {
          const sid = msg.payload.sessionId
          try {
            const result = await this.treeService.cloneSession(sid)
            if (result.success) {
              this.broadcastSessionList()
            }
            return this.send(ws, { type: 'session.tree-clone-result', id: msg.id, payload: { sessionId: sid, ...result } })
          } catch (e) {
            if (e instanceof Error && e.message.includes('not found')) {
              return this.send(ws, { type: 'session.tree-clone-result', id: msg.id, payload: { sessionId: sid, success: false, error: 'Session not active' } })
            }
            throw e
          }
        }
        // ── Extension messages ──────────────────────────────────────────
        case 'extension.ui_response': {
          const { sessionId: extSid, requestId, result: extResult } = msg.payload

          // Bridge response: route to PluginService
          if (this.bridgeRequestIds.has(requestId)) {
            this.bridgeRequestIds.delete(requestId)
            // Bridge responses are handled internally, not forwarded to pi RPC
            // PluginService processes the response data from the caller
            return
          }

          const client = this.sessionService.getRpcClient(extSid)
          if (!client) {
            // 会话不存在时清计时器并发错
            this.clearExtensionTimeout(requestId)
            return this.sendError(ws, 'handler_error', `No active session for extension response: ${extSid}`, msg.id, extSid)
          }
          // 先发送响应，成功后再清计时器
          // 如果 sendCommand 抛异常，计时器保留让超时机制党底
          await client.sendCommand('extension_ui_response', { id: requestId, response: extResult ?? null })
          this.clearExtensionTimeout(requestId)
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
          await this.extensionService.toggleExtension(msg.payload.name, msg.payload.enabled)
          const extensions = await this.extensionService.scanExtensions()
          return this.send(ws, { type: 'config.extensions', id: msg.id, payload: { extensions } })
        }
        // ── Plugin messages ───────────────────────────────────────────
        case 'plugin.list': {
          if (!this.pluginService) {
            return this.send(ws, { type: 'config.plugins', id: msg.id, payload: { plugins: [] } })
          }
          const plugins = this.pluginService.getDiscoveredPlugins()
          return this.send(ws, { type: 'config.plugins', id: msg.id, payload: { plugins } })
        }
        case 'plugin.toggle': {
          if (!this.pluginService) {
            return this.sendError(ws, 'handler_error', 'Plugin service not available', msg.id)
          }
          const toggledPlugins = await this.pluginService.togglePlugin(msg.payload.pluginId, msg.payload.enabled)
          return this.send(ws, { type: 'config.plugins', id: msg.id, payload: { plugins: toggledPlugins } })
        }
        case 'plugin.uninstall': {
          if (!this.pluginService) {
            return this.sendError(ws, 'handler_error', 'Plugin service not available', msg.id)
          }
          const uninstalledPlugins = await this.pluginService.uninstallPlugin(msg.payload.pluginId)
          return this.send(ws, { type: 'config.plugins', id: msg.id, payload: { plugins: uninstalledPlugins } })
        }
        case 'plugin.approvePermissions': {
          if (!this.pluginService) {
            return this.sendError(ws, 'handler_error', 'Plugin service not available', msg.id)
          }
          await this.pluginService.approvePermissions(msg.payload.pluginId, msg.payload.permissions)
          return this.send(ws, { type: 'config.plugins', id: msg.id, payload: { plugins: this.pluginService.getDiscoveredPlugins() } })
        }
        case 'plugin.revokePermissions': {
          if (!this.pluginService) {
            return this.sendError(ws, 'handler_error', 'Plugin service not available', msg.id)
          }
          await this.pluginService.revokePermissions(msg.payload.pluginId)
          return this.send(ws, { type: 'config.plugins', id: msg.id, payload: { plugins: this.pluginService.getDiscoveredPlugins() } })
        }
        case 'plugin.executeCommand': {
          if (!this.pluginService) {
            return this.sendError(ws, 'handler_error', 'Plugin service not available', msg.id)
          }
          await this.pluginService.executeCommand(msg.payload.pluginId, msg.payload.commandId, msg.payload.args)
          return this.send(ws, { type: 'pong', id: msg.id, payload: {} })
        }
        case 'plugin.config.get': {
          if (!this.pluginService) {
            return this.sendError(ws, 'handler_error', 'Plugin service not available', msg.id)
          }
          const configValue = await this.pluginService.getPluginConfig(msg.payload.pluginId, msg.payload.key)
          const configKey = msg.payload.key ?? '__all__'
          return this.send(ws, { type: 'plugin:config', id: msg.id, payload: { pluginId: msg.payload.pluginId, config: configKey === '__all__' ? (configValue as Record<string, unknown>) : { [configKey]: configValue } } })
        }
        case 'plugin.config.set': {
          if (!this.pluginService) {
            return this.sendError(ws, 'handler_error', 'Plugin service not available', msg.id)
          }
          await this.pluginService.setPluginConfig(msg.payload.pluginId, msg.payload.key, msg.payload.value)
          const allConfig = await this.pluginService.getPluginConfig(msg.payload.pluginId)
          return this.send(ws, { type: 'plugin:config', id: msg.id, payload: { pluginId: msg.payload.pluginId, config: allConfig as Record<string, unknown> } })
        }
        case 'plugin.install': {
          // Phase 4: npm install integration
          return this.sendError(ws, 'not_implemented', 'Plugin install requires Phase 4 npm integration', msg.id)
        }
        default:
          if (!await this.handleSettingsMessage(msg, ws)) {
            // handleSettingsMessage 返回 false，说明 type 也不在 settings 分支中
            // 此时 msg 走的是 default 分支，无法收窄，需要手动读取
            const rawMsg = msg as { type: string; payload?: { sessionId?: string } }
            this.sendError(ws, 'unknown_type', `Unknown message type: ${rawMsg.type}`, msg.id, rawMsg.payload?.sessionId)
          }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // default 分支中 msg 无法收窄到具体 type，手动提取 sessionId
      const sessionId = ('sessionId' in msg.payload ? msg.payload.sessionId : undefined) as string | undefined
      this.sendError(ws, 'handler_error', message, msg.id, sessionId)
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

  private async handleSettingsMessage(msg: ClientMessage, ws: WsType): Promise<boolean> {
    switch (msg.type) {
      case 'config.getProviders':
        this.send(ws, { type: 'config.providers', id: msg.id, payload: { providers: this.configService.listProviders() } })
        return true
      case 'config.setProvider': {
        const { providerId, ...data } = msg.payload
        this.configService.setProvider(providerId, data as Parameters<IConfigService['setProvider']>[1])
        this.send(ws, { type: 'config.providerUpdated', id: msg.id, payload: { providerId } })
        this.broadcastProviderList()
        return true
      }
      case 'config.deleteProvider': {
        this.configService.deleteProvider(msg.payload.providerId)
        this.send(ws, { type: 'config.providerUpdated', id: msg.id, payload: { providerId: msg.payload.providerId, deleted: true } })
        this.broadcastProviderList()
        return true
      }
      case 'config.setToolPermissions':
        this.configService.updateToolPermissions(msg.payload.permissions)
        this.send(ws, { type: 'config.providerUpdated', id: msg.id, payload: { saved: true } })
        return true
      case 'config.scanSkills': {
        const existingIds = new Set(this.configService.loadSkills(this.projectRoot).map(s => s.id))
        this.send(ws, { type: 'config.scannedSkills', id: msg.id, payload: { skills: this.configService.scanSkills(msg.payload.sources, existingIds), success: true } })
        return true
      }
      case 'config.setSkill': {
        this.configService.upsertSkill(msg.payload.skill)
        this.send(ws, { type: 'config.skillUpdated', id: msg.id, payload: { skill: msg.payload.skill, success: true } })
        this.broadcastSkillList()
        return true
      }
      case 'config.deleteSkill': {
        this.configService.deleteSkill(msg.payload.skillId)
        this.send(ws, { type: 'config.skillDeleted', id: msg.id, payload: { skillId: msg.payload.skillId, success: true } })
        this.broadcastSkillList()
        return true
      }
      case 'config.scanAgents': {
        const existingIds = new Set(this.configService.loadAgents(this.projectRoot).map(a => a.id))
        this.send(ws, { type: 'config.scannedAgents', id: msg.id, payload: { agents: this.configService.scanAgents(msg.payload.sources, existingIds), success: true } })
        return true
      }
      case 'config.setAgent': {
        this.configService.upsertAgent(msg.payload.agent)
        this.send(ws, { type: 'config.agentUpdated', id: msg.id, payload: { agent: msg.payload.agent, success: true } })
        this.broadcastAgentList()
        return true
      }
      case 'config.deleteAgent': {
        this.configService.deleteAgent(msg.payload.agentId)
        this.send(ws, { type: 'config.agentDeleted', id: msg.id, payload: { agentId: msg.payload.agentId, success: true } })
        this.broadcastAgentList()
        return true
      }
      case 'config.discoverModels': return this.handleDiscoverModels(msg, ws)
      case 'model.list':
        this.send(ws, { type: 'model.list', id: msg.id, payload: { models: this.modelService.aggregateModels(this.configService.listProviders()) } })
        return true
      case 'model.switch': {
        const { sessionId, provider, modelId } = msg.payload
        console.log(`[runtime] model.switch: sessionId=${sessionId}, provider=${provider}, modelId=${modelId}`)
        await this.sessionService.switchModel(sessionId, provider, modelId)
        this.send(ws, { type: 'model.switched', id: msg.id, payload: { sessionId, provider, modelId } })
        return true
      }
      case 'tool.approve':
      case 'tool.deny':
      case 'tool.always_allow':
        return true
      default: return false
    }
  }

  private handleDiscoverModels(msg: Extract<ClientMessage, { type: 'config.discoverModels' }>, ws: WsType): boolean {
    const { baseUrl, apiKey, providerType, providerId } = msg.payload
    let resolvedApiKey = apiKey
    if (!resolvedApiKey && providerId) resolvedApiKey = this.configService.getProvider(providerId)?.apiKey
    this.modelService.discoverModelsFromApi(baseUrl, resolvedApiKey, providerType)
      .then((models) => { this.send(ws, { type: 'config.discoveredModels', id: msg.id, payload: { models, success: true } }) })
      .catch((e: unknown) => {
        const raw = e instanceof Error ? e.message : String(e)
        const message = raw.includes('ByteString') ? '请求失败：Base URL 或 API Key 包含 HTTP 不支持的字符'
          : raw.includes('fetch failed') ? `连接失败：无法访问 ${baseUrl}/v1/models` : raw
        this.send(ws, { type: 'config.discoveredModels', id: msg.id, payload: { models: [], success: false, error: message } })
      })
    return true
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

  /**
   * Register a timeout for an extension UI request.
   * Called by EventAdapter when translating `extension_ui_request` to `extension.ui_request`.
   * On timeout: sends default response to pi and notifies frontend.
   */
  registerExtensionTimeout(sessionId: string, requestId: string, method: string): void {
    // notify is fire-and-forget, no response expected
    if (method === 'notify') return

    // Bridge: track only, no frontend timeout
    if (method.startsWith('bridge:')) {
      this.bridgeRequestIds.add(requestId)
      // Also track in session for cleanup on session deletion
      let requestSet = this.extensionSessionRequests.get(sessionId)
      if (!requestSet) {
        requestSet = new Set()
        this.extensionSessionRequests.set(sessionId, requestSet)
      }
      requestSet.add(requestId)
      return
    }

    // Clear any existing timer for this requestId
    this.clearExtensionTimeout(requestId)

    const timer = setTimeout(() => {
      this.extensionTimeouts.delete(requestId)
      this.removeSessionRequest(sessionId, requestId)

      // Determine default response based on method
      const defaultResponse = method === 'confirm' ? false : null

      // Send default response to pi
      const client = this.sessionService.getRpcClient(sessionId)
      if (client) {
        client.sendCommand('extension_ui_response', { id: requestId, response: defaultResponse }).catch((e: unknown) => {
          console.error('[runtime] extension timeout response failed:', e)
        })
      }

      // Notify frontend of timeout
      this.broadcast({
        type: 'extension.ui_timeout',
        id: this.nextPushId(),
        payload: { sessionId, requestId },
      })
    }, EXTENSION_UI_REQUEST_TIMEOUT_MS)

    this.extensionTimeouts.set(requestId, timer)

    // Track sessionId → requestIds for session cleanup
    let requestSet = this.extensionSessionRequests.get(sessionId)
    if (!requestSet) {
      requestSet = new Set()
      this.extensionSessionRequests.set(sessionId, requestSet)
    }
    requestSet.add(requestId)
  }

  /** Clear the timeout timer for a specific requestId (called when ui_response arrives). */
  clearExtensionTimeout(requestId: string): void {
    const timer = this.extensionTimeouts.get(requestId)
    if (timer) {
      clearTimeout(timer)
      this.extensionTimeouts.delete(requestId)
    }
    // Also remove from session tracking (find sessionId by requestId)
    for (const [sid, reqs] of this.extensionSessionRequests) {
      if (reqs.delete(requestId)) {
        if (reqs.size === 0) this.extensionSessionRequests.delete(sid)
        break
      }
    }
  }

  /** Clear all pending timeouts for a session (called on session.delete). */
  clearExtensionTimeoutsForSession(sessionId: string): void {
    const requestIds = this.extensionSessionRequests.get(sessionId)
    if (!requestIds) return
    for (const reqId of requestIds) {
      const timer = this.extensionTimeouts.get(reqId)
      if (timer) {
        clearTimeout(timer)
        this.extensionTimeouts.delete(reqId)
      }
      // Also clean up bridge request IDs for this session
      this.bridgeRequestIds.delete(reqId)
    }
    this.extensionSessionRequests.delete(sessionId)
  }

  /**
   * Handle a bridge extension request directly (bypassing frontend).
   * Called by EventAdapter's onBridgeUIRequest callback for 'bridge:' methods.
   * Routes to PluginService and sends extension_ui_response back to pi RPC.
   */
  async handleBridgeRequest(sessionId: string, requestId: string, method: string, data: Record<string, unknown>): Promise<void> {
    const client = this.sessionService.getRpcClient(sessionId)
    if (!client) {
      console.warn(`[server] bridge request for inactive session: ${sessionId}, method: ${method}`)
      return
    }

    try {
      const methodName = method as string
      switch (methodName) {
        case 'bridge:sync': {
          const tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }> = []
          const commands: Array<{ name: string }> = []
          if (this.pluginService?.getToolSchemas) {
            const schemas = this.pluginService.getToolSchemas()
            for (const s of schemas) {
              tools.push({ name: s.name, description: s.description, parameters: s.parameters })
            }
          }
          await client.sendCommand('extension_ui_response', { id: requestId, response: { tools, commands, success: true } })
          return
        }

        case 'bridge:tool_execute': {
          const toolName = data.toolName as string
          const params = data.params as Record<string, unknown> ?? {}
          if (!this.pluginService?.handleBridgeToolExecute) {
            await client.sendCommand('extension_ui_response', { id: requestId, response: { content: 'Plugin system not available', isError: true } })
            return
          }
          const result = await this.pluginService.handleBridgeToolExecute({
            type: 'bridge.tool.execute',
            toolName, parameters: params, toolCallId: data.toolCallId as string ?? '', sessionId,
          })
          await client.sendCommand('extension_ui_response', { id: requestId, response: result })
          return
        }

        case 'bridge:event': {
          const eventName = data.eventName as string
          console.log(`[server] bridge event: ${eventName} from session ${sessionId}`)
          // Events are fire-and-forget — no meaningful response expected
          await client.sendCommand('extension_ui_response', { id: requestId, response: null })
          return
        }

        case 'bridge:intercept': {
          const eventName = data.eventName as string
          const eventData = data.data as Record<string, unknown> ?? {}
          if (this.pluginService?.handleBridgeIntercept && eventName === 'before_agent_start') {
            const result = await this.pluginService.handleBridgeIntercept(eventName, eventData, sessionId)
            await client.sendCommand('extension_ui_response', { id: requestId, response: result })
            return
          }
          await client.sendCommand('extension_ui_response', { id: requestId, response: {} })
          return
        }

        default: {
          console.warn(`[server] Unknown bridge method: ${methodName}`)
          await client.sendCommand('extension_ui_response', { id: requestId, response: { error: `Unknown bridge method: ${methodName}` } })
        }
      }
    } catch (e) {
      console.error(`[server] bridge request failed: ${method}`, e)
      try {
        await client.sendCommand('extension_ui_response', { id: requestId, response: { error: String(e) } })
      } catch { /* ignore send error */ }
    }
  }

  /** Remove a single requestId from session tracking without clearing the timer. */
  private removeSessionRequest(sessionId: string, requestId: string): void {
    const requestSet = this.extensionSessionRequests.get(sessionId)
    if (requestSet) {
      requestSet.delete(requestId)
      if (requestSet.size === 0) this.extensionSessionRequests.delete(sessionId)
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
