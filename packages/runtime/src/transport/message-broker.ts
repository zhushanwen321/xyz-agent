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
import { randomUUID } from 'node:crypto'
import type { WebSocket as WsType } from 'ws'
import type { ServerMessage, ServerMessageMap, ServerMessageType } from '@xyz-agent/shared'
import type { ISessionService, IConfigService, IModelService, IMessageBroker, IPluginService, IExtensionService } from '../interfaces.js'
import { buildDirConfigs, PRESET_SKILL_DIRS, PRESET_AGENT_DIRS, PRESET_EXTENSION_DIRS } from '../services/skill-dir-config.js'
import { ExtensionTimeoutManager } from '../services/extension-timeout-manager.js'
import type { ErrorDetails } from './message-context.js'
import { WS_OPEN, type ConnectionCtx } from './connection-manager.js'
import { SeqCounter } from './seq-counter.js'
import { SessionBuffer } from './session-buffer.js'

/**
 * per-session replay buffer 默认上限（spec §八）。
 * 提为模块常量避免 no-magic-numbers 警告；env 可覆盖（XYZ_AGENT_REPLAY_MAX_*_PER_SESSION）。
 */
const DEFAULT_MAX_MESSAGES_PER_SESSION = 1000
// eslint-disable-next-line no-magic-numbers -- spec §八 默认 8MB/session = 8 * 1024 * 1024
const DEFAULT_MAX_BYTES_PER_SESSION = 8 * 1024 * 1024

/** broker 访问连接池的最小契约（由 ConnectionManager 实现：clients Map<clientId, ConnectionCtx>）。 */
export interface ClientPool {
  readonly clients: Map<string, ConnectionCtx>
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
  /**
   * extension timeout manager（sendInitialState 第 14 段聚合 pending UI 请求需要，P3 D3）。
   * 必填：第 14 段恒定推送（即使空数组），getAllPendingRequests 总可调（server.ts:78 字段构造即初始化）。
   */
  extensionTimeoutMgr: ExtensionTimeoutManager
  projectRoot: string
  /** 应用 + pi 版本号（sendInitialState 推 app.info）。 */
  appInfo: { appVersion: string; piVersion: string }
}

export class ServerMessageBroker implements IMessageBroker {
  private pushId = 0
  /**
   * 广播消息的全局单调 seq 计数器（P2 可靠投递层）。
   * 仅 broadcast 入口调用；reply/sendInitialState 点对点不打 seq（见 spec D1）。
   */
  private readonly seqCounter = new SeqCounter()

  /**
   * runtime 实例 id（D9）：启动生成 crypto.randomUUID()，auth.ok 携带，客户端重连带回。
   * 不匹配 → seqReset（runtime 重启后内存 buffer 清零、seq 归 0，旧 lastSeq 无意义）。
   */
  private readonly bootId = randomUUID()

  /**
   * per-session ring buffer 分桶（D2）：Map<sessionId, SessionBuffer>。
   * 分桶键 = payload.sessionId（动态判定）。无 sessionId 的全局消息不入桶。
   * 桶数天然受 XYZ_AGENT_MAX_SESSIONS（P0 §七，默认 10）上限保护——session 销毁调 clearSessionBuffer 清桶。
   */
  private readonly sessionBuffers = new Map<string, SessionBuffer>()

  /**
   * 全局 evictedWatermark（D4）：所有 session 桶因 LRU 驱逐产生的最大被驱逐 seq。
   * 重连判定：客户端 lastSeq < watermark → 不可回放 → seqReset。
   * 仅 LRU 驱逐推进；clearSessionBuffer（session 销毁）与巨消息豁免不推进（D4①②）。
   */
  private evictedWatermark = 0

  /**
   * per-session 条数上限默认值（spec §八：1000 条）。
   * 提为模块常量便于 eslint no-magic-numbers 合规 + 自文档。
   */
  private readonly maxCountPerSession = Number(process.env.XYZ_AGENT_REPLAY_MAX_MESSAGES_PER_SESSION ?? DEFAULT_MAX_MESSAGES_PER_SESSION)

