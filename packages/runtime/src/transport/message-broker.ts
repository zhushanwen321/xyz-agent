/**
 * ServerMessageBroker — IMessageBroker 实现：消息发送 + 广播 + initial state 推送（C2 从 server.ts 抽出）。
 *
 * 职责：
 * - IMessageBroker 三方法：send（单 ws）/ broadcast（所有 ws）/ sendError（统一 error envelope，D10/P0-B）。
 * - reply（D2）：带请求 id 的回复，E1 泛型化收窄 payload（ADR-0015 双向保护）。
 * - 8 个 broadcast helper：session/provider/skill/agent/skillDirs/agentDirs 列表广播（settings handler 触发）。
 * - sendInitialState（D7）：新连接推送 8 段 descriptor 驱动的初始状态。
 * - pushId 计数器：所有 push 消息的 id 生成（`push_<n>`）。
 *
 * 不含：连接生命周期（ConnectionManager）、消息路由（server.ts）、业务逻辑（handlers）。
 * broadcast 遍历 ConnectionManager.clients；sendInitialState 依赖 services 取数据。
 */
import type { WebSocket as WsType } from 'ws'
import type { ServerMessage, ServerMessageMap, ServerMessageType } from '@xyz-agent/shared'
import type { ISessionService, IConfigService, IModelService, IMessageBroker, IPluginService, IExtensionService } from '../interfaces.js'
import { buildDirConfigs, PRESET_SKILL_DIRS, PRESET_AGENT_DIRS } from '../services/skill-dir-config.js'
import type { ErrorDetails } from './message-context.js'
import { WS_OPEN } from './connection-manager.js'

/** broker 访问连接池的最小契约（由 ConnectionManager 实现：clients Set）。 */
export interface ClientPool {
  readonly clients: Set<WsType>
}

/**
 * sendInitialState 需要的领域依赖（D7 8 段 descriptor 各取所需）。
 * 与 RuntimeServer.setServices 注入的 services 对齐——broker 不直接持有 git/file（initial state 不涉及）。
 */
export interface BrokerServices {
  sessionService: ISessionService
  configService: IConfigService
  modelService: IModelService
  pluginService: IPluginService | undefined
  /** extension service（sendInitialState 推 config.extensions 段需要；可选，未注入则跳过该段）。 */
  extensionService: IExtensionService | undefined
  projectRoot: string
  /** 应用 + pi 版本号（sendInitialState 推 app.info）。 */
  appInfo: { appVersion: string; piVersion: string }
  /**
   * 公共 session id 的动态读取器（runtime 启动期创建后才有值）。
   * sendInitialState 推 app.info 时调用，把 publicSessionId 带给前端。
   * undefined 表示公共 session 尚未创建/不可用，前端 landing 降级到 skills fallback。
   */
  getPublicSessionId?: () => string | undefined
}

export class ServerMessageBroker implements IMessageBroker {
  private pushId = 0

  constructor(
    private pool: ClientPool,
    private services: BrokerServices,
  ) {}

  /** push 消息 id 生成器（broadcast helper / sendInitialState 共用）。 */
  nextPushId(): string { return `push_${++this.pushId}` }

  // ── IMessageBroker ──────────────────────────────────────────────

  send(ws: WsType, msg: ServerMessage): void {
    if (ws.readyState === WS_OPEN) ws.send(JSON.stringify(msg))
  }

