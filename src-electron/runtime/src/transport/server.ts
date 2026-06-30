/* eslint max-lines: ["warn", {"max": 600, "skipBlankLines": true, "skipComments": true}] */

/**
 * RuntimeServer — 纯路由 + 连接管理 + 广播；业务逻辑在 services，经 handler 调用。
 * Routes ClientMessages to Service instances and pushes
 * ServerMessages back to TUI clients via WebSocket.
 */
import { createServer, type Server as HttpServer } from 'node:http'
import { homedir } from 'node:os'
import { WebSocketServer, WebSocket, type WebSocket as WsType } from 'ws'
import type { ClientMessage, ClientMessageType, ServerMessage, ServerMessageType, SkillDirConfig } from '@xyz-agent/shared'
import type { ISessionService, IConfigService, IModelService, IMessageBroker, IExtensionService, IPluginService } from '../interfaces.js'
import type { GitService } from '../services/git-service.js'
import type { FileService } from '../services/file-service.js'
import { ExtensionTimeoutManager } from '../services/extension-timeout-manager.js'
import { BridgeHandler } from './bridge-handler.js'
import { SettingsMessageHandler } from './settings-message-handler.js'
import { SessionMessageHandler } from './session-message-handler.js'
import { ExtensionMessageHandler } from './extension-message-handler.js'
import { PluginMessageHandler } from './plugin-message-handler.js'
import { TreeMessageHandler } from './tree-message-handler.js'
import { GitMessageHandler } from './git-message-handler.js'
import { FileMessageHandler } from './file-message-handler.js'
import type { MessageHandlerContext, ErrorDetails } from './message-context.js'
import { toErrorMessage } from '../utils/errors.js'

const HTTP_OK = 200
const HTTP_NOT_FOUND = 404
const MAX_WS_CLOSE_CODE = 4000
const WS_OPEN = WebSocket.OPEN
const HEARTBEAT_TIMEOUT_MS = 45_000

/**
 * ADR-0020 §2/§3 预设可选目录候选（层 A「可选目录」的固定来源）。
 * 用户可勾选启用/可拖排序；勾选的进 discovery.json 数组。
 * 强制目录（~/.xyz-agent/...）不在此列（UI 另行只读展示）。
 */
const PRESET_SKILL_DIRS = [
  '~/.pi/agent/skills',
  '~/.claude/skills',
  '~/.agents/skills',
  '.agents/skills',
]
const PRESET_AGENT_DIRS = [
  '~/.pi/agent/agents',
  '~/.claude/agents',
  '~/.agents/agents',
  '.agents/agents',
]

/**
 * 把预设候选目录 + discovery 启用列表 组合成 UI 用的 SkillDirConfig[]。
 *
 * 顺序语义（ADR-0020 §1.1：靠前覆盖靠后）——**discovery 数组顺序即优先级**：
 *   1. discovery 里启用的目录，按 discovery 数组顺序排列（用户拖拽排序的结果）
 *   2. 预设候选中未启用的，按 preset 固定顺序追加在后（供用户勾选）
 *   3. discovery 里有但不在预设里的自定义路径（已启用），紧随其后
 *
 * 这保证用户拖拽改变 discovery 顺序后，广播回来的 UI 列表顺序与之一致，
 * 不会被 preset 固定顺序覆盖（否则拖拽排序失效）。
 *
 * 过滤：不存在 / 非 skill 容器的启用路径不展示（脏数据，如 /path/a）。ADR §5。
 * 归一化：比较时展开 ~，避免 ~/.pi 与 /Users/.../pi 因字符串不同而重复。
 */
function buildDirConfigs(preset: string[], enabledDirs: string[]): SkillDirConfig[] {
  const configs: SkillDirConfig[] = []

  // 1. discovery 启用目录，按 discovery 顺序（= 用户拖拽优先级，靠前覆盖靠后）
  for (const dir of enabledDirs) {
    configs.push({ path: dir, enabled: true })
  }

  // 2. 预设候选中尚未启用的，按 preset 固定顺序追加（供勾选）
  const enabledNormalized = new Set(enabledDirs.map(normalizeDirPath))
  for (const path of preset) {
    if (!enabledNormalized.has(normalizeDirPath(path))) {
      configs.push({ path, enabled: false })
    }
  }
  return configs
}

/** 展开 ~ 前缀（与 scanner-base.expandHome 对齐）。 */
function expandHomePath(p: string): string {
  return p.startsWith('~') ? `${homedir()}${p.slice(1)}` : p
}

