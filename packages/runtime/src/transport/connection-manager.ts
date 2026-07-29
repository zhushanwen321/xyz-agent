/**
 * ConnectionManager — WS 连接生命周期 + 心跳 + 连接池管理（C2 从 server.ts 抽出）。
 *
 * 职责：
 * - 持有 clients 连接池（Map<clientId, ConnectionCtx>），供 broker.broadcast 遍历。
 * - WS 服务器生命周期：start（listen + 注册 connection 回调）/ stop（关闭 wss + http）。
 * - 心跳：每条消息重置计时器，超时关闭连接（防僵尸连接）。
 * - 认证门（wave1 远程化）：若 tokenManager.load().enabled → 新连接进 pending，首消息须为
 *   合法 auth；5s 内未认证关闭（4001）。认证通过踢同 clientId 旧连接（4002）后入正式池。
 *   开放模式（无 token 文件）保持旧路径零回归（clientId='local'）。
 * - Origin 白名单（W1-T4）：env XYZ_AGENT_ALLOWED_ORIGINS 配置时 verifyClient 拦截非法 origin。
 * - HTTP /health 端点（与 WS 同端口，简单存活探针）。
 *
 * 不含：消息路由（server.ts handleMessage）、消息发送（broker）、业务逻辑（handlers）。
 * 连接建立后把 ws + 解析出的 msg 通过注入的回调交给上层（RuntimeServer）处理。
 */
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { WebSocketServer, WebSocket, type WebSocket as WsType } from 'ws'
import type { ClientMessage, PresenceConnection } from '@xyz-agent/shared'
import { toErrorMessage } from '../utils/errors.js'
import type { ErrorDetails } from './message-context.js'
import { createTokenManager, type TokenManager } from './token.js'
import type { FileEndpoint } from './file-endpoint.js'
import type { ISessionServiceInternal } from '../services/session/session-internal.js'

const HTTP_OK = 200
const HTTP_NOT_FOUND = 404
const HTTP_INTERNAL_ERROR = 500
const MAX_WS_CLOSE_CODE = 4000
const HEARTBEAT_TIMEOUT_MS = 45_000
/** 认证超时：新连接进入 pending 后 5s 内须完成首条 auth 消息，否则关闭。 */
const AUTH_TIMEOUT_MS = 5_000
/** pending 池上限：防未认证连接耗尽资源（DoS 缓解）。超过则新连接立即 server_busy 关闭。 */
const MAX_PENDING = 20
/** WS close code：未授权（超时/无 auth 消息/token 错/server_busy）。4000+ 是应用自定义区间。 */
const WS_CLOSE_UNAUTHORIZED = 4001
/** WS close code：同 clientId 新连接到来，旧连接被踢占。 */
const WS_CLOSE_REPLACED = 4002
/** WS close code：服务端关闭（标准 1000 正常关闭）。stop() 时关闭 pending/已认证连接用。 */
const WS_CLOSE_NORMAL = 1000

/**
 * 单连接的运行时上下文（wave1 远程化）。
 * - clientId：开放模式固定 'local'；认证模式来自客户端 auth 消息（client 身份 SSOT）。
 * - connectedAt：连接建立时间戳，便于诊断/日志。
 */
export interface ConnectionCtx {
  ws: WsType
  clientId: string
  deviceName: string
  connectedAt: number
}

// ── P2-s2 auth replay 编排类型（spec §四时序图） ────────────────────────────
// 三个值对象跨 connection-manager ↔ server.ts 边界：
// - AuthReplayInput：handleAuthMessage 解析 auth payload 后传给 onAuthSuccess 的入参。
// - ReplayDecision：server 注入的 onAuthSuccess 返回，connection-manager 据此编排。
// - ReplayMeta：replyAuth 的 auth.ok payload 子集（bootId/serverSeq/resumed/replayedCount/seqReset 全可选）。

/**
 * onAuthSuccess 入参（从 auth payload 解析后组装）。
 * - lastSeq/bootId undefined = 冷启动或旧客户端（不携带重连凭据）。
 * - subscribedSessions 缺省 []：服务端只回放这些 session 桶的增量（spec D2.1）。
 */
export interface AuthReplayInput {
  lastSeq?: number
  bootId?: string
  subscribedSessions: string[]
}