  broadcast(msg: ServerMessage): void {
    // L6（perf-quick-batch）：循环外序列化一次。
    // 旧实现循环内调 this.send → send 内 JSON.stringify(msg)，N 客户端 = N 次重复
    // 序列化同一对象。session.list 等大 payload 广播时主线程被重复 stringify 阻塞。
    // 现在循环前序列化一次得 payload 字符串，循环内直接 ws.send(payload)。
    let payload: string
    try {
      payload = JSON.stringify(msg)
    // eslint-disable-next-line taste/no-silent-catch -- D4: 提级后 stringify 失败影响整次广播，与"全 client 各自失败"实际等价。记录后中止本次广播，不静默
    } catch (e) {
      console.error('[runtime] broadcast aborted: payload serialization failed', e)
      return
    }
    for (const ws of this.pool.clients) {
      // M6: 单 client send 失败不中断其余 client 广播。
      // TOCTOU：readyState 检查与 ws.send 间连接可能已关闭，ws.send 抛错，
      // 无 try-catch 会中断整个 for 循环，导致其余 client 收不到消息。
      if (ws.readyState !== WS_OPEN) continue
      try {
        ws.send(payload)
      // eslint-disable-next-line taste/no-silent-catch -- broadcast 是 fire-and-forget 推送，单 client 失败不能影响其余 client
      } catch {
        // 单 client 已断连/异常，跳过继续广播给其余 client
      }
    }
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

  /**
   * D2 reply 惯用法：发送带请求 id 的回复，消灭 46 处 `send(ws,{type,id:msg.id,payload})` 样板。
   * E1 泛型化：`type` 字面量收窄 `payload` 到 `ServerMessageMap[T]`，构造侧字段错误在编译期暴露（ADR-0015 双向保护）。
   */
  reply<T extends ServerMessageType>(ws: WsType, id: string | undefined, type: T, payload: ServerMessageMap[T]): void {
    this.send(ws, { type, id, payload })
  }

  // ── Shared payload builders ─────────────────────────────────────
  // broadcast helpers 与 sendInitialState 此前各自重建同一组 provider/skill/agent/dir/model
  // payload（两份「initial/config state」表示）。现抽取私有 builder：只负责 load + 构造
  // ServerMessage（id 用 nextPushId），不含路由。broadcast 走 this.broadcast、sendInitialState
  // 走 this.send(ws,·)，共用同一 builder，消除 payload 构造重复。
  // 每个 builder 返回 1~2 条消息（provider 段含 config.providers + model.list）。

  private buildSessionListMsg(): ServerMessage {
    return { type: 'session.list', id: this.nextPushId(), payload: { groups: this.services.sessionService.listPersistedSessions() } }
  }
  /**
   * app.info 消息构造（sendInitialState 首推 + broadcastAppInfo 重广播共用）。
   * publicSessionId 动态读 getPublicSessionId()——公共 session 在 runtime 启动收尾才创建，
   * 首次 sendInitialState 时可能 undefined，创建成功后需重广播（broadcastAppInfo）补发。
   */
  private buildAppInfoMsg(): ServerMessage {
    return {
      type: 'app.info',
      id: this.nextPushId(),
      payload: {
        ...this.services.appInfo,
        publicSessionId: this.services.getPublicSessionId?.(),
      },
    }
  }
  private buildProviderListMsgs(): ServerMessage[] {
    const providers = this.services.configService.listProviders()
    return [
      { type: 'config.providers', id: this.nextPushId(), payload: { providers } },
      { type: 'model.list', id: this.nextPushId(), payload: { models: this.services.modelService.aggregateModels(providers) } },
    ]
  }
  private buildSkillListMsg(): ServerMessage {
    return { type: 'config.skills', id: this.nextPushId(), payload: { skills: this.services.configService.loadSkills(this.services.projectRoot) } }
  }
  private buildAgentListMsg(): ServerMessage {
    return { type: 'config.agents', id: this.nextPushId(), payload: { agents: this.services.configService.loadAgents(this.services.projectRoot) } }
  }
  /** skill 加载路径配置（ADR-0020 §1 discovery.json SSOT 的 UI 视图）。 */
  private buildSkillDirsMsg(): ServerMessage {
    return { type: 'config.skillDirs', id: this.nextPushId(), payload: { dirs: buildDirConfigs(PRESET_SKILL_DIRS, this.services.configService.getSkillDirs()) } }
  }
  /** agent 加载路径配置（ADR-0020 §1 discovery.json SSOT 的 UI 视图）。 */
  private buildAgentDirsMsg(): ServerMessage {
    return { type: 'config.agentDirs', id: this.nextPushId(), payload: { dirs: buildDirConfigs(PRESET_AGENT_DIRS, this.services.configService.getAgentDirs()) } }
  }

  // ── Broadcast helpers ──────────────────────────────────────────

  broadcastSessionList(): void {
    this.broadcast(this.buildSessionListMsg())
  }
  broadcastProviderList(): void {
    for (const msg of this.buildProviderListMsgs()) this.broadcast(msg)
  }
  broadcastSkillList(): void {
    this.broadcast(this.buildSkillListMsg())
  }
  broadcastAgentList(): void {
    this.broadcast(this.buildAgentListMsg())
  }
  /** 广播 skill 加载路径配置（ADR-0020 §1 discovery.json SSOT 的 UI 视图）。 */
  broadcastSkillDirs(): void {
    this.broadcast(this.buildSkillDirsMsg())
  }
  /** 广播 agent 加载路径配置（ADR-0020 §1 discovery.json SSOT 的 UI 视图）。 */
  broadcastAgentDirs(): void {
    this.broadcast(this.buildAgentDirsMsg())
  }
  /**
   * 重广播 app.info（带最新 publicSessionId）。
   *
   * 用途：公共 session 在 runtime 启动收尾才创建（server.start 之后 ensurePublicSession），
   * 首次 sendInitialState 推 app.info 时 publicSessionId 多为 undefined。公共 session
   * 创建成功后调此方法补发，前端据此填 sessionStore.publicSessionId + 拉命令到 commandStore，
   * landing 态 slash popover 才能显示 pi extension 命令（/goal 等）。
   */
  broadcastAppInfo(): void {
    this.broadcast(this.buildAppInfoMsg())
  }

  /**
   * D7: sendInitialState 改 descriptor 驱动。
   * 此前 6 段同构 best-effort try/catch（eslint-disable 注释也复制了 6 次）。
   * 现在每段是一个 { label, run } descriptor，共享 try/catch 包装器只写一次。
   * run 内含 load + 条件 + send，领域差异保留在各自 descriptor。
   *
   * 与 broadcast helper 去重：前 7 段（session/provider+model/skills/skillDirs/agents/agentDirs）
   * 改为调用与 broadcast helper 共享的 buildXxx builder，消除此前两处独立重建同一 payload。
   * 仅 config.defaults / config.plugins 两段为 initial-state 独有（无对应 broadcast helper），保留 inline。
   */
  sendInitialState(ws: WsType): void {
    const { configService, pluginService, extensionService } = this.services
    const steps: Array<{ label: string; run: () => void }> = [
      {
        label: 'app.info',
        run: () => this.send(ws, this.buildAppInfoMsg()),
      },
      {
        label: 'session.list',
        run: () => this.send(ws, this.buildSessionListMsg()),
      },
      {
        label: 'config.providers/model.list',
        run: () => { for (const msg of this.buildProviderListMsgs()) this.send(ws, msg) },
      },
      {
        label: 'config.defaults',
        run: () => {
          const defaultModel = configService.getDefaultModel()
          if (defaultModel) {
            this.send(ws, { type: 'config.defaults', id: this.nextPushId(), payload: { defaultModel: `${defaultModel.provider}/${defaultModel.modelId}` } })
          }
        },
      },
      {
        label: 'config.skills',
        run: () => this.send(ws, this.buildSkillListMsg()),
      },
      {
        label: 'config.skillDirs',
        run: () => this.send(ws, this.buildSkillDirsMsg()),
      },
      {
        label: 'config.agents',
        run: () => this.send(ws, this.buildAgentListMsg()),
      },
      {
        label: 'config.agentDirs',
        run: () => this.send(ws, this.buildAgentDirsMsg()),
      },
      {
        label: 'config.plugins',
        run: () => {
          if (pluginService) {
            this.send(ws, { type: 'config.plugins', id: this.nextPushId(), payload: { plugins: pluginService.getDiscoveredPlugins() } })
          }
        },
      },
      {
        // extension 列表（已装的 pi extension）。前端 Settings · ExtensionPage 的
        // 「已安装」区 + 推荐区的 installed 状态都依赖此初始推送。install/uninstall/toggle
        // 后的 reply（config.extensions）会增量更新，但首次打开需要 initial state。
        //
        // scanExtensions 是 async（读文件系统），而 sendInitialState 的 for 循环是同步的
        // （onConnect 签名 void）。这里 fire-and-forget + 自带 catch：扫描完成后异步 send，
        // 失败仅记日志，不阻塞其他 step，也不影响外层同步 try-catch（Promise reject 自消费）。
        label: 'config.extensions',
        run: () => {
          if (!extensionService) return
          extensionService.scanExtensions()
            .then((extensions) => {
              this.send(ws, { type: 'config.extensions', id: this.nextPushId(), payload: { extensions } })
            })
            .catch((e) => console.error(`[runtime] sendInitialState: config.extensions scan failed:`, e))
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
}