/** 归一化目录路径用于比较：展开 ~ 后取绝对路径（~/.pi 与 /Users/.../pi 归一为同值）。 */
function normalizeDirPath(p: string): string {
  return expandHomePath(p)
}

export class RuntimeServer implements IMessageBroker {
  private httpServer: HttpServer
  private wss: WebSocketServer
  private clients = new Set<WsType>()
  private pushId = 0
  private heartbeatTimers = new Map<WsType, ReturnType<typeof setTimeout>>()
  private projectRoot: string
  private sessionService!: ISessionService
  private configService!: IConfigService
  private modelService!: IModelService
  private treeService!: import('../services/tree-service.js').TreeService
  private extensionService?: IExtensionService
  private pluginService!: IPluginService
  private gitService?: GitService
  private fileService?: FileService

  // ── Message handlers (extracted) ────────────────────────────────
  // Constructed in setServices() — not at field-init time — so `this` is fully
  // initialized and each handler receives an explicit context object rather than
  // the `as unknown as XxxHandlerContext` cast the field-initializer needed.
  private extensionTimeoutMgr = new ExtensionTimeoutManager()
  private bridgeHandler!: BridgeHandler
  private settingsHandler!: SettingsMessageHandler
  private sessionHandler!: SessionMessageHandler
  private extensionHandler!: ExtensionMessageHandler
  private pluginMessageHandler!: PluginMessageHandler
  private treeMessageHandler!: TreeMessageHandler
  private gitMessageHandler!: GitMessageHandler
  private fileMessageHandler!: FileMessageHandler

  /**
   * D1: 中央分发表。此前是 55 行 switch，每个 case 纯转发、零逻辑。
   * 改成 Map<ClientMessageType, (msg,ws)=>Promise<unknown>> 后：
   * - 加新消息类型只改一个 handler 的 handles 清单，不碰路由（开闭原则）。
   * - ping/file.read 走内联（无对应 handler），settings 走兜底（return false 表示未认领）。
   * 注意：handler 内部的 switch 保留——它们提供编译期类型收窄 + 含真实领域逻辑。
   */
  private routes!: Map<ClientMessageType, (msg: ClientMessage, ws: WsType) => Promise<unknown> | unknown>