/**
 * onAuthSuccess 返回值（connection-manager 编排依据）。
 * - resume=true → 直发 messages（已序列化字符串，零再序列化）跳过 onConnect。
 * - resume=false → 调 onConnect 推全量（含 seqReset 场景）。
 * - bootId/serverSeq 用于 replyAuth 携带（客户端下次重连带回）。
 */
export interface ReplayDecision {
  resume: boolean
  messages: string[]
  seqReset: boolean
  replayedCount: number
  bootId: string
  serverSeq: number
}

/**
 * replyAuth 的 auth.ok payload 子集（spec §2.2）。
 * 所有字段可选——开放模式现状不回 auth.ok，认证模式按 decision 透传。
 * 客户端旧逻辑只读 serverVersion/clientId，新字段缺省不破坏（JSON 宽松忽略 undefined）。
 */
export interface ReplayMeta {
  bootId?: string
  serverSeq?: number
  resumed: boolean
  replayedCount?: number
  seqReset?: boolean
}

/**
 * 连接事件回调（由 RuntimeServer 注入）。
 * - onMessage：收到合法 ClientMessage，交 server 路由（返回 Promise，错误由调用方 catch）。
 * - onConnect：新连接建立（认证通过/开放模式），交 broker 推送 initial state。
 * - sendError：连接级解析/兜底错误回复（注入 broker.sendError，避免 ConnectionManager 依赖 broker）。
 *
 * P5 lease/presence：onConnect/onMessage 签名扩展为 (ws, clientId)，透传 clientId 到上层
 * （busyOwner 定向投递的前提）。onDisconnect 新增（审查 C3：现状无此回调，close 在
 * attachLifecycleHandlers 内联处理），供 presence 推送（连接下线重推）与 P6 terminal resize
 * owner 清理订阅。本地模式 clientId='local' 同样触发。
 */
export interface ConnectionCallbacks {
  onConnect(ws: WsType, clientId: string): void
  onMessage(msg: ClientMessage, ws: WsType, clientId: string): Promise<void>
  /** P5 新增：连接关闭/错误时调（ws 一致性检查通过后），clientId 是该连接的身份。 */
  onDisconnect(ws: WsType, clientId: string): void
  sendError(ws: WsType, code: string, message: string, id?: string, details?: ErrorDetails): void
  /**
   * P2-s2：认证成功后调（仅认证模式，server.ts 注入实现调 broker.getReplayPlan）。
   * - 入参 AuthReplayInput：从 auth payload 解析的 lastSeq/bootId/subscribedSessions。
   * - 返回 ReplayDecision：connection-manager 据此决定 resume（直发回放段）/reset（推全量）。
   * 可选——未注入时（开放模式）handleConnection 不走此路径。
   */
  onAuthSuccess?(ws: WsType, clientId: string, input: AuthReplayInput): Promise<ReplayDecision>
  /**
   * P5 presence：broadcastPresence 触发时调（server 注入实现 broadcast presence.update）。
   * 可选——未注入时 broadcastPresence no-op（向后兼容 lease-core slice 的空 onDisconnect）。
   * 入参 connections 是全量 PresenceConnection[]（connection-manager.buildPresenceList 构造）。
   */
  onPresenceUpdate?(connections: PresenceConnection[]): void
}

export interface ConnectionManagerOptions {
  /** 监听 host：默认 127.0.0.1（仅本机，Electron 零回归）；远程部署显式传 0.0.0.0。 */
  host?: string
  /** token 管理器：未配置/未启用时走开放模式。未传时构造一个无 tokenFile 的开放模式管理器。 */
  tokenManager?: TokenManager
  /** 服务端版本号：auth.ok 回复携带（前端据此做兼容判定）。默认 '0.0.0'。 */
  serverVersion?: string
  /**
   * wave2 远程化：HTTP /file 端点（图片预览签名 URL 校验 + 流式）。
   * 未配置时 /file 走 404（向后兼容——本地 Electron 模式不需要此端点）。
   */
  fileEndpoint?: FileEndpoint
}

