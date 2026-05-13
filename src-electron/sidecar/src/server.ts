import { createServer, type Server as HttpServer } from 'node:http'
import { WebSocketServer, WebSocket, type WebSocket as WsType } from 'ws'
import type { ClientMessage, ServerMessage, ModelInfo } from '@xyz-agent/shared'
import { SessionPool } from './session-pool.js'
import * as providerStore from './provider-store.js'
import { lookupModel } from './model-db.js'
import { updateToolPermissions, getProvider, loadSkills, saveSkills, loadAgents, saveAgents, toggleModelEnabled } from './config-store.js'
import { scanSkills } from './skill-scanner.js'
import { scanAgents } from './agent-scanner.js'
import type { SkillInfo, AgentInfo } from '@xyz-agent/shared'

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
  private clients = new Set<WsType>()
  private pushId = 0
  private heartbeatTimers = new Map<WsType, ReturnType<typeof setTimeout>>()
  private projectRoot: string

  private static HEARTBEAT_TIMEOUT = 45_000

  private nextPushId(): string {
    return `push_${++this.pushId}`
  }

  private resetHeartbeat(ws: WsType): void {
    const existing = this.heartbeatTimers.get(ws)
    if (existing) clearTimeout(existing)
    this.heartbeatTimers.set(ws, setTimeout(() => {
      console.warn('[sidecar] heartbeat timeout, closing connection')
      ws.close(MAX_WS_CLOSE_CODE, 'Heartbeat timeout')
    }, SidecarServer.HEARTBEAT_TIMEOUT))
  }

  private clearHeartbeat(ws: WsType): void {
    const timer = this.heartbeatTimers.get(ws)
    if (timer) {
      clearTimeout(timer)
      this.heartbeatTimers.delete(ws)
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
    this.clients.add(ws)
    this.pool.addClient(ws)
    console.log(`[sidecar] client connected (total: ${this.clients.size})`)

    this.sendInitialState(ws)
    this.resetHeartbeat(ws)

    ws.on('message', (data) => {
      try {
        const msg: ClientMessage = JSON.parse(data.toString())
        // 收到任何消息都重置该连接的心跳
        this.resetHeartbeat(ws)
        this.handleMessage(msg, ws)
      } catch {
        this.sendError(ws, 'parse_error', 'Invalid JSON')
      }
    })

    ws.on('close', () => {
      this.clients.delete(ws)
      this.pool.removeClient(ws)
      this.clearHeartbeat(ws)
      console.log(`[sidecar] client disconnected (total: ${this.clients.size})`)
    })

    ws.on('error', (err) => {
      console.error('[sidecar] ws error:', err)
      // ws error 后通常会触发 close，但如果没触发就主动清理
      this.clients.delete(ws)
      this.pool.removeClient(ws)
      this.clearHeartbeat(ws)
    })
  }

  private sendInitialState(ws: WsType): void {
    // Session list — 使用 grouped 格式，与 broadcastSessionList 一致
    const groups = this.pool.listPersistedSessions()
    this.send(ws, { type: 'session.list', id: this.nextPushId(), payload: { groups } })

    // Provider list
    const providers = providerStore.listProviders()
    this.send(ws, { type: 'config.providers', id: this.nextPushId(), payload: { providers } })

    // Aggregated model list
    const models = this.aggregateModels(providers)
    this.send(ws, { type: 'model.list', id: this.nextPushId(), payload: { models } })

    // Skills list
    const skills = loadSkills(this.projectRoot)
    this.send(ws, { type: 'config.skills', id: this.nextPushId(), payload: { skills } })

    // Agents list
    const agents = loadAgents(this.projectRoot)
    this.send(ws, { type: 'config.agents', id: this.nextPushId(), payload: { agents } })
  }

  // ── Message routing ────────────────────────────────────────────

  private handleDiscoverModels(msg: ClientMessage, ws: WsType): void {
    const { baseUrl, apiKey, providerType, providerId } = msg.payload as { baseUrl: string; apiKey?: string; providerType?: string; providerId?: string }
    let resolvedApiKey = apiKey
    if (!resolvedApiKey && providerId) resolvedApiKey = getProvider(providerId)?.apiKey
    this.discoverModelsFromApi(baseUrl, resolvedApiKey, providerType)
      .then((models) => { this.send(ws, { type: 'config.discoveredModels', id: msg.id, payload: { models, success: true } }) })
      .catch((e: unknown) => {
        const raw = e instanceof Error ? e.message : String(e)
        const message = raw.includes('ByteString') ? '请求失败：Base URL 或 API Key 包含 HTTP 不支持的字符'
          : raw.includes('fetch failed') ? `连接失败：无法访问 ${baseUrl}/v1/models` : raw
        this.send(ws, { type: 'config.discoveredModels', id: msg.id, payload: { models: [], success: false, error: message } })
      })
  }

  private handleSessionCompact(msg: ClientMessage): void {
    const startTime = Date.now()
    let compactId = msg.payload.sessionId as string
    console.log('[server] session.compact: sessionId=' + compactId)
    const runCompact = async () => {
      try { await this.pool.compact(compactId) } catch (e) { console.error('[server] session.compact: failed, sessionId=' + compactId + ', error=' + (e instanceof Error ? e.message : String(e))) }
      console.log('[server] session.compact: completed, sessionId=' + compactId + ', elapsed=' + (Date.now() - startTime) + 'ms')
    }
    if (!this.pool.hasActiveSession(compactId)) {
      this.pool.restoreSession(compactId).then((restored) => {
        compactId = restored.id
        console.log('[server] session.compact: auto-restored, newId=' + compactId)
        this.broadcast({ type: 'session.restored', id: msg.id, payload: { oldSessionId: msg.payload.sessionId as string, newSessionId: restored.id, summary: restored } })
        this.broadcastSessionList()
        runCompact()
      }).catch(() => { /* restoreSession error already handled by pool */ })
    } else {
      runCompact()
    }
  }

  private handleModelToggle(
    msg: ClientMessage,
    ws: WsType,
  ): void {
    const { providerId, modelId, enabled } = msg.payload as {
      providerId: string
      modelId: string
      enabled: boolean
    }
    const ok = toggleModelEnabled(providerId, modelId, enabled)
    providerStore.reload()
    if (ok) {
      this.send(ws, {
        type: 'model.toggled',
        id: msg.id,
        payload: { providerId, modelId, enabled, success: true },
      })
    } else {
      this.send(ws, {
        type: 'model.toggled',
        id: msg.id,
        payload: { providerId, modelId, enabled, success: false, error: 'Model not found' },
      })
    }
    this.broadcastProviderList()
  }

  private async handleSettingsMessage(msg: ClientMessage, ws: WsType): Promise<boolean> {
    switch (msg.type) {
      case 'config.getProviders': {
        const providers = providerStore.listProviders()
        this.send(ws, { type: 'config.providers', id: msg.id, payload: { providers } })
        return true
      }
      case 'config.setProvider': {
        const { providerId, ...data } = msg.payload as Record<string, unknown>
        providerStore.setProvider(providerId as string, data as Parameters<typeof providerStore.setProvider>[1])
        this.send(ws, { type: 'config.providerUpdated', id: msg.id, payload: { providerId } })
        this.broadcastProviderList()
        return true
      }
      case 'config.deleteProvider': {
        const delId = msg.payload.providerId as string
        providerStore.deleteProvider(delId)
        this.send(ws, { type: 'config.providerUpdated', id: msg.id, payload: { providerId: delId, deleted: true } })
        this.broadcastProviderList()
        return true
      }
      case 'config.setToolPermissions': {
        updateToolPermissions(msg.payload.permissions as Record<string, string>)
        this.send(ws, { type: 'config.providerUpdated', id: msg.id, payload: { saved: true } })
        return true
      }
      case 'config.scanSkills': {
        const sources = msg.payload.sources as string[]
        const existingIds = new Set(loadSkills(this.projectRoot).map(s => s.id))
        this.send(ws, { type: 'config.scannedSkills', id: msg.id, payload: { skills: scanSkills(sources, existingIds), success: true } })
        return true
      }
      case 'config.setSkill': {
        const skill = msg.payload.skill as SkillInfo
        const skills = loadSkills(this.projectRoot)
        const idx = skills.findIndex(s => s.id === skill.id)
        if (idx >= 0) skills[idx] = skill; else skills.push(skill)
        saveSkills(this.projectRoot, skills)
        this.send(ws, { type: 'config.skillUpdated', id: msg.id, payload: { skill, success: true } })
        this.broadcastSkillList()
        return true
      }
      case 'config.deleteSkill': {
        const skillId = msg.payload.skillId as string
        saveSkills(this.projectRoot, loadSkills(this.projectRoot).filter(s => s.id !== skillId))
        this.send(ws, { type: 'config.skillDeleted', id: msg.id, payload: { skillId, success: true } })
        this.broadcastSkillList()
        return true
      }
      case 'config.scanAgents': {
        const sources = msg.payload.sources as string[]
        const existingIds = new Set(loadAgents(this.projectRoot).map(a => a.id))
        this.send(ws, { type: 'config.scannedAgents', id: msg.id, payload: { agents: scanAgents(sources, existingIds), success: true } })
        return true
      }
      case 'config.setAgent': {
        const agent = msg.payload.agent as AgentInfo
        const agents = loadAgents(this.projectRoot)
        const aIdx = agents.findIndex(a => a.id === agent.id)
        if (aIdx >= 0) agents[aIdx] = agent; else agents.push(agent)
        saveAgents(this.projectRoot, agents)
        this.send(ws, { type: 'config.agentUpdated', id: msg.id, payload: { agent, success: true } })
        this.broadcastAgentList()
        return true
      }
      case 'config.deleteAgent': {
        const agentId = msg.payload.agentId as string
        saveAgents(this.projectRoot, loadAgents(this.projectRoot).filter(a => a.id !== agentId))
        this.send(ws, { type: 'config.agentDeleted', id: msg.id, payload: { agentId, success: true } })
        this.broadcastAgentList()
        return true
      }
      case 'config.discoverModels':
        this.handleDiscoverModels(msg, ws)
        return true
      case 'model.list': {
        this.send(ws, { type: 'model.list', id: msg.id, payload: { models: this.aggregateModels(providerStore.listProviders()) } })
        return true
      }
      case 'model.switch': {
        const { sessionId, provider, modelId } = msg.payload as { sessionId: string; provider: string; modelId: string }
        console.log(`[sidecar] model.switch: sessionId=${sessionId}, provider=${provider}, modelId=${modelId}`)
        await this.pool.switchModel(sessionId, provider, modelId)
        this.send(ws, { type: 'model.switched', id: msg.id, payload: { sessionId, provider, modelId } })
        return true
      }
      case 'model.toggle':
        this.handleModelToggle(msg, ws)
        return true
      case 'tool.approve':
        await this.pool.approveTool((msg.payload as { sessionId: string; toolCallId: string }).sessionId, (msg.payload as { sessionId: string; toolCallId: string }).toolCallId)
        return true
      case 'tool.deny':
        await this.pool.denyTool((msg.payload as { sessionId: string; toolCallId: string }).sessionId, (msg.payload as { sessionId: string; toolCallId: string }).toolCallId)
        return true
      case 'tool.always_allow':
        await this.pool.alwaysAllowTool((msg.payload as { sessionId: string; toolName: string }).sessionId, (msg.payload as { sessionId: string; toolName: string }).toolName)
        return true
      default:
        return false
    }
  }

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
          const label = msg.payload.label as string | undefined
          const session = await this.pool.create(cwd, label)
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
          const groups = this.pool.listPersistedSessions()
          this.send(ws, { type: 'session.list', id: msg.id, payload: { groups } })
          break
        }

        case 'session.switch': {
          const sid = msg.payload.sessionId as string
          const summary = this.pool.getSummary(sid)
          if (summary) {
            // 只发一次 session.history，带完整的 session 信息和消息
            try {
              const messages = await this.pool.getHistory(sid)
              this.send(ws, { type: 'session.history', id: msg.id, payload: { sessionId: sid, session: summary, messages } })
            } catch (e) {
              console.error('[sidecar] failed to load history for switch:', e)
              this.send(ws, { type: 'session.history', id: msg.id, payload: { sessionId: sid, session: summary, messages: [] } })
            }
          } else {
            this.sendError(ws, 'not_found', `Session ${sid} not found`, msg.id, sid)
          }
          break
        }

        case 'session.history': {
          const histId = msg.payload.sessionId as string
          const messages = await this.pool.getHistory(histId)
          this.send(ws, { type: 'session.history', id: msg.id, payload: { sessionId: histId, messages } })
          break
        }

        case 'session.compact':
          this.handleSessionCompact(msg)
          break

        case 'session.clear': {
          const clearId = msg.payload.sessionId as string
          await this.pool.clear(clearId)
          this.send(ws, { type: 'session.deleted', id: msg.id, payload: { sessionId: clearId } })
          break
        }

        case 'session.restore': {
          const restoreId = msg.payload.sessionId as string
          const session = await this.pool.restoreSession(restoreId)
          this.send(ws, { type: 'session.restored', id: msg.id, payload: { session } })
          this.broadcastSessionList()
          break
        }

        case 'session.rename': {
          const { sessionId: renameId, name } = msg.payload as { sessionId: string; name: string }
          await this.pool.renameSession(renameId, name)
          this.send(ws, { type: 'session.renamed', id: msg.id, payload: { sessionId: renameId, name } })
          this.broadcastSessionList()
          break
        }

        // ── Messages ────────────────────────────────────────────
        case 'message.send': {
          const { sessionId, content } = msg.payload as { sessionId: string; content: string }
          console.log(`[sidecar] message.send: sessionId=${sessionId}, contentLength=${content?.length ?? 0}`)
          await this.pool.sendMessage(sessionId, content)
          this.send(ws, { type: 'message.status', id: msg.id, payload: { sessionId, status: 'sent' } })
          break
        }

        case 'message.abort': {
          const abortId = msg.payload.sessionId as string
          await this.pool.abort(abortId)
          break
        }

        // ── Settings / Config / Model / Tool messages ──────────
        default:
          if (!this.handleSettingsMessage(msg, ws)) {
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

  // ── Helpers ────────────────────────────────────────────────────

  private send(ws: WsType, msg: ServerMessage): void {
    if (ws.readyState === WS_OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }

  /** Broadcast a message to all connected clients */
  private broadcast(msg: ServerMessage): void {
    for (const ws of this.clients) {
      this.send(ws, msg)
    }
  }

  private sendError(ws: WsType, code: string, message: string, id?: string, sessionId?: string): void {
    const payload: Record<string, unknown> = { code, message }
    if (sessionId) payload.sessionId = sessionId
    this.send(ws, { type: 'error', id, payload })
  }

  private broadcastSessionList(): void {
    const groups = this.pool.listPersistedSessions()
    this.broadcast({ type: 'session.list', id: this.nextPushId(), payload: { groups } })
  }

  private broadcastProviderList(): void {
    const providers = providerStore.listProviders()
    this.broadcast({ type: 'config.providers', id: this.nextPushId(), payload: { providers } })
    const models = this.aggregateModels(providers)
    this.broadcast({ type: 'model.list', id: this.nextPushId(), payload: { models } })
  }

  private broadcastSkillList(): void {
    const skills = loadSkills(this.projectRoot)
    this.broadcast({ type: 'config.skills', id: this.nextPushId(), payload: { skills } })
  }

  private broadcastAgentList(): void {
    const agents = loadAgents(this.projectRoot)
    this.broadcast({ type: 'config.agents', id: this.nextPushId(), payload: { agents } })
  }

  private aggregateModels(providers: ReturnType<typeof providerStore.listProviders>): ModelInfo[] {
    return providers.flatMap(p =>
      p.models.map(m => {
        // models 可能是字符串（model ID）或对象 { id, name, ctx, tags }
        // （来自 ProviderModal 保存的 ModalModel）
        const entry: unknown = m
        if (typeof entry === 'string') {
          const dbRecord = lookupModel(entry)
          return {
            id: entry,
            name: dbRecord?.name ?? entry,
            providerId: p.id,
            providerName: p.name,
            contextWindow: dbRecord?.context,
            enabled: true,
          } as ModelInfo
        }
        if (entry && typeof entry === 'object' && 'id' in entry) {
          const meta = entry as { id: unknown; name: unknown; ctx?: unknown; tags?: unknown; enabled?: unknown }
          return {
            id: typeof meta.id === 'string' ? meta.id : String(meta.id),
            name: typeof meta.name === 'string' ? meta.name : String(meta.name ?? meta.id),
            providerId: p.id,
            providerName: p.name,
            tags: Array.isArray(meta.tags) ? meta.tags.filter(t => typeof t === 'string') : [],
            contextWindow: typeof meta.ctx === 'number'
              ? meta.ctx
              : this.parseCtxToNumber(
                typeof meta.ctx === 'string' ? meta.ctx : undefined,
              ),
            enabled: meta.enabled !== false,
          } as ModelInfo
        }
        // fallback：转为字符串
        return {
          id: String(m),
          name: String(m),
          providerId: p.id,
          providerName: p.name,
          enabled: true,
        } as ModelInfo
      }),
    )
  }

  private parseCtxToNumber(ctx?: string): number | undefined {
    if (!ctx || ctx === '--') return undefined
    // 支持 "128K" → 128000, "200k" → 200000, "128000" → 128000, "--" → undefined
    const match = ctx.match(/^(\d+(?:\.\d+)?)\s*([kK])?$/)
    if (!match) return undefined
    const num = parseFloat(match[1])
    return match[2]?.toLowerCase() === 'k' ? Math.round(num * 1000) : Math.round(num)
  }

  /**
   * 调用供应商的 /v1/models API 发现可用模型。
   * 支持 OpenAI 兼容端点和 Anthropic 端点。
   */
  private async discoverModelsFromApi(
    baseUrl: string,
    apiKey?: string,
    providerType?: string,
  ): Promise<Array<{ id: string; name: string; ctx?: number }>> {
    const base = baseUrl.replace(/\/+$/, '')
    let url: string
    const headers: Record<string, string> = {}

    if (providerType === 'anthropic') {
      url = `${base}/v1/models`
      if (apiKey) {
        headers['x-api-key'] = apiKey
        headers['anthropic-version'] = '2023-06-01'
      }
    } else {
      url = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`
      }
    }

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`API 返回 ${res.status}: ${body || res.statusText}`)
    }

    const data = await res.json() as Record<string, unknown>

    // OpenAI 格式: { data: [{ id: "model-name", ... }] }
    // Anthropic 格式: { data: [{ id: "model-name", ... }] }
    const modelList = Array.isArray(data.data)
      ? data.data as Array<Record<string, unknown>>
      : Array.isArray(data.models)
        ? data.models as Array<Record<string, unknown>>
        : []

    return modelList
      .filter(m => typeof m.id === 'string')
      .map(m => {
        const id = m.id as string
        const dbRecord = lookupModel(id)
        return {
          id,
          name: (m.name ?? id) as string,
          ctx: dbRecord?.context ?? undefined,
        }
      })
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