  setServices(session: ISessionService, config: IConfigService, model: IModelService, tree: import('../services/tree-service.js').TreeService, extension?: IExtensionService, plugin?: IPluginService, git?: GitService, file?: FileService): void {
    this.gitService = git
    this.fileService = file
    this.sessionService = session
    this.configService = config
    this.modelService = model
    this.treeService = tree
    if (extension) this.extensionService = extension
    if (plugin) this.pluginService = plugin

    // ── Assemble handlers with explicit context objects ──────────────
    // Each object literal is structurally checked against its HandlerContext
    // interface at the call site — no `as unknown as`, no relying on private
    // members being visible across class boundaries.
    //
    // `messaging` 是 MessageHandlerContext 的共享实现（D7：send/sendError/reply 三方法
    // 逐字相同，此前在 4 个 context 对象里复制了 4 份）。每个 handler 的 context 由
    // `...messaging` 铺底 + 各自的领域依赖组成。
    this.bridgeHandler = new BridgeHandler(this.pluginService ?? null)
    const messaging: MessageHandlerContext = {
      send: (ws, msg) => this.send(ws, msg),
      sendError: (ws, code, message, id, details) => this.sendError(ws, code, message, id, details),
      reply: (ws, id, type, payload) => this.reply(ws, id, type, payload),
    }
    this.settingsHandler = new SettingsMessageHandler({
      ...messaging,
      configService: this.configService,
      sessionService: this.sessionService,
      modelService: this.modelService,
      projectRoot: this.projectRoot,
      nextPushId: () => this.nextPushId(),
      broadcast: (msg) => this.broadcast(msg),
      broadcastProviderList: () => this.broadcastProviderList(),
      broadcastSkillList: () => this.broadcastSkillList(),
      broadcastAgentList: () => this.broadcastAgentList(),
      broadcastSkillDirs: () => this.broadcastSkillDirs(),
      broadcastAgentDirs: () => this.broadcastAgentDirs(),
    })
    this.sessionHandler = new SessionMessageHandler({
      ...messaging,
      sessionService: this.sessionService,
      nextPushId: () => this.nextPushId(),
      broadcastSessionList: () => this.broadcastSessionList(),
      clearExtensionTimeoutsForSession: (sessionId) => this.clearExtensionTimeoutsForSession(sessionId),
    })
    this.extensionHandler = new ExtensionMessageHandler({
      ...messaging,
      sessionService: this.sessionService,
      extensionService: this.extensionService,
      extensionTimeoutMgr: this.extensionTimeoutMgr,
    })
    this.pluginMessageHandler = new PluginMessageHandler({
      ...messaging,
      pluginService: this.pluginService ?? null,
    })
    this.treeMessageHandler = new TreeMessageHandler({
      ...messaging,
      sessionService: this.sessionService,
      treeService: this.treeService,
      broadcastSessionList: () => this.broadcastSessionList(),
    })
    if (this.gitService) {
      this.gitMessageHandler = new GitMessageHandler({
        ...messaging,
        sessionService: this.sessionService,
        gitService: this.gitService,
      })
    }
    if (this.fileService) {
      this.fileMessageHandler = new FileMessageHandler({
        ...messaging,
        fileService: this.fileService,
      })
    }

    // ── Build the central dispatch table (D1) ───────────────────────
    // ping 内联（无对应 handler）；file.read 已迁入 fileMessageHandler（W2）；settings 走兜底（见 handleMessage）。
    this.routes = new Map([
      ['ping', (msg, ws) => this.reply(ws, msg.id, 'pong', {})],
      ['session.compact', (msg, ws) => this.sessionHandler.handleSessionCompact(msg as Extract<ClientMessage, { type: 'session.compact' }>, ws)],
      ...this.sessionHandler.handles.map(t => [t, (msg: ClientMessage, ws: WsType) => this.sessionHandler.handleSessionMessage(msg, ws)] as const),
      ...this.treeMessageHandler.handles.map(t => [t, (msg: ClientMessage, ws: WsType) => this.treeMessageHandler.handleTreeMessage(msg, ws)] as const),
      ...this.extensionHandler.handles.map(t => [t, (msg: ClientMessage, ws: WsType) => this.extensionHandler.handleExtensionMessage(msg, ws)] as const),
      ...this.pluginMessageHandler.handles.map(t => [t, (msg: ClientMessage, ws: WsType) => this.pluginMessageHandler.handlePluginMessage(msg, ws)] as const),
      ...(this.gitMessageHandler ? this.gitMessageHandler.handles.map(t => [t, (msg: ClientMessage, ws: WsType) => this.gitMessageHandler.handleGitMessage(msg, ws)] as const) : []),
      ...(this.fileMessageHandler ? this.fileMessageHandler.handles.map(t => [t, (msg: ClientMessage, ws: WsType) => this.fileMessageHandler.handleFileMessage(msg, ws)] as const) : []),
    ] as Array<[ClientMessageType, (msg: ClientMessage, ws: WsType) => Promise<unknown> | unknown]>)
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
            this.sendError(ws, 'handler_error', toErrorMessage(err), msg.id)
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

  /**
   * D7: sendInitialState 改 descriptor 驱动。
   * 此前 6 段同构 best-effort try/catch（eslint-disable 注释也复制了 6 次）。
   * 现在每段是一个 { label, run } descriptor，共享 try/catch 包装器只写一次。
   * run 内含 load + 条件 + send，领域差异保留在各自 descriptor。
   */
  private sendInitialState(ws: WsType): void {
    const steps: Array<{ label: string; run: () => void }> = [
      {
        label: 'session.list',
        run: () => this.send(ws, { type: 'session.list', id: this.nextPushId(), payload: { groups: this.sessionService.listPersistedSessions() } }),
      },
      {
        label: 'config.providers/model.list',
        run: () => {
          const providers = this.configService.listProviders()
          this.send(ws, { type: 'config.providers', id: this.nextPushId(), payload: { providers } })
          this.send(ws, { type: 'model.list', id: this.nextPushId(), payload: { models: this.modelService.aggregateModels(providers) } })
        },
      },
      {
        label: 'config.defaults',
        run: () => {
          const defaultModel = this.configService.getDefaultModel()
          if (defaultModel) {
            this.send(ws, { type: 'config.defaults', id: this.nextPushId(), payload: { defaultModel: `${defaultModel.provider}/${defaultModel.modelId}` } })
          }
        },
      },
      {
        label: 'config.skills',
        run: () => this.send(ws, { type: 'config.skills', id: this.nextPushId(), payload: { skills: this.configService.loadSkills(this.projectRoot) } }),
      },
      {
        label: 'config.skillDirs',
        run: () => this.send(ws, { type: 'config.skillDirs', id: this.nextPushId(), payload: { dirs: buildDirConfigs(PRESET_SKILL_DIRS, this.configService.getSkillDirs()) } }),
      },
      {
        label: 'config.agents',
        run: () => this.send(ws, { type: 'config.agents', id: this.nextPushId(), payload: { agents: this.configService.loadAgents(this.projectRoot) } }),
      },
      {
        label: 'config.agentDirs',
        run: () => this.send(ws, { type: 'config.agentDirs', id: this.nextPushId(), payload: { dirs: buildDirConfigs(PRESET_AGENT_DIRS, this.configService.getAgentDirs()) } }),
      },
      {
        label: 'config.plugins',
        run: () => {
          if (this.pluginService) {
            this.send(ws, { type: 'config.plugins', id: this.nextPushId(), payload: { plugins: this.pluginService.getDiscoveredPlugins() } })
          }
        },
      },
    ]
    for (const step of steps) {
      try {
        step.run()
      // eslint-disable-next-line taste/no-silent-catch -- init: best-effort, single failure must not block others
      } catch (e) { console.error(`[runtime] sendInitialState: ${step.label} failed:`, e) }
    }
  }

  // ── Message routing ───────────────────────────────────────────

  private async handleMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    try {
      const route = this.routes.get(msg.type)
      if (route) {
        await route(msg, ws)
        return
      }
      // Settings 是兜底 handler：它内部 switch 命中返回 true，未命中返回 false（→ unknown_type）。
      if (!await this.settingsHandler.handleSettingsMessage(msg, ws)) {
        const rawMsg = msg as { type: string; payload?: { sessionId?: string } }
        this.sendError(ws, 'unknown_type', `Unknown message type: ${rawMsg.type}`, msg.id, { sessionId: rawMsg.payload?.sessionId })
      }
    } catch (e) {
      const message = toErrorMessage(e)
      const sessionId = ('sessionId' in msg.payload ? msg.payload.sessionId : undefined) as string | undefined
      this.sendError(ws, 'handler_error', message, msg.id, sessionId ? { sessionId } : undefined)
    }
  }