export class ConnectionManager {
  private httpServer: HttpServer
  private wss: WebSocketServer
  /**
   * 连接池——broker.broadcast 遍历此 Map.values() 向所有认证后客户端推送。
   * key=clientId（同 clientId 唯一，新连接踢旧）；value=ConnectionCtx。
   */
  readonly clients = new Map<string, ConnectionCtx>()
  /**
   * P5 presence：per-client 活跃 session 记录（R1-M4 命名统一）。
   * key=clientId，value=sessionId|null（null=客户端在看非 session 视图，如 settings）。
   * 由 session.setActive RPC 更新，broadcastPresence 构造 presence 列表时读。
   */
  private readonly activeSessions = new Map<string, string | null>()
  /** 未认证 pending 连接（认证通过后移出，超时/失败关闭后移出）。不参与广播。 */
  private readonly pending = new Set<WsType>()
  private heartbeatTimers = new Map<WsType, ReturnType<typeof setTimeout>>()
  private authTimers = new Map<WsType, ReturnType<typeof setTimeout>>()
  /** 已解析的 token 管理器（opts.tokenManager 缺省时构造开放模式实例）。 */
  private readonly tokenManager: TokenManager
  /** 已解析的服务端版本号（opts.serverVersion 缺省时 '0.0.0'）。 */
  private readonly serverVersion: string
  /** wave2：HTTP /file 端点（可选——未配置时 /file 走 404）。start() 前可经 setFileEndpoint 延迟绑定。 */
  private fileEndpoint?: FileEndpoint
  /** wave4 远程化：静态 Web 资源 handler（可选——server CLI --serve-web 模式）。
   *  /health 与 /file 已认领的请求不转交；其余 GET 请求转交此 handler（SPA fallback）。
   *  start() 前可经 setStaticHandler 延迟绑定（createServer 回调读 this，运行时解析）。 */
  private staticHandler?: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  /**
   * P5 presence：sessionService 内部接口（buildPresenceList 算 isOperating 用 allSessions 查 busyOwnerId）。
   * 经 setSessionService 延迟绑定（sessionService 在 server 构造后才创建）。
   */
  private sessionService: ISessionServiceInternal | null = null

