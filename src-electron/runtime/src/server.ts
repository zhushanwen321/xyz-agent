/**
 * SidecarServer — pure Transport layer.
 * Routes ClientMessages to Service instances and pushes
 * ServerMessages back to TUI clients via WebSocket.
 */
import { createServer, type Server as HttpServer } from 'node:http'
import { WebSocketServer, WebSocket, type WebSocket as WsType } from 'ws'
import type { ClientMessage, ServerMessage, SkillInfo, AgentInfo } from '@xyz-agent/shared'
import type { ISessionService, IConfigService, IModelService, IMessageBroker } from './interfaces.js'

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

  setServices(session: ISessionService, config: IConfigService, model: IModelService): void {
    this.sessionService = session
    this.configService = config
    this.modelService = model
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
  }

  // ── Message routing ───────────────────────────────────────────

  private async handleMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    try {
      switch (msg.type) {
        case 'ping':
          return this.send(ws, { type: 'pong', id: msg.id, payload: {} })
        case 'session.create': {
          const cwd = msg.payload.cwd as string | undefined
          const label = msg.payload.label as string | undefined
          const session = await this.sessionService.create(cwd, label)
          this.send(ws, { type: 'session.created', id: msg.id, payload: { session } })
          return this.broadcastSessionList()
        }
        case 'session.delete': {
          const sid = msg.payload.sessionId as string
          await this.sessionService.delete(sid)
          this.send(ws, { type: 'session.deleted', id: msg.id, payload: { sessionId: sid } })
          return this.broadcastSessionList()
        }
        case 'session.list':
          return this.send(ws, { type: 'session.list', id: msg.id, payload: { groups: this.sessionService.listPersistedSessions() } })
        case 'session.switch': {
          const switchId = msg.payload.sessionId as string
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
              console.error('[runtime] session.switch auto-restore failed:', e)
              this.sendError(ws, 'not_found', `Session ${switchId} not found or restore failed`, msg.id, switchId)
            }
          }
          return
        }
        case 'session.history': {
          const histId = msg.payload.sessionId as string
          const messages = await this.sessionService.getHistory(histId)
          return this.send(ws, { type: 'session.history', id: msg.id, payload: { sessionId: histId, messages } })
        }
        case 'session.compact': return this.handleSessionCompact(msg, ws)
        case 'session.clear': {
          const clearId = msg.payload.sessionId as string
          await this.sessionService.clear(clearId)
          return this.send(ws, { type: 'session.deleted', id: msg.id, payload: { sessionId: clearId } })
        }
        case 'session.restore': {
          const restoreId = msg.payload.sessionId as string
          const session = await this.sessionService.restoreSession(restoreId)
          this.send(ws, { type: 'session.restored', id: msg.id, payload: { session } })
          return this.broadcastSessionList()
        }
        case 'session.rename': {
          const { sessionId: renameId, name } = msg.payload as { sessionId: string; name: string }
          await this.sessionService.renameSession(renameId, name)
          this.send(ws, { type: 'session.renamed', id: msg.id, payload: { sessionId: renameId, name } })
          return this.broadcastSessionList()
        }
        case 'message.send': {
          const sessionId = msg.payload.sessionId as string
          const content = msg.payload.content as string
          const subagent = msg.payload.subagent as { agent: string; task: string } | undefined
          if (subagent) {
            const payload = JSON.stringify({ agent: subagent.agent, task: subagent.task })
            const encoded = Buffer.from(payload, 'utf-8').toString('base64')
            const marker = `<!-- xyz-agent-force-subagent:${encoded} -->`
            const promptText = content || `Execute task using agent '${subagent.agent}'`
            await this.sessionService.sendMessage(sessionId, `${marker}\n${promptText}`)
          } else {
            await this.sessionService.sendMessage(sessionId, content)
          }
          return this.send(ws, { type: 'message.status', id: msg.id, payload: { sessionId, status: 'sent' } })
        }
        case 'message.abort':
          return await this.sessionService.abort(msg.payload.sessionId as string)
        case 'session.tree-data': {
          const sid = msg.payload.sessionId as string
          const treeData = await this.sessionService.getTree(sid)
          return this.send(ws, { type: 'session.tree-data', id: msg.id, payload: { ...treeData } })
        }
        case 'session.tree-navigate': {
          const sid = msg.payload.sessionId as string
          const targetEntryId = msg.payload.targetEntryId as string
          const result = await this.sessionService.navigateTree(sid, targetEntryId)
          return this.send(ws, { type: 'session.tree-navigate-result', id: msg.id, payload: { sessionId: sid, ...result } })
        }
        case 'session.tree-fork': {
          const sid = msg.payload.sessionId as string
          const entryId = msg.payload.entryId as string
          const result = await this.sessionService.forkFromEntry(sid, entryId)
          if (result.success) {
            this.broadcastSessionList()
          }
          return this.send(ws, { type: 'session.tree-fork-result', id: msg.id, payload: { sessionId: sid, ...result } })
        }
        case 'session.tree-capability': {
          const sid = msg.payload.sessionId as string
          return this.send(ws, { type: 'session.tree-capability', id: msg.id, payload: { sessionId: sid, navigateCapable: this.sessionService.isNavigateCapable(sid) } })
        }
        default:
          if (!await this.handleSettingsMessage(msg, ws)) {
            const unknownSid = (msg as { payload?: { sessionId?: string } }).payload?.sessionId
            this.sendError(ws, 'unknown_type', `Unknown message type: ${(msg as { type: string }).type}`, msg.id, unknownSid)
          }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const sessionId = (msg as { payload?: { sessionId?: string } }).payload?.sessionId
      this.sendError(ws, 'handler_error', message, msg.id, sessionId)
    }
  }

  private handleSessionCompact(msg: ClientMessage, ws: WsType): void {
    const compactId = msg.payload.sessionId as string
    const startTime = Date.now()
    console.log('[server] session.compact: sessionId=' + compactId)
    const runCompact = async () => {
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
        const { providerId, ...data } = msg.payload as Record<string, unknown>
        this.configService.setProvider(providerId as string, data as Parameters<IConfigService['setProvider']>[1])
        this.send(ws, { type: 'config.providerUpdated', id: msg.id, payload: { providerId } })
        this.broadcastProviderList()
        return true
      }
      case 'config.deleteProvider': {
        const delId = msg.payload.providerId as string
        this.configService.deleteProvider(delId)
        this.send(ws, { type: 'config.providerUpdated', id: msg.id, payload: { providerId: delId, deleted: true } })
        this.broadcastProviderList()
        return true
      }
      case 'config.setToolPermissions':
        this.configService.updateToolPermissions(msg.payload.permissions as Record<string, string>)
        this.send(ws, { type: 'config.providerUpdated', id: msg.id, payload: { saved: true } })
        return true
      case 'config.scanSkills': {
        const sources = msg.payload.sources as string[]
        const existingIds = new Set(this.configService.loadSkills(this.projectRoot).map(s => s.id))
        this.send(ws, { type: 'config.scannedSkills', id: msg.id, payload: { skills: this.configService.scanSkills(sources, existingIds), success: true } })
        return true
      }
      case 'config.setSkill': {
        const skill = msg.payload.skill as SkillInfo
        this.configService.upsertSkill(skill)
        this.send(ws, { type: 'config.skillUpdated', id: msg.id, payload: { skill, success: true } })
        this.broadcastSkillList()
        return true
      }
      case 'config.deleteSkill': {
        const skillId = msg.payload.skillId as string
        this.configService.deleteSkill(skillId)
        this.send(ws, { type: 'config.skillDeleted', id: msg.id, payload: { skillId, success: true } })
        this.broadcastSkillList()
        return true
      }
      case 'config.scanAgents': {
        const sources = msg.payload.sources as string[]
        const existingIds = new Set(this.configService.loadAgents(this.projectRoot).map(a => a.id))
        this.send(ws, { type: 'config.scannedAgents', id: msg.id, payload: { agents: this.configService.scanAgents(sources, existingIds), success: true } })
        return true
      }
      case 'config.setAgent': {
        const agent = msg.payload.agent as AgentInfo
        this.configService.upsertAgent(agent)
        this.send(ws, { type: 'config.agentUpdated', id: msg.id, payload: { agent, success: true } })
        this.broadcastAgentList()
        return true
      }
      case 'config.deleteAgent': {
        const agentId = msg.payload.agentId as string
        this.configService.deleteAgent(agentId)
        this.send(ws, { type: 'config.agentDeleted', id: msg.id, payload: { agentId, success: true } })
        this.broadcastAgentList()
        return true
      }
      case 'config.discoverModels': return this.handleDiscoverModels(msg, ws)
      case 'model.list':
        this.send(ws, { type: 'model.list', id: msg.id, payload: { models: this.modelService.aggregateModels(this.configService.listProviders()) } })
        return true
      case 'model.switch': {
        const { sessionId, provider, modelId } = msg.payload as { sessionId: string; provider: string; modelId: string }
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

  private handleDiscoverModels(msg: ClientMessage, ws: WsType): boolean {
    const { baseUrl, apiKey, providerType, providerId } = msg.payload as { baseUrl: string; apiKey?: string; providerType?: string; providerId?: string }
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

  // ── Lifecycle ──────────────────────────────────────────────────

  async stop(): Promise<void> {
    await this.sessionService.destroyAll()
    for (const timer of this.heartbeatTimers.values()) {
      clearInterval(timer)
    }
    this.heartbeatTimers.clear()
    this.wss.close()
    return new Promise((resolve) => { this.httpServer.close(() => resolve()) })
  }
}