  // ── IMessageBroker ──────────────────────────────────────────────

  send(ws: WsType, msg: ServerMessage): void {
    if (ws.readyState === WS_OPEN) ws.send(JSON.stringify(msg))
  }

  broadcast(msg: ServerMessage): void {
    for (const ws of this.clients) this.send(ws, msg)
  }

  /**
   * 发送请求级操作失败的统一 error envelope（D10/P0-B）。
   * @param details 可选扩展槽：sessionId / hint / path 等附加信息。
   */
  sendError(ws: WsType, code: string, message: string, id?: string, details?: ErrorDetails): void {
    const payload: Record<string, unknown> = { code, message }
    if (details) {
      if (details.sessionId) payload.sessionId = details.sessionId
      // 其余扩展字段（hint/path/...）进 details 子对象，保持 envelope 顶层只有 code/message/sessionId。
      const extras = { ...details }
      delete extras.sessionId
      if (Object.keys(extras).length > 0) payload.details = extras
    }
    this.send(ws, { type: 'error', id, payload })
  }

  /** D2 reply 惯用法：发送带请求 id 的回复，消灭 46 处 `send(ws,{type,id:msg.id,payload})` 样板。 */
  reply(ws: WsType, id: string | undefined, type: ServerMessageType, payload: Record<string, unknown>): void {
    this.send(ws, { type, id, payload })
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
  /** 广播 skill 加载路径配置（ADR-0020 §1 discovery.json SSOT 的 UI 视图）。 */
  private broadcastSkillDirs(): void {
    this.broadcast({ type: 'config.skillDirs', id: this.nextPushId(), payload: { dirs: buildDirConfigs(PRESET_SKILL_DIRS, this.configService.getSkillDirs()) } })
  }
  /** 广播 agent 加载路径配置（ADR-0020 §1 discovery.json SSOT 的 UI 视图）。 */
  private broadcastAgentDirs(): void {
    this.broadcast({ type: 'config.agentDirs', id: this.nextPushId(), payload: { dirs: buildDirConfigs(PRESET_AGENT_DIRS, this.configService.getAgentDirs()) } })
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