  /**
   * per-session 字节上限默认值（spec §八：8MB）。
   */
  private readonly maxBytesPerSession = Number(process.env.XYZ_AGENT_REPLAY_MAX_BYTES_PER_SESSION ?? DEFAULT_MAX_BYTES_PER_SESSION)

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
    let sequencedSeq: number
    try {
      // P2 可靠投递层：broadcast 入口给 envelope 打全局单调 seq。
      // 在 stringify 之前注入 → 客户端收到的 JSON 含 seq；stringify 失败时 seq 已自增留空洞。
      // reply（send）/sendInitialState 不经此路径，天然无 seq（spec D1）。
      const sequenced = { ...msg, seq: this.seqCounter.assignSeq() }
      sequencedSeq = sequenced.seq
      payload = JSON.stringify(sequenced)
    // D4（不等价语义，刻意取舍）：提级后整次广播只 stringify 一次，
    // 一旦失败 → 本次广播对**所有 client 都丢弃**（连原本可正常收的 client 也收不到）。
    // 旧实现（循环内 per-client send 各自 stringify）失败只影响那一个 client，其余 client 照常收到。
    // 取舍：减少 N×stringify 主线程开销（大 payload 广播时显著）换取 per-client 失败隔离性损失。
    // 失败时显眼告警（[broadcast] 前缀，便于运维日志检索排查）。
    } catch (e) {
      console.error('[broadcast] payload serialization failed — entire broadcast dropped for all clients:', e)
      return
    }
    // P2-s1-w2：per-session 分桶入桶（spec §3.1）。
    // 三条排除规则（CT-W2.4 不变式，不可绕过）：
    //   (1) 无 sid 的全局消息（config.*/model.*/workspace.*）不入桶（ES1，靠 initial state 兜底）；
    //   (2) terminal.data 不入 session 桶（D3，走独立 scrollback，P2-s3）——唯一 type 名硬编码；
    //   (3) 巨消息（byteLength > maxBytesPerSession）不入桶（ES4，避免清空整桶，不推进 watermark）。
    // 入桶读 sequencedSeq（w1 assignSeq 已分配值），SessionBuffer 不得再调 seqCounter.assignSeq
    // （w1 retrospect 约定：多入口调 assignSeq 会破坏全局单调性）。
    // 字节口径：用 Buffer.byteLength(payload, 'utf8') 而非 payload.length（UTF-16 code unit 计数）。
    // env 名 XYZ_AGENT_REPLAY_MAX_BYTES_PER_SESSION 是字节语义，CJK/emoji 的 .length 显著小于真实
    // UTF-8 字节数（如「你好」length=2 但 byteLength=6），用 .length 会让内存上限语义偏松。性能可接受
    // （广播频率不高，每条消息一次 Buffer.byteLength 调用）。与 SessionBuffer.bytes 累加口径一致。
    const sid = (msg.payload as { sessionId?: string } | null)?.sessionId
    if (sid && msg.type !== 'terminal.data' && Buffer.byteLength(payload, 'utf8') <= this.maxBytesPerSession) {
      let buf = this.sessionBuffers.get(sid)
      if (!buf) {
        buf = new SessionBuffer(this.maxCountPerSession, this.maxBytesPerSession, (s) => {
          // 只 LRU 驱逐推进 watermark（D4）；取 max 防回退（理论上 seq 单调，max 等同赋值，防御性写法）。
          if (s > this.evictedWatermark) this.evictedWatermark = s
        })
        this.sessionBuffers.set(sid, buf)
      }
      buf.append(sequencedSeq, payload)
    }
    for (const ctx of this.pool.clients.values()) {
      const ws = ctx.ws
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

  // ── P2-s1-w2: per-session buffer 回放 API（IF4/IF5）─────────────────

  /**
   * 计算重连回放计划（spec §3.2 / CT-W2.2）。
   *
   * - bootId !== this.bootId → reset（runtime 重启，旧 lastSeq 无意义）。
   * - lastSeq < evictedWatermark → reset（缺失段已被 LRU 驱逐，无法增量回放，只能全量）。
   * - 否则 resume：只遍历 subscribedSessions 对应桶（D2.1，防僵尸分区——回放未订阅 session
   *   会触发前端为该 session 创建僵尸分区），收集 seq > lastSeq 条目按全局 seq 升序合并。
   *
   * messages 元素是已序列化字符串（与 ws.send 入参同一产物），auth 握手层直接 ws.send(data)。
   * 本 wave 只实现计算，不接 auth 编排（s2 slice 调用此方法决定 resumed/seqReset）。
   *
   * @param lastSeq 客户端已收到的最大 seq（同页面生命周期重连携带）
   * @param bootId 客户端记录的 runtime 实例 id（与 lastSeq 成对）
   * @param subscribedSessions 客户端持有分区的 session 列表（messages.keys() 并集）
   * @returns {kind:'resume', messages} 或 {kind:'reset'}；resume 的 messages 可为空数组（无缺失）
   */
  getReplayPlan(
    lastSeq: number,
    bootId: string,
    subscribedSessions: string[],
  ): { kind: 'resume'; messages: string[] } | { kind: 'reset' } {
    if (bootId !== this.bootId || lastSeq < this.evictedWatermark) {
      // 短路返回，不遍历桶（bootId 不匹配或 lastSeq 失效，回放无意义）
      return { kind: 'reset' }
    }
    // 只遍历订阅 session 桶（D2.1），收集 seq>lastSeq 条目
    const collected: { seq: number; data: string }[] = []
    for (const sid of subscribedSessions) {
      const buf = this.sessionBuffers.get(sid)
      if (buf) collected.push(...buf.getReplayPlan(lastSeq))
    }
    // 多桶间 seq 全局唯一单调（D1），按 seq 升序合并即全局序
    collected.sort((a, b) => a.seq - b.seq)
    return { kind: 'resume', messages: collected.map((e) => e.data) }
  }

  /**
   * session 销毁时清桶（CT-W2.3 / ES6）。
   * 移除整桶，**不推进 evictedWatermark**（session 已删，客户端收到 session.deleted 清分区，
   * 不该再期待该 session 消息——watermark 推进会导致误判其他 session 不可回放）。
   * 桶不存在时 no-op 不抛异常。
   */
  clearSessionBuffer(sessionId: string): void {
    this.sessionBuffers.delete(sessionId)
  }

  /** runtime 实例 id（auth.ok 携带给客户端，重连带回判定）。 */
  getBootId(): string {
    return this.bootId
  }

  /**
   * 全局 evictedWatermark（D4）：所有桶 LRU 驱逐过的最大 seq。
   * 客户端 lastSeq < watermark → seqReset。s2 auth 层据此决定 resumed/seqReset。
   */
  getEvictedWatermark(): number {
    return this.evictedWatermark
  }

  /**
   * 当前已分配的最大 seq（只读，P2-s2 auth.ok 携带 serverSeq 用）。
   * 客户端下次重连带回作 lastSeq；未广播过任何消息时返回 0。
   */
  getSeq(): number {
    return this.seqCounter.current
  }

  /**
   * 取某 session 的缓冲桶（测试断言用 / 调试用）。
   * 桶不存在返回 undefined（无消息入过桶或已被 clearSessionBuffer 删除）。
   */
  getSessionBuffer(sessionId: string): SessionBuffer | undefined {
    return this.sessionBuffers.get(sessionId)
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

  /**
   * P5 lease/presence：定向投递给指定 clientId（点对点，不打 seq、不入 P2 ring buffer 桶）。
   *
   * 与 broadcast 的差异：①只发一个目标 client（按 clientId 从连接池取 ctx.ws）；
   * ②不调 seqCounter.assignSeq（定向投递非广播，与 reply/send 同语义）；③不入 session 桶
   * （定向投递不参与 resume 回放——send.rejected 是发起方瞬时反馈，重连无意义）。
   * 目标 clientId 不存在或 ws 已关闭时 no-op 不抛错（fire-and-forget，ES3 同 broadcast）。
   *
   * 用于 send.rejected（发起方专属 reply）等定向投递场景。
   */
  sendToClient(clientId: string, msg: ServerMessage): void {
    const ctx = this.pool.clients.get(clientId)
    if (!ctx) return // 目标不在线：no-op（定向投递是 fire-and-forget，离线丢失可接受）
    this.send(ctx.ws, msg)
  }

  /**
   * P5 lease/presence：广播给除 excludeClientId 外的所有客户端（点对点集合，不打 seq、不入桶）。
   *
   * 与 broadcast 的差异：①跳过 excludeClientId；②不打 seq、不入 session 桶（同 sendToClient 语义）。
   * 单 client send 失败不中断其余（M6 同 broadcast）。用于 session.busy（排除发起方）等定向广播。
   */
  broadcastExcept(excludeClientId: string, msg: ServerMessage): void {
    let payload: string
    try {
      payload = JSON.stringify(msg)
    } catch (e) {
      // 序列化失败整次丢弃（同 broadcast 取舍）：定向广播是 fire-and-forget，失败仅记日志。
      console.error('[broadcastExcept] payload serialization failed — entire broadcast dropped:', e)
      return
    }
    for (const [clientId, ctx] of this.pool.clients) {
      if (clientId === excludeClientId) continue
      const ws = ctx.ws
      if (ws.readyState !== WS_OPEN) continue
      try {
        ws.send(payload)
      // eslint-disable-next-line taste/no-silent-catch -- broadcast 是 fire-and-forget 推送，单 client 失败不能影响其余 client
      } catch {
        // 单 client 已断连/异常，跳过继续广播给其余 client
      }
    }
  }

  // ── Shared payload builders ─────────────────────────────────────
  // broadcast helpers 与 sendInitialState 此前各自重建同一组 provider/skill/agent/dir/model
  // payload（两份「initial/config state」表示）。现抽取私有 builder：只负责 load + 构造
  // ServerMessage（id 用 nextPushId），不含路由。broadcast 走 this.broadcast、sendInitialState
  // 走 this.send(ws,·)，共用同一 builder，消除 payload 构造重复。
  // 每个 builder 返回 1~2 条消息（provider 段含 config.providers + model.list）。

  private buildSessionListMsg(): ServerMessage {
    return { type: 'config.sessions', id: this.nextPushId(), payload: { groups: this.services.sessionService.listPersistedSessions() } }
  }
  /**
   * app.info 消息构造（sendInitialState 首推）。
   */
  private buildAppInfoMsg(): ServerMessage {
    return {
      type: 'app.info',
      id: this.nextPushId(),
      payload: { ...this.services.appInfo },
    }
  }
  private buildProviderListMsgs(): ServerMessage[] {
    const providers = this.services.configService.listProviders()
    return [
      // P6 D3：广播携带 config version（客户端缓存用于下次 setProvider 的 expectedVersion）。
      { type: 'config.providers', id: this.nextPushId(), payload: { providers, version: this.services.configService.getConfigVersion() } },
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
  /** extension 加载路径配置（ADR-0020 §1 discovery.json SSOT 的 UI 视图）。 */
  private buildExtensionDirsMsg(): ServerMessage {
    return { type: 'config.extensionDirs', id: this.nextPushId(), payload: { dirs: buildDirConfigs(PRESET_EXTENSION_DIRS, this.services.configService.getExtensionDirs()) } }
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
  /** 广播 extension 加载路径配置（ADR-0020 §1 discovery.json SSOT 的 UI 视图）。 */
  broadcastExtensionDirs(): void {
    this.broadcast(this.buildExtensionDirsMsg())
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
        label: 'config.sessions',
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
        label: 'config.extensionDirs',
        run: () => this.send(ws, this.buildExtensionDirsMsg()),
      },
      {
        // config.systemPrompt（FR-4/FR-5）：spec §6 要求「reply + broadcast + 初始推送三用」。
        // 前两用在 settings handler + ConfigService 变更广播，此段补 initial-state 推送，
        // 前端首次打开 Settings · SystemPromptPage 无需额外 getSystemPrompt 往返即可填充编辑态。
        label: 'config.systemPrompt',
        run: () => {
          const r = configService.getSystemPromptConfig()
          this.send(ws, { type: 'config.systemPrompt', id: this.nextPushId(), payload: { config: r.config, corrupted: r.corrupted } })
        },
      },
      {
        // config.terminalConfig（Phase 6）：复刻 config.systemPrompt 范式，初始推送 terminal 配置，
        // 前端首次打开 Settings · TerminalPage 无需额外 getTerminalConfig 往返即可填充编辑态。
        label: 'config.terminalConfig',
        run: () => {
          const r = configService.getTerminalConfig()
          this.send(ws, { type: 'config.terminalConfig', id: this.nextPushId(), payload: { config: r.config, corrupted: r.corrupted } })
        },
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
      {
        // step 14: 挂起的 extension UI 请求（审批/ask-user/select/input/editor）—— P3 D3。
        // 【R1-C1】独立 type extension.pendingRequestsBatch（非 extension.pendingRequests reply 形态）。
        // 数据源 = ExtensionTimeoutManager.getAllPendingRequests（跨 session 聚合，与 getPendingRequests
        // RPC 同源 pendingRequests Map）。点对点 send（随 initial state 发给新连接），不打 seq、不入 buffer
        // （与现有 13 段一致）。冷启动/长断线/页面 reload 场景补发审批挂起请求唤醒 pi。
        // 短断线由 P2 ring buffer 回放覆盖（extension.ui_request 是广播，天然入 buffer）；
        // 冷启动时序竞争（AppShell 未挂载）由 onConnected 后 getPendingRequests 兜底（D4 双通路）。
        // requests 为空时推空数组（保持段顺序确定性，前端 handler no-op）。
        label: 'extension.pendingRequestsBatch',
        run: () => {
          const requests = this.services.extensionTimeoutMgr.getAllPendingRequests()
          this.send(ws, { type: 'extension.pendingRequestsBatch', id: this.nextPushId(), payload: { requests } })
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
