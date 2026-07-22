/**
 * RuntimeServer — 编排层：路由表装配（D1）+ service 编排 + 连接/消息协调。
 *
 * C2 拆分后只保留传输编排职责：
 * - 组合 ConnectionManager（连接生命周期 + 心跳 + 连接池）与 ServerMessageBroker（发送/广播/initial state）。
 * - D1 中央分发表：handler 的 handles 清单 + Map spread → O(N→M) 路由映射（亮点，勿动）。
 * - setServices：装配 8 个 message handler + 注入各 handler 的 context（messaging + 领域依赖）。
 * - extension timeout / bridge 请求的对外委托入口（event-adapter 经 index.ts 调用）。
 *
 * 业务逻辑在 services，经 handler 调用；本类不含领域计算，只做路由与编排。
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ClientMessageType, ServerMessage } from '@xyz-agent/shared'
import type { ISessionService, IConfigService, IModelService, IMessageBroker, IExtensionService, IPluginService } from '../interfaces.js'
import type { GitService } from '../services/git-service.js'
import type { FileService } from '../services/file-service.js'
import type { SkillRegistry } from '../services/skill-registry.js'
import { ExtensionTimeoutManager } from '../services/extension-timeout-manager.js'
import { ConnectionManager } from './connection-manager.js'
import { ServerMessageBroker } from './message-broker.js'
import { BridgeHandler } from './bridge-handler.js'
import { SettingsMessageHandler } from './settings-message-handler.js'
import { SessionMessageHandler } from './session-message-handler.js'
import { ExtensionMessageHandler } from './extension-message-handler.js'
import { PluginMessageHandler } from './plugin-message-handler.js'
import { GitMessageHandler } from './git-message-handler.js'
import { FileMessageHandler } from './file-message-handler.js'
import { WorkspaceMessageHandler } from './workspace-message-handler.js'
import { WorktreeMessageHandler } from './worktree-message-handler.js'
import type { MessageHandlerContext, ErrorDetails } from './message-context.js'
import type { WorkspaceService } from '../services/workspace/workspace-service.js'
import type { IWorktreeService } from '../services/ports/worktree-service.js'
import { toErrorMessage } from '../utils/errors.js'

export class RuntimeServer implements IMessageBroker {
  private projectRoot: string
  private conn: ConnectionManager
  private broker!: ServerMessageBroker

  private sessionService!: ISessionService
  private configService!: IConfigService
  private modelService!: IModelService
  private extensionService?: IExtensionService
  private pluginService!: IPluginService
  private gitService?: GitService
  private fileService?: FileService
  /** W4：skillRegistry（可选，landing 全局/项目 skill 缓存源） */
  private skillRegistry?: SkillRegistry

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
  private gitMessageHandler?: GitMessageHandler
  private fileMessageHandler?: FileMessageHandler
  private workspaceMessageHandler!: WorkspaceMessageHandler
  private worktreeMessageHandler?: WorktreeMessageHandler

  /**
   * D1: 中央分发表。此前是 55 行 switch，每个 case 纯转发、零逻辑。
   * 改成 Map<ClientMessageType, (msg,ws)=>Promise<unknown>> 后：
   * - 加新消息类型只改一个 handler 的 handles 清单，不碰路由（开闭原则）。
   * - ping/file.read 走内联（无对应 handler），settings 走兜底（return false 表示未认领）。
   * 注意：handler 内部的 switch 保留——它们提供编译期类型收窄 + 含真实领域逻辑。
   */
  private routes!: Map<ClientMessageType, (msg: ClientMessage, ws: WsType) => Promise<unknown> | unknown>

  constructor(port: number, projectRoot?: string) {
    this.projectRoot = projectRoot ?? process.cwd()
    // ConnectionManager 注入回调：连接建立 → broker 推送 initial state；
    // 消息到达 → server.handleMessage 路由；解析/兜底错误 → broker.sendError。
    this.conn = new ConnectionManager(port, {
      onConnect: (ws) => this.broker.sendInitialState(ws),
      onMessage: (msg, ws) => this.handleMessage(msg, ws),
      sendError: (ws, code, message, id, details) => this.broker.sendError(ws, code, message, id, details),
    })
  }

  setServices(session: ISessionService, config: IConfigService, model: IModelService, extension?: IExtensionService, plugin?: IPluginService, git?: GitService, file?: FileService, workspace?: WorkspaceService, appInfo?: { appVersion: string; piVersion: string }, skillRegistry?: SkillRegistry, worktree?: IWorktreeService): void {
    this.gitService = git
    this.fileService = file
    this.sessionService = session
    this.configService = config
    this.modelService = model
    this.skillRegistry = skillRegistry
    if (extension) this.extensionService = extension
    if (plugin) this.pluginService = plugin

    // broker 在此构造：依赖 services（broadcast helper / sendInitialState 取数据）+ 连接池（conn.clients）。
    this.broker = new ServerMessageBroker(this.conn, {
      sessionService: this.sessionService,
      configService: this.configService,
      modelService: this.modelService,
      pluginService: this.pluginService,
      extensionService: this.extensionService,
      projectRoot: this.projectRoot,
      appInfo: appInfo ?? { appVersion: 'unknown', piVersion: 'unknown' },
    })

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
      send: (ws, msg) => this.broker.send(ws, msg),
      sendError: (ws, code, message, id, details) => this.broker.sendError(ws, code, message, id, details),
      reply: (ws, id, type, payload) => this.broker.reply(ws, id, type, payload),
    }
    this.settingsHandler = new SettingsMessageHandler({
      ...messaging,
      configService: this.configService,
      sessionService: this.sessionService,
      modelService: this.modelService,
      // W4：skillRegistry 必须注入（settings-handler 的 config.getGlobalSkills/getProjectSkills 依赖）。
      // 组合根 index.ts 保证传入；此处断言非空（setServices 编排保证）。若未来 skillRegistry 可选，handler 需守卫。
      skillRegistry: this.skillRegistry!,
      projectRoot: this.projectRoot,
      nextPushId: () => this.broker.nextPushId(),
      broadcast: (msg) => this.broker.broadcast(msg),
      broadcastProviderList: () => this.broker.broadcastProviderList(),
      broadcastSkillList: () => this.broker.broadcastSkillList(),
      broadcastAgentList: () => this.broker.broadcastAgentList(),
      broadcastSkillDirs: () => this.broker.broadcastSkillDirs(),
      broadcastAgentDirs: () => this.broker.broadcastAgentDirs(),
    })
    this.sessionHandler = new SessionMessageHandler({
      ...messaging,
      sessionService: this.sessionService,
      nextPushId: () => this.broker.nextPushId(),
      broadcastSessionList: () => this.broker.broadcastSessionList(),
      clearExtensionTimeoutsForSession: (sessionId) => this.clearExtensionTimeoutsForSession(sessionId),
      broadcast: (msg) => this.broker.broadcast(msg),
    })
    this.extensionHandler = new ExtensionMessageHandler({
      ...messaging,
      sessionService: this.sessionService,
      extensionService: this.extensionService,
      extensionTimeoutMgr: this.extensionTimeoutMgr,
      broadcast: (msg) => this.broker.broadcast(msg),
      nextPushId: () => this.broker.nextPushId(),
    })
    this.pluginMessageHandler = new PluginMessageHandler({
      ...messaging,
      pluginService: this.pluginService ?? null,
    })
    if (this.gitService) {
      this.gitMessageHandler = new GitMessageHandler({
        ...messaging,
        sessionService: this.sessionService,
        gitService: this.gitService,
        broadcastChangeSetInvalidated: (sessionId, reason) => {
          // 广播给所有连接（session 级消息，前端按 payload.sessionId 路由到正确 panel）。
          this.broker.broadcast({
            type: 'message.changeSetInvalidated',
            id: this.broker.nextPushId(),
            payload: { sessionId, reason },
          })
        },
      })
    }
    if (this.fileService) {
      this.fileMessageHandler = new FileMessageHandler({
        ...messaging,
        fileService: this.fileService,
      })
    }
    if (workspace) {
      this.workspaceMessageHandler = new WorkspaceMessageHandler({
        ...messaging,
        workspaceService: workspace,
      })
    }
    if (worktree) {
      this.worktreeMessageHandler = new WorktreeMessageHandler({
        ...messaging,
        worktreeService: worktree,
      })
    }

    // ── Build the central dispatch table (D1) ───────────────────────
    // ping 内联（无对应 handler）；file.read 已迁入 fileMessageHandler（W2）；settings 走兜底（见 handleMessage）。
    // git/file handler 可选（取决于 setServices 是否注入对应 service）：捕获到局部变量后判空，
    // 避免 `?.` 在 .map 闭包内类型收窄失效（async 回调里 TS 不保证 this.gitMessageHandler 未变）。
    const gitHandler = this.gitMessageHandler
    const fileHandler = this.fileMessageHandler
    const workspaceHandler = this.workspaceMessageHandler
    const worktreeHandler = this.worktreeMessageHandler
    this.routes = new Map([
      ['ping', (msg, ws) => this.broker.reply(ws, msg.id, 'pong', {})],
      ['session.compact', (msg, ws) => this.sessionHandler.handleSessionCompact(msg as Extract<ClientMessage, { type: 'session.compact' }>, ws)],
      ...this.sessionHandler.handles.map(t => [t, (msg: ClientMessage, ws: WsType) => this.sessionHandler.handleSessionMessage(msg, ws)] as const),
      ...this.extensionHandler.handles.map(t => [t, (msg: ClientMessage, ws: WsType) => this.extensionHandler.handleExtensionMessage(msg, ws)] as const),
      ...this.pluginMessageHandler.handles.map(t => [t, (msg: ClientMessage, ws: WsType) => this.pluginMessageHandler.handlePluginMessage(msg, ws)] as const),
      ...(gitHandler ? gitHandler.handles.map(t => [t, (msg: ClientMessage, ws: WsType) => gitHandler.handleGitMessage(msg, ws)] as const) : []),
      ...(fileHandler ? fileHandler.handles.map(t => [t, (msg: ClientMessage, ws: WsType) => fileHandler.handleFileMessage(msg, ws)] as const) : []),
      ...(workspaceHandler ? workspaceHandler.handles.map(t => [t, (msg: ClientMessage, ws: WsType) => workspaceHandler.handleWorkspaceMessage(msg, ws)] as const) : []),
      ...(worktreeHandler ? worktreeHandler.handles.map(t => [t, (msg: ClientMessage, ws: WsType) => worktreeHandler.handleWorktreeMessage(msg, ws)] as const) : []),
    ] as Array<[ClientMessageType, (msg: ClientMessage, ws: WsType) => Promise<unknown> | unknown]>)
  }

  // ── IMessageBroker 委托（index.ts 把 server 当 broker 注入 PluginService/SessionService）──

  send(ws: WsType, msg: ServerMessage): void { this.broker.send(ws, msg) }
  broadcast(msg: ServerMessage): void { this.broker.broadcast(msg) }
  sendError(ws: WsType, code: string, message: string, id?: string, details?: ErrorDetails): void {
    this.broker.sendError(ws, code, message, id, details)
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
        this.broker.sendError(ws, 'unknown_type', `Unknown message type: ${rawMsg.type}`, msg.id, { sessionId: rawMsg.payload?.sessionId })
      }
    } catch (e) {
      const message = toErrorMessage(e)
      const sessionId = ('sessionId' in msg.payload ? msg.payload.sessionId : undefined) as string | undefined
      // L4 增强：error 自带 code（如 MODEL_NOT_CONFIGURED）时透传，前端据此差异化引导；否则回退 handler_error。
      const code = (e as Error & { code?: string }).code ?? 'handler_error'
      this.broker.sendError(ws, code, message, msg.id, sessionId ? { sessionId } : undefined)
    }
  }

  // ── Extension timeout delegation ─────────────────────────────────

  registerExtensionTimeout(sessionId: string, requestId: string, method: string, payload: Record<string, unknown>): void {
    // 只注册 timer + 委托：超时后的扩展响应编排（默认值 / RPC / 广播）已下沉到
    // extensionHandler.handleExtensionTimeout，不再让 transport 层承载扩展响应业务逻辑。
    this.extensionTimeoutMgr.registerTimeout(sessionId, requestId, method, () => {
      this.extensionHandler.handleExtensionTimeout(sessionId, requestId, method)
    })
    // 缓存 pending 请求（ask-user 等阻塞式请求），session 重新激活时推送
    this.extensionTimeoutMgr.cachePendingRequest(sessionId, requestId, method, payload)
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

  handleStatusSetUpdate(payload: { sessionId: string; key: string; text: string; textRaw?: string }): void {
    this.bridgeHandler.handleStatusSetUpdate(payload)
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  start(): Promise<void> {
    return this.conn.start()
  }

  async stop(): Promise<void> {
    if (this.pluginService) await this.pluginService.shutdown()
    await this.sessionService.destroyAll()
    await this.conn.stop()
  }
}