  constructor(
    private port: number,
    private callbacks: ConnectionCallbacks,
    private opts: ConnectionManagerOptions,
  ) {
    // 解析可选 opts 为确定值：tokenManager 缺省 → 无 tokenFile（开放模式）；serverVersion 缺省 → '0.0.0'。
    this.tokenManager = opts.tokenManager ?? createTokenManager({})
    this.serverVersion = opts.serverVersion ?? '0.0.0'
    this.fileEndpoint = opts.fileEndpoint
    this.httpServer = createServer((req, res) => {
      // 用 URL 解析 pathname，剥离 query/fragment 后再匹配路由，避免 /file?token=x 这类
      // 带查询串的请求因 req.url !== '/file' 而漏匹配。req.url 形如 '/path?query'（相对路径），
      // 需传 base 才能用 URL 构造（http://x 为虚拟 base，仅用于解析，无副作用）。
      const pathname = new URL(req.url ?? '', 'http://x').pathname
      if (pathname === '/health') {
        res.writeHead(HTTP_OK, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }))
      } else if (this.fileEndpoint && pathname === '/file') {
        // wave2 远程化：转交 FileEndpoint.handle（签名校验 + 白名单 + 流式）。
        // handle 内部已完成所有状态码判定；此处只兜底未捕获异常（不应发生，防御性）。
        // 读 this.fileEndpoint（非构造期捕获）：允许 start 前经 setFileEndpoint 延迟绑定
        // （index.ts 中 sessionService 在 server 构造后才创建，fileEndpoint 依赖它）。
        // Bug 3：精确匹配 pathname === '/file'，避免 startsWith('/file') 误匹配 /filenames、
        // /file-backup 等未来静态路由（全转给 fileEndpoint 会抢资源）。
        this.fileEndpoint.handle(req, res).catch((e) => {
          console.error('[runtime] /file endpoint error:', e)
          if (!res.headersSent) {
            res.writeHead(HTTP_INTERNAL_ERROR, { 'Content-Type': 'text/plain' })
            res.end('internal error')
          }
        })
      } else if (this.staticHandler) {
        // wave4 远程化：未认领的请求转交静态 Web handler（SPA 资源 + 客户端路由 fallback）。
        // /health 与 /file 已在上游认领，此分支只服务前端静态文件。
        this.staticHandler(req, res).catch((e) => {
          console.error('[runtime] static web handler error:', e)
          if (!res.headersSent) {
            res.writeHead(HTTP_INTERNAL_ERROR, { 'Content-Type': 'text/plain' })
            res.end('internal error')
          }
        })
      } else {
        res.writeHead(HTTP_NOT_FOUND)
        res.end()
      }
    })
    // W1-T4：Origin 白名单。env 未配置时不挂 verifyClient（零回归）。
    const wssOpts: { server: HttpServer; verifyClient?: (info: { origin: string; secure: boolean }, cb: (res: boolean, code?: number, message?: string) => void) => void } = { server: this.httpServer }
    const allowedOrigins = parseAllowedOrigins()
    if (allowedOrigins) {
      wssOpts.verifyClient = (info, cb) => {
        if (allowedOrigins.has(info.origin)) cb(true)
        else cb(false, HTTP_NOT_FOUND, 'origin not allowed')
      }
    }
    this.wss = new WebSocketServer(wssOpts)
  }

  /**
   * wave2 远程化：延迟绑定 fileEndpoint。
   * 场景：index.ts 中 sessionService 在 RuntimeServer 构造后才 new（依赖 server 注入），
   * 而 fileEndpoint 依赖 sessionService（取活跃 cwd）——故 server 构造时 fileEndpoint 尚不可得。
   * 此 setter 允许在 start() 前注入。createServer 回调读 this.fileEndpoint（非构造期捕获），
   * 故延迟绑定生效。
   */
  setFileEndpoint(ep: FileEndpoint): void {
    this.fileEndpoint = ep
  }

  /**
   * wave4 远程化：注入静态 Web 资源 handler（server CLI --serve-web 模式）。
   *
   * 与 setFileEndpoint 同模式：createServer 回调读 this.staticHandler（非构造期捕获），
   * 故 start() 前注入即生效。未配置时（Electron 默认 / 旧路径）请求走 404，零回归。
   */
  setStaticHandler(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>): void {
    this.staticHandler = handler
  }

  /**
   * P5 presence：注入 sessionService 内部接口（buildPresenceList 算 isOperating 用）。
   * sessionService 在 server.setServices 时才创建，经此 setter 延迟绑定。未注入时 isOperating 全 false。
   */
  setSessionService(svc: ISessionServiceInternal): void {
    this.sessionService = svc
  }

  /**
   * P5 presence：设置某 clientId 的活跃 session（session.setActive RPC 调）。
   * 更新 activeSessions Map + 触发 broadcastPresence（activeSessionId 变化让其他客户端看到）。
   * clientId 不在 clients 时 no-op（已下线，broadcastPresence 遍历 clients 时不会出现）。
   */
  setActiveSession(clientId: string, sessionId: string | null): void {
    if (!this.clients.has(clientId)) return
    this.activeSessions.set(clientId, sessionId)
    this.broadcastPresence()
  }

  /** P5 presence：取某 clientId 的活跃 session（P7 resolver 用）。不存在返回 undefined。 */
  getActiveSession(clientId: string): string | null | undefined {
    return this.activeSessions.get(clientId)
  }

  /**
   * P5 presence：构造全量 presence 列表（PresenceConnection[]）。
   * 遍历 clients（clientId/deviceName）+ activeSessions（activeSessionId）+ sessionService.allSessions
   * （算 isOperating = 某 session 的 busyOwnerId===clientId）。
   * sessionService 未注入时 isOperating 全 false（降级）。
   */
  buildPresenceList(): PresenceConnection[] {
    // 收集所有持有 lease 的 clientId（isOperating=true）
    const operatingClients = new Set<string>()
    if (this.sessionService) {
      try {
        for (const session of this.sessionService.allSessions()) {
          if (session.busyOwnerId) operatingClients.add(session.busyOwnerId)
        }
      // eslint-disable-next-line taste/no-silent-catch -- presence 是瞬态，sessionService.allSessions 不可用（如测试 mock 不完整）时降级 isOperating 全 false，不阻断认证/连接流程
      } catch (e) {
        console.warn('[connection-manager] buildPresenceList allSessions failed, isOperating degraded to false:', e)
      }
    }
    const list: PresenceConnection[] = []
    for (const [clientId, ctx] of this.clients) {
      list.push({
        clientId,
        deviceName: ctx.deviceName,
        activeSessionId: this.activeSessions.get(clientId) ?? null,
        isOperating: operatingClients.has(clientId),
      })
    }
    return list
  }

  /**
   * P5 presence：广播 presence.update（全量列表）给所有连接。
   * 触发点：onConnect（上线）、onDisconnect（下线）、setActiveSession（切换）、lease 变化（dispatcher 调）。
   * 无连接时 no-op（broadcast 遍历空 pool）。
   */
  broadcastPresence(): void {
    const connections = this.buildPresenceList()
    // 经注入的 broadcast 回调广播（connection-manager 不直接持有 broker，避免环）。
    // server.ts 在 onConnect/onMessage 注入时，需提供 onPresenceUpdate 回调；未注入时 no-op。
    this.callbacks.onPresenceUpdate?.(connections)
  }

  /** 启动 HTTP + WS 监听；注册 connection 回调。 */
  start(): Promise<void> {
    const host = this.opts.host ?? '127.0.0.1'
    return new Promise((resolve, reject) => {
      this.wss.on('connection', (ws) => this.handleConnection(ws))
      this.httpServer.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`[runtime] port ${this.port} already in use, exiting`)
          process.exit(1)
        }
        reject(err)
      })
      this.httpServer.listen(this.port, host, () => {
        console.log(`[runtime] listening on ${host}:${this.port}`)
        resolve()
      })
    })
  }

  // ── Connection ────────────────────────────────────────────────

  private handleConnection(ws: WsType): void {
    const loaded = this.tokenManager.load()
    if (!loaded.enabled) {
      // 开放模式 loopback 守卫（审查 BLOCKER 2）：与 file-endpoint.ts:212-219 的 /file 防护对齐。
      // 当 token 文件缺失（开放模式）+ bindHost 非 loopback（如 XYZ_AGENT_HOST=0.0.0.0）时，
      // 任何网络客户端可无 token 连接获完全 WS 访问——这是配置错误（远程暴露必须配 token）。
      // 故此处拒绝 WS 连接，与 /file 端点的「开放模式 + 非 loopback 拒绝」语义一致。
      if (!this.isLoopbackBind()) {
        console.warn(`[runtime] open mode (no token) requires loopback bind, but host=${this.opts.host ?? '127.0.0.1'} — refusing WS connection`)
        ws.close(WS_CLOSE_UNAUTHORIZED, 'open_mode_requires_loopback')
        return
      }
      // 开放模式（旧路径零回归）：clientId 固定 'local'，立即入正式池 + 推 initial state + 心跳。
      const ctx: ConnectionCtx = { ws, clientId: 'local', deviceName: '', connectedAt: Date.now() }
      this.clients.set(ctx.clientId, ctx)
      console.log(`[runtime] client connected (total: ${this.clients.size})`)
      this.callbacks.onConnect(ws, 'local')
      // P5 presence：连接上线触发 presence 重推（通知其他客户端新设备在线）。
      this.broadcastPresence()
      this.resetHeartbeat(ws)
      this.attachMessageHandler(ws, 'local')
      this.attachLifecycleHandlers(ws, 'local')
      return
    }
    // 认证模式：pending 上限保护（防未认证连接堆积 DoS）。
    if (this.pending.size >= MAX_PENDING) {
      ws.close(WS_CLOSE_UNAUTHORIZED, 'server_busy')
      return
    }
    this.pending.add(ws)
    const timer = setTimeout(() => {
      // 超时兜底清理：失败/超时路径无 attachLifecycleHandlers，必须显式回收 pending + authTimers，
      // 否则配合 MAX_PENDING=20 形成永久 DoS（攻击者发 20 次未认证连接即可锁死池）。
      this.cleanupPendingAuth(ws)
      ws.close(WS_CLOSE_UNAUTHORIZED, 'auth_timeout')
    }, AUTH_TIMEOUT_MS)
    this.authTimers.set(ws, timer)
    // 首条消息须为合法 auth。认证通过后改走正式消息处理器（attachMessageHandler）。
    ws.once('message', (data) => {
      this.handleAuthMessage(ws, data)
    })
  }

  /**
   * 回收 pending 连接的资源（authTimers + pending）。
   * 用于所有认证失败/超时路径：失败分支未挂 attachLifecycleHandlers，无 close 事件兜底，
   * 故须在 close 前显式调用，避免 pending Set / authTimers Map 永久驻留已关闭 ws 引用。
   */
  private cleanupPendingAuth(ws: WsType): void {
    this.clearAuthTimer(ws)
    this.pending.delete(ws)
  }

  /**
   * 处理 pending 连接的首条消息（须为 auth）。认证成功升级为正式连接，否则关闭。
   * P2-s2 改 async：onAuthSuccess 是 Promise（broker.getReplayPlan 接口留异步扩展空间）。
   * once('message') 回调内 fire-and-forget 调用本方法（不 await 返回值），错误在此方法内部完全消化（ES1）。
   */
  private async handleAuthMessage(ws: WsType, data: unknown): Promise<void> {
    let msg: { type?: string; id?: string; payload?: { token?: unknown; clientId?: unknown; deviceName?: unknown; lastSeq?: unknown; bootId?: unknown; subscribedSessions?: unknown } }
    try {
      msg = JSON.parse(String(data))
    } catch {
      // JSON 解析失败视为「首消息非有效 auth」：清理 pending + 关闭。
      this.cleanupPendingAuth(ws)
      ws.close(WS_CLOSE_UNAUTHORIZED, 'auth_required')
      return
    }
    if (msg.type !== 'auth') {
      this.cleanupPendingAuth(ws)
      ws.close(WS_CLOSE_UNAUTHORIZED, 'auth_required')
      return
    }
    const payload = msg.payload ?? {}
    const token = typeof payload.token === 'string' ? payload.token : ''
    const clientId = typeof payload.clientId === 'string' ? payload.clientId : ''
    const deviceName = typeof payload.deviceName === 'string' ? payload.deviceName : ''
    if (!clientId || !this.tokenManager.verify(token)) {
      this.cleanupPendingAuth(ws)
      ws.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized')
      return
    }
    // P2-s2：解析重连凭据（lastSeq/bootId/subscribedSessions）。ES2：类型校验失败降级为 undefined/[]，
    // 不 close 连接（宽容处理旧客户端/协议漂移，走冷启动全量路径）。
    const input: AuthReplayInput = {
      lastSeq: typeof payload.lastSeq === 'number' ? payload.lastSeq : undefined,
      bootId: typeof payload.bootId === 'string' ? payload.bootId : undefined,
      subscribedSessions: Array.isArray(payload.subscribedSessions) && payload.subscribedSessions.every((s) => typeof s === 'string')
        ? payload.subscribedSessions as string[]
        : [],
    }
    // 认证成功：清理 pending/timer，踢同 clientId 旧连接，入正式池。
    this.cleanupPendingAuth(ws)
    this.kickExistingClient(clientId, ws)
    const ctx: ConnectionCtx = { ws, clientId, deviceName, connectedAt: Date.now() }
    this.clients.set(clientId, ctx)
    // WARNING 3（审查 auth-timer 竞态）：在 await onAuthSuccess 之前立即绑 lifecycle handler + 心跳。
    // 此前顺序是 await → replyAuth/replay → attachLifecycleHandlers，await 期间 ws 没绑 close handler，
    // 若对端此时关闭，close 事件无 handler → clients.delete/onDisconnect 不运行 → ctx 泄漏 +
    // presence/lease 清理跳过。提前绑定后 close 事件能正确触发清理；后续 replyAuth/ws.send 均已
    // check readyState（WS_OPEN），对已关闭 ws 是 no-op，安全。attachMessageHandler 仍延后到
    // replyAuth 之后（不应在 auth 回复前受理业务消息）。
    this.attachLifecycleHandlers(ws, clientId)
    this.resetHeartbeat(ws)
    console.log(`[runtime] client authenticated (clientId: ${clientId}, total: ${this.clients.size})`)

    // P2-s2 回放编排：onAuthSuccess 存在时调 broker.getReplayPlan 决定 resume/reset。
    // ES1：onAuthSuccess 抛错（broker 异常/逻辑错误）→ cleanupPendingAuth + close 4001（与认证失败一致）。
    if (this.callbacks.onAuthSuccess) {
      let decision: ReplayDecision
      try {
        decision = await this.callbacks.onAuthSuccess(ws, clientId, input)
      } catch (e) {
        console.error('[runtime] onAuthSuccess failed, closing connection:', e)
        this.cleanupPendingAuth(ws)
        this.clients.delete(clientId)
        ws.close(WS_CLOSE_UNAUTHORIZED, 'replay_failed')
        return
      }
      // replyAuth 携带 ReplayMeta（bootId/serverSeq/resumed/replayedCount/seqReset）。
      this.replyAuth(ws, msg.id, clientId, {
        resumed: decision.resume,
        seqReset: decision.seqReset,
        replayedCount: decision.replayedCount,
        bootId: decision.bootId,
        serverSeq: decision.serverSeq,
      })
      if (decision.resume) {
        // resume 路径：直发回放段（已序列化字符串，零再序列化），跳过 onConnect。
        // ES3：ws.send 前 check readyState（ws 可能在 await 期间已关闭）。
        for (const data of decision.messages) {
          if (ws.readyState === WS_OPEN) ws.send(data)
        }
      } else {
        // reset/冷启动路径：调 onConnect 推全量 initial state（含 seqReset 场景，推了无害）。
        this.callbacks.onConnect(ws, clientId)
      }
    } else {
      // onAuthSuccess 未注入（理论上认证模式必注入，兜底降级冷启动）。
      this.replyAuth(ws, msg.id, clientId, { resumed: false })
      this.callbacks.onConnect(ws, clientId)
    }

    this.attachMessageHandler(ws, clientId)
    // WARNING 3：attachLifecycleHandlers/resetHeartbeat 已在 clients.set 后（await 前）绑定，此处不重复。
    // P5 presence：认证成功上线触发 presence 重推（通知其他客户端新设备在线）。
    this.broadcastPresence()
  }

  /**
   * 挤占同 clientId 的旧连接（单点登录语义）：旧连接收到 4002 replaced 关闭。
   * 不立即从 clients Map delete——让旧 ws 的 close handler 自检 ws 一致性后跳过误删新连接。
   */
  private kickExistingClient(clientId: string, newWs: WsType): void {
    const existing = this.clients.get(clientId)
    if (existing && existing.ws !== newWs) {
      this.clearHeartbeat(existing.ws)
      this.clearAuthTimer(existing.ws)
      existing.ws.close(WS_CLOSE_REPLACED, 'replaced')
    }
  }

  /**
   * 认证通过后回复 auth.ok（含服务端版本 + 确认 clientId + P2-s2 ReplayMeta）。
   * ReplayMeta 字段全可选，JSON.stringify 自动忽略 undefined（向后兼容旧客户端只读 serverVersion/clientId）。
   */
  private replyAuth(ws: WsType, id: string | undefined, clientId: string, meta: ReplayMeta): void {
    // P5 presence：auth.ok 顺带带 presence 全量列表（spec D10，省首次 round-trip）。
    // buildPresenceList 含当前刚入池的 clientId（已 clients.set），客户端首连即知在线设备。
    const presence = this.buildPresenceList()
    const payload = JSON.stringify({
      type: 'auth.ok',
      id,
      payload: { serverVersion: this.serverVersion, clientId, ...meta, presence },
    })
    if (ws.readyState === WS_OPEN) ws.send(payload)
  }

  /**
   * 正式消息处理器（认证通过/开放模式共用）。
   * 复刻原 handleConnection 的 ws.on('message') 语义：解析 → 重置心跳 → 路由（错误兜底）。
   */
  private attachMessageHandler(ws: WsType, clientId: string): void {
    ws.on('message', (data) => {
      try {
        const msg: ClientMessage = JSON.parse(data.toString())
        this.resetHeartbeat(ws)
        this.callbacks.onMessage(msg, ws, clientId).catch((err) => {
          console.error('[runtime] unhandled error in handleMessage:', err)
          try {
            this.callbacks.sendError(ws, 'handler_error', toErrorMessage(err), msg.id)
          // eslint-disable-next-line taste/no-silent-catch -- ws may have already closed
          } catch { /* ws 可能已关闭 */ }
        })
      } catch { this.callbacks.sendError(ws, 'parse_error', 'Invalid JSON') }
    })
  }

  /**
   * close/error 生命周期处理（认证通过/开放模式共用）。
   * 删除条件加 ws 一致性检查：踢占场景下旧 ws 关闭时 clientId 已被新 ws 占用，
   * 此时 ctx.ws !== ws → 跳过 delete，避免误删新连接。
   */
  private attachLifecycleHandlers(ws: WsType, clientId: string): void {
    ws.on('close', () => {
      const ctx = this.clients.get(clientId)
      const isCurrent = ctx && ctx.ws === ws
      if (isCurrent) this.clients.delete(clientId)
      this.pending.delete(ws)
      this.clearHeartbeat(ws)
      this.clearAuthTimer(ws)
      console.log(`[runtime] client disconnected (total: ${this.clients.size})`)
      // P5 onDisconnect：仅当关闭的是当前连接（非被踢占的旧连接）才回调，避免误通知新连接下线。
      // 踢占场景：kickExistingClient 关闭旧 ws 时 clientId 已被新 ws 占用（ctx.ws!==ws），跳过回调。
      if (isCurrent) {
        this.activeSessions.delete(clientId)
        try {
          this.callbacks.onDisconnect(ws, clientId)
        // eslint-disable-next-line taste/no-silent-catch -- onDisconnect 是 presence 推送等副作用，失败不应阻断 close 清理
        } catch (e) {
          console.error('[runtime] onDisconnect callback error:', e)
        }
        // P5 presence：连接下线触发 presence 重推（通知其他客户端该设备离线）。
        this.broadcastPresence()
      }
    })
    ws.on('error', (err) => {
      console.error('[runtime] ws error:', err)
      const ctx = this.clients.get(clientId)
      const isCurrent = ctx && ctx.ws === ws
      if (isCurrent) this.clients.delete(clientId)
      this.pending.delete(ws)
      this.clearHeartbeat(ws)
      this.clearAuthTimer(ws)
      if (isCurrent) {
        this.activeSessions.delete(clientId)
        try {
          this.callbacks.onDisconnect(ws, clientId)
        // eslint-disable-next-line taste/no-silent-catch -- 同 close 路径
        } catch (e) {
          console.error('[runtime] onDisconnect callback error:', e)
        }
        this.broadcastPresence()
      }
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

  private clearAuthTimer(ws: WsType): void {
    const timer = this.authTimers.get(ws)
    if (timer) { clearTimeout(timer); this.authTimers.delete(ws) }
  }

  /**
   * 判定当前监听 host 是否为 loopback（审查 BLOCKER 2）。
   * 与 file-endpoint.ts 的 loopback 判断逻辑一致：host 是 127.0.0.1 / ::1 / localhost 之一。
   * opts.host 缺省时默认 127.0.0.1（loopback），与 start() 的 host 解析口径对齐。
   * 用于开放模式守卫——非 loopback 绑定 + 开放模式 = 配置错误，拒绝 WS 连接。
   */
  private isLoopbackBind(): boolean {
    const host = this.opts.host ?? '127.0.0.1'
    return host === '127.0.0.1' || host === '::1' || host === 'localhost'
  }

  /** 关闭：清理心跳/认证计时器 + 关闭 pending/已认证 ws + 关闭 WS / HTTP。 */
  async stop(): Promise<void> {
    for (const timer of this.heartbeatTimers.values()) {
      clearTimeout(timer)
    }
    this.heartbeatTimers.clear()
    for (const timer of this.authTimers.values()) {
      clearTimeout(timer)
    }
    this.authTimers.clear()
    // WARNING 4（审查 pending ws 泄漏）：stop() 此前只清计时器 + wss.close()，
    // 但未迭代 pending 关闭未认证 ws。计时器被清后 pending 连接永不超时，
    // 作为打开 socket 泄漏到 TCP 超时。此处显式关闭所有 pending ws，同步清空 pending 集合。
    for (const ws of this.pending) {
      try {
        ws.close(WS_CLOSE_UNAUTHORIZED, 'server_shutdown')
      // eslint-disable-next-line taste/no-silent-catch -- stop 路径不能因单个 ws.close 失败中断其余清理
      } catch {
        // ws 可能已关闭/异常，跳过
      }
    }
    this.pending.clear()
    // 同步关闭已认证连接（clients Map），避免它们依赖已销毁的 httpServer。
    for (const ctx of this.clients.values()) {
      try {
        ctx.ws.close(WS_CLOSE_NORMAL, 'server_shutdown')
      // eslint-disable-next-line taste/no-silent-catch -- 同上，单个失败不阻断其余清理
      } catch {
        // ws 可能已关闭/异常，跳过
      }
    }
    this.clients.clear()
    this.wss.close()
    return new Promise((resolve) => { this.httpServer.close(() => resolve()) })
  }
}

/** WS OPEN 状态码——broker.send 检测连接态用。 */
export const WS_OPEN = WebSocket.OPEN

/**
 * 解析允许的 Origin 白名单（W1-T4）。
 * env XYZ_AGENT_ALLOWED_ORIGINS 为逗号分隔列表（如 'http://localhost:5173,app://-'）。
 * 未设置/空 → 返回 null（不启用 verifyClient，零回归）。
 */
function parseAllowedOrigins(): Set<string> | null {
  const raw = process.env.XYZ_AGENT_ALLOWED_ORIGINS
  if (!raw) return null
  const set = new Set<string>()
  for (const part of raw.split(',')) {
    const trimmed = part.trim()
    if (trimmed) set.add(trimmed)
  }
  return set.size > 0 ? set : null
}
