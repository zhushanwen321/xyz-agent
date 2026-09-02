/**
 * SessionService — Facade(门面)。
 *
 * 组合 lifecycle/dispatcher/scanner 三子模块,实现 ISessionService(对外)与三窄接口
 * ILifecycleSessionOps/IDispatcherSessionOps/IScannerSessionOps(对内,按消费者收窄——
 * 见 session-internal.ts;单一实现即编译期防签名漂移守卫)。
 *
 * sessions Map 所有权在 SessionLifecycle(S3 写点归位,设计 D2②:Map 连同写点 3 处
 * registerSession.set/removeEntry.delete/clear 迁入 lifecycle);本 Facade 残余域的
 * Map 读点统一经 lifecycle 的 ISessionRegistry 只读查询面(get/has/keys/values),
 * 对外查询方法退化为一行委托。写/删操作(removeSessionEntry 级)不经 Registry,由
 * Facade 委托 lifecycle(Map 所有者)。
 *
 * 共享 helper(toSummary/findScannedSession)留 Facade,子模块经各自窄接口调用 ——
 * 打断模块环(子模块 → 窄接口 → Facade implements,单向)。launch 参数组装四方法
 * (getSkillPaths/getExtensionPaths/getReplaceSystemPrompt/getLaunchPresetOptions)S6 迁出
 * launch-params.ts 纯函数族,本 Facade 保留一行委托(窄接口声明不变)。
 * onSessionRegistered 订阅接线在构造器(组装根):S5/S6 后订阅者是 projection/records
 * 域模块自身(设计 D2③「换订阅者」),Facade 仅保留 reconciler 对账订阅;按迁移前
 * initializeManagedSession 体内顺序执行(播种 → record 注册 → reconciler)。
 *
 * onSessionExit 回调留构造函数:协调 lifecycle/scanner/broker 多方,不归属任一子模块。
 */
import { existsSync } from 'node:fs'
import type { SessionSummary, SessionGroup, SessionStatus, Message, ServerMessage, ServerMessageMap, SubagentRecord, WorkflowRunRecord, BatchDeleteResult, SegmentsMetadataEntry, ProviderId } from '@xyz-agent/shared'
import type { SubagentEngineConfigView } from '@xyz-agent/extension-protocol'
import type {
  ISessionService, IMessageBroker, SessionCreateOptions,
  IEventAdapter, IExtensionService, IConfigService,
} from '../../interfaces.js'
import type { ILifecycleSessionOps, IDispatcherSessionOps, IScannerSessionOps, ISessionRegisterDeps, IManagedSessionRecord } from './session-internal.js'
import type { IProcessManager, IPiEngine, PiCommandInfo } from '../ports/pi-engine.js'
import { TraceSync } from './trace-sync.js'
import type { SessionTraceSnapshot } from './trace-sync.js'
import { SessionRecords } from './session-records.js'
import { SessionModelControl } from './session-model-control.js'
import { SessionHistoryReader } from './history-rebuild-cache.js'
import { resolveSkillPaths, resolveExtensionPaths, resolveReplaceSystemPrompt, resolveLaunchPresetOptions } from './launch-params.js'
import type { IConfigStore } from '../ports/config.js'
import type { ISessionStore, SessionOutcome } from '../ports/session.js'
import type { IGitInfoReader } from '../ports/git-info.js'
import type { IManagedSessionView, ScannedSession, SendMessageHook } from './types.js'
import type { WorkspaceService } from '../workspace/workspace-service.js'
import { SessionLifecycle } from './session-lifecycle.js'
import { MessageDispatcher } from './message-dispatcher.js'
import { SessionScanner } from './session-scanner.js'
import { AttachmentStore } from './attachment-store.js'
import { SessionStateProjection, type SessionReplicatedStates } from './session-state-projection.js'
import { detectBareWorkspaceCached } from '../worktree/workspace-detector.js'
import { PresetService, type PresetResolution } from '../preset-service.js'
// MessageBus（wave:runtime-wiring）：per-session 消息广播核心。setter 注入（同 setConfigService 模式），
// 未注入时所有 bus 调用 no-op（this.messageBus?.publish）。type-only import 避免运行时环
//（MessageBus 不反向依赖 SessionService）。
import type { IMessageBus } from '../message-bus/message-bus.js'

/** Facade 内部完整 session:Registry 记录(adapter 句柄)+ binding 扩展字段(hydrateBindingMeta 动态 patch)。 */
interface ManagedSession extends IManagedSessionRecord {
  adapter: IEventAdapter
  /**
   * launch preset id 的内存态持有（W-RT-4，设计文档 §4.2）。
   *
   * session 活跃期间 .preset.json sidecar 可能因 pi 延迟写入未 flush 而无法写入
   *（persistPresetBinding 的 existsSync 守卫跳过），此时内存态兜底持有 presetId，
   * 供 forkSession 在 active 期读源 session preset（W-RT-5）。
   *
   * 不放 IManagedSessionView（types.ts 非 slice 范围）也不入 IManagedSessionRecord
   * （binding 扩展字段归 Facade 域）：session-lifecycle 经 Registry get(id) 拿到
   * 记录后，as 转换读写此字段（patch 模式，见 lifecycle W-RT-4/5 实现注释）。
   * toSummary 一并透传到 SessionSummary.launchPresetId。
   */
  launchPresetId?: string
  /**
   * 归属 project id 的内存态持有（D14 语义修正，2026-08-04）。
   *
   * 与 launchPresetId 同模式：.project.json sidecar 可能因 pi 延迟写入未 flush 而无法写入
   *（persistProjectBinding 的 existsSync 守卫跳过），内存态兑底持有 projectId，
   * 供 forkSession 继承 / toSummary 透传 / setProject 同步。
   */
  projectId?: string
  /**
   * agent-managed session 标记的内存态持有（B-2）。
   *
   * 与 launchPresetId/projectId 同模式：.agent.json sidecar 可能因 pi 延迟写入未 flush
   * 而无法写入（persistAgentBinding 的 existsSync 守卫跳过），内存态兑底持有，
   * 供 session-manager list 按 spawnSource 过滤 / toSummary 透传（前端 AI badge）。
   */
  spawnSource?: 'user' | 'agent'
  /** agent-managed session 的父 session id（内存态持有，语义同上 spawnSource） */
  parentAgentSessionId?: string
}

export class SessionService implements ISessionService, ILifecycleSessionOps, IDispatcherSessionOps, IScannerSessionOps {
  private readonly restoringSessions = new Set<string>()
  private readonly lifecycle: SessionLifecycle
  private readonly dispatcher: MessageDispatcher
  private readonly scanner: SessionScanner
  /** 附件存储域（S1 迁出，零耦合子模块——无 Facade 状态依赖，故不注入 this） */
  private readonly attachmentStore = new AttachmentStore()
  /**
   * 状态投影域（S5 迁出至 session-state-projection.ts）：replicated states 快照投影族 +
   * context/usage 副作用域。onSessionRegistered 订阅者 = projection 自身（构造器组装期
   * 先于本 Facade 剩余订阅体注册，播种顺序与迁移前逐一等价）；销毁经 onSessionDisposed
   * 由 removeSessionEntry 第 ⑤ 步直调。
   */
  private readonly projection: SessionStateProjection
  /** trace/system-prompt 同步域（S4 迁出，构造器内组装 deps——见构造器注释） */
  private readonly traceSync: TraceSync
  /**
   * 模型/思考等级控制域（S6 迁出至 session-model-control.ts）：switchModel /
   * setThinkingLevel 的 RPC + 回执普查 + 实例失效 + 直写双投影。销毁无域状态（不持
   * per-session Map），无 onSessionDisposed。
   */
  private readonly modelControl: SessionModelControl
  /**
   * ConfigService 引用（组合根注入）。getReplaceSystemPrompt 委托用——
   * spawn pi 时透传用户配置的替换系统提示词。经 setter 注入而非构造参数，与
   * setModelContextWindowResolver 同模式，避免破坏 SessionService 的 18+ 测试调用点。
   * 未注入时 getReplaceSystemPrompt 返回 undefined（pi 走默认系统提示词）。
   */
  private configService: IConfigService | null = null
  /**
   * PresetService 引用（组合根注入）。getLaunchPresetOptions 委托用——
   * spawn pi 时按用户选定的 launch preset 构建 extension/skill/tool args。
   * 经 setter 注入（同 setConfigService 模式），未注入时 getLaunchPresetOptions
   * 返回 undefined（调用方 session-lifecycle fallback 到现有 getExtensionPaths/getSkillPaths）。
   * 见 pi-launch-presets 设计文档 §8.1。
   */
  private presetService: PresetService | null = null
  /**
   * U6：能力对账回调（组合根绑 modelService.reconcileModelCapabilities，附着路径调用）。
   */
  private modelCapabilityReconciler: ((sessionId: string) => Promise<unknown>) | null = null

  /**
   * W5：message.complete 广播回调（组合根注入 ReloadOrchestrator.onMessageComplete）。
   * 经 setter 注入（同 setConfigService 模式），避免构造参数环
   * （orchestrator 依赖 sessionService，sessionService 不能反向依赖 orchestrator 具体类型）。
   * 未注入时 message.complete 广播无额外副作用（reload 编排不生效）。
   */
  private onMessageComplete: ((sessionId: string) => void) | null = null
  /**
   * R3：session 删除回调（组合根注入 ReloadOrchestrator.clearPending）。
   * 主动 delete（lifecycle.delete）和进程异常退出（onSessionExit）均经 removeSessionEntry
   * 汇聚触发，清掉 pendingReload 残留（running session 入队后被删，永不发 message.complete）。
   */
  private onSessionDelete: ((sessionId: string) => void) | null = null
  /**
   * S3-W2：session 创建回调（PluginService 注入——session 事件注册表定向投递）。
   * 全部创建入口（lifecycle create/restoreSession/forkSession）经
   * notifySessionCreated 收敛触发。回调异常不外抛（创建主流程优先）。
   */
  private onSessionCreated: ((summary: SessionSummary) => void) | null = null
  /**
   * S3-W2：session 销毁回调（同上）。全部删除路径汇聚于 removeSessionEntry
   * （lifecycle.delete 主动删 / onSessionExit 进程退出 / restore 清场），触发点在彼处。
   *
   * D6a（integrity-hardening §3.6）：升级为回调列表。该槽原是单函数槽且已被
   * PluginService（didDestroy 投递）占用，挂起 UI 请求清理（server 的
   * extensionTimeoutMgr 汇聚清理）无处可挂——单槽语义下后注册者会覆盖前者。
   * 列表语义允许多方注册，既有注入方（PluginService）行为不变，逐个隔离异常。
   */
  private readonly onSessionDestroyedHandlers: Array<(summary: SessionSummary) => void> = []
  /**
   * MessageBus 引用（组合根注入，wave:runtime-wiring）。
   *
   * session 级消息（带 sessionId payload）单通道走 bus.publish（per-session 单调 seq +
   * ring buffer + 订阅者广播；wave:perf-w09 D1-2 删双写后唯一通道），全局消息（无 sessionId）
   * 仍走 broker.broadcast 盲广播。session 销毁时调 bus.clearSession 彻底清理
   * （removeSessionEntry 触发，所有删除路径汇聚处）。
   *
   * 经 setter 注入（同 setConfigService/setPresetService/setOnMessageComplete 模式），
   * 避免破坏 SessionService 的 25+ 测试构造调用点。未注入时所有 bus 调用 no-op（this.messageBus?.*）。
   */
  private messageBus: IMessageBus | null = null
  /**
   * history 读编排域（S6 迁出至 history-rebuild-cache.ts）：getHistory 三分支重建
   * （缓存增量/RPC 全量/尾读降级）+ getFullHistory 文件直读 + inflight 合并。销毁经
   * onSessionDisposed 由 removeSessionEntry 第 ⑤ 步直调（与 traceSync/projection/records
   * 并列）。
   */
  private readonly historyReader: SessionHistoryReader
  /**
   * subagent/workflow 记录域（S6/D2③ 迁出至 session-records.ts）：W18 派生缓存族 +
   * 磁盘读侧/动作/引擎配置。onSessionRegistered 订阅者 = records 自身（构造器组装期
   * 注册顺序在 projection 之后、reconciler 之前——播种 → record 注册 → 对账，与迁移前
   * Facade 订阅体内顺序逐一等价）；销毁经 onSessionDisposed 由 removeSessionEntry
   * 第 ⑤ 步直调（与 traceSync/projection 并列）。
   */
  private readonly records: SessionRecords
  constructor(
    private readonly pm: IProcessManager,
    private readonly broker: IMessageBroker,
    private readonly adapterFactory: (sessionId: string, send: (msg: ServerMessage) => void, cwd?: string) => IEventAdapter,
    private readonly projectRoot: string,
    private readonly extensionService: IExtensionService,
    private readonly configStore: IConfigStore,
    private readonly sessionStore: ISessionStore,
    private readonly gitInfoReader: IGitInfoReader,
    private readonly workspaceService: WorkspaceService,
    messageBus?: IMessageBus,
  ) {
    // 子模块注入 this(Facade 半构造时仅存引用,其方法在 Facade 完全构造后才被调用)。
    // registerDeps(S3/D2②):registerSession 装配依赖窄注入——send 闭包对晚期注入状态
    // (messageBus/onMessageComplete)经 getter 每次调用动态读,与原 Facade 内联闭包捕获
    // this 的语义逐字等价。
    const registerDeps: ISessionRegisterDeps = {
      adapterFactory: this.adapterFactory,
      getMessageBus: () => this.messageBus,
      broadcastGlobal: (msg) => this.broker.broadcast(msg),
      notifyMessageComplete: (sessionId) => this.onMessageComplete?.(sessionId),
    }
    this.lifecycle = new SessionLifecycle(this, this.pm, this.configStore, this.sessionStore, this.workspaceService, registerDeps)
    // trace/system-prompt 同步域（S4 迁出至 trace-sync.ts）：deps 窄注入——session 查询经
    // lifecycle（Map 所有者）只读面，messageBus 经 getter 每次调用动态读（setter 晚期注入
    // 语义与原 Facade 字段直读逐字等价，未注入时广播 no-op）。
    this.traceSync = new TraceSync({
      pm: this.pm,
      sessionStore: this.sessionStore,
      getSession: (sessionId) => this.lifecycle.get(sessionId),
      getMessageBus: () => this.messageBus,
    })
    // 模型控制域（S6 迁出至 session-model-control.ts）：deps 窄注入——session 定位经
    // lifecycle 只读面、实例失效经 projection、trace 补拉经 traceSync（全部既有公有面）。
    this.modelControl = new SessionModelControl({
      pm: this.pm,
      getSession: (sessionId) => this.lifecycle.get(sessionId),
      getReplicatedStates: (sessionId) => this.projection.getReplicatedStates(sessionId),
      syncTraceEntries: (sessionId, trigger) => this.traceSync.syncTraceEntries(sessionId, trigger),
    })
    // history 读编排域（S6 迁出至 history-rebuild-cache.ts）：deps 窄注入——pm（活跃判定
    // + RPC client）与 sessionStore（重建/尾读/全量文件读转换链），无私有状态耦合。
    this.historyReader = new SessionHistoryReader({
      pm: this.pm,
      sessionStore: this.sessionStore,
    })
    // 状态投影域（S5 迁出至 session-state-projection.ts）：deps 窄注入——session 查询经
    // lifecycle（Map 所有者）只读面，messageBus 经 getter 每次调用动态读（setter 晚期注入
    // 语义与原 Facade 字段直读逐字等价）；fetchContext / persistSessionOutcome /
    // tryPersistProjectBinding 留 Facade（ISessionService 契约 / dispatcher 窄接口单一实现 /
    // 私有 helper），经回调闭包注入（registerDeps 同款模式）。
    this.projection = new SessionStateProjection({
      pm: this.pm,
      getSession: (sessionId) => this.lifecycle.get(sessionId),
      hasSession: (sessionId) => this.lifecycle.has(sessionId),
      getMessageBus: () => this.messageBus,
      fetchContext: (sessionId) => this.fetchContext(sessionId),
      persistSessionOutcome: (sessionId, outcome, reason) => this.persistSessionOutcome(sessionId, outcome, reason),
      tryPersistProjectBinding: (session) => this.tryPersistProjectBinding(session),
    })
    // subagent/workflow 记录域（S6 迁出至 session-records.ts）：deps 窄注入——session 存在性
    // 经 lifecycle（Map 所有者）只读面，messageBus 经 getter 每次调用动态读（setter 晚期注入
    // 语义与原 Facade 字段直读逐字等价）；extensionService 路径解析经回调闭包注入
    // （registerDeps 同款模式，readDeclaredEnginesFallback 的安装目录定位用）。
    this.records = new SessionRecords({
      pm: this.pm,
      sessionStore: this.sessionStore,
      hasSession: (sessionId) => this.lifecycle.has(sessionId),
      getMessageBus: () => this.messageBus,
      getExtensionPaths: () => this.extensionService.getExtensionPaths(),
    })
    // 创建侧订阅接线(组装根,S3 seam→S5/S6 换订阅者,设计 D2②):onSessionRegistered 同步直发按
    // 订阅顺序执行——projection 先订阅(W7 播种,registerReplicatedStates)→ records 订阅
    // (ensureRecordEntriesCache(W18))→ reconciler 对账(U6,fire-and-forget .catch 降级——现状
    // 如此)。订阅扇出不设异常隔离、异常直接传播(与迁移前 Facade 订阅体内顺序调用等价)。
    this.projection.subscribe(this.lifecycle)
    this.records.subscribe(this.lifecycle)
    this.lifecycle.onSessionRegistered((sessionId) => {
      // U6（D2②）：session 附着触发能力对账（getAvailableModels vs 配置聚合，drift 经
      // setCapabilityDriftSink 上报 + runtime 日志）。一次调用，fire-and-forget——对账是
      // 纯旁路诊断，失败绝不阻断附着（内部已降级，catch 双保险）。
      if (this.modelCapabilityReconciler) {
        this.modelCapabilityReconciler(sessionId).catch(() => { /* 降级吞错：附着主链路优先 */ })
      }
    })
    this.dispatcher = new MessageDispatcher(this, this.pm, this.workspaceService, messageBus)
    this.scanner = new SessionScanner(this, this.sessionStore, this.gitInfoReader)

    // 进程崩溃清理:协调 adapter detach / Map 删 / 列表刷新 / session.exited 广播
    this.pm.onSessionExit((sessionId, code, stderr) => {
      const session = this.lifecycle.get(sessionId)
      if (!session) return
      session.adapter.detach()

      // 构建人类可读的退出原因（含 stderr 尾部，诊断价值 > 敏感性风险，本地工具场景）
      const reason = stderr
        ? `Session process exited (code: ${code})\n\n${stderr}`
        : `Session process exited (code: ${code})`

      // wave:perf-w07（D1-1）：session.exited 补 bus publish（stream 类：分配 seq 入 ring）。
      // 顺序约束：必须在 removeSessionEntry 之前——它内部调 bus.clearSession 清订阅者集合，
      // clearSession 之后再 publish 等于送空集合，订阅 renderer 一条也收不到（进程退出标记
      // dead + toast 丢失）。wave:perf-w09（D1-2）：broadcast 腿已删，publish 是唯一通道
      //（renderer 全量订阅覆盖 list 内全部 session，见 useSessionStreamSync）。
      const exitedMsg: ServerMessage = { type: 'session.exited', payload: { sessionId, code, reason } }
      this.messageBus?.publish(sessionId, exitedMsg)

      // 注意：此处 session 是 delete 前缓存的引用，removeSessionEntry 后 Map 条目已删除
      // 统一经 removeSessionEntry（触发 onSessionDelete 清 pendingReload 等残留）
      this.removeSessionEntry(sessionId)

      // W4：进程异常退出写 stopped 终态（在 Map 条目删除后，直接用已取的 session 对象，
      // 不走 persistSessionOutcome 的内部 get——删除后 get 返回 undefined）
      if (session.sessionFilePath) {
        // W2-5/W8：已有任意终态（done/error/stopped）则不覆盖。
        // 正常 turn 完成时 handleTurnEndSideEffects 已写 'done'；随后 pi 进程正常退出触发本回调，
        // 此处若再写 'stopped' 会覆盖已写入的 'done'。进程退出是正常结束的副作用，非用户中止。
        // W8：abort 路径 dispatcher 已写 'stopped' + 原始 abort reason，随后进程退出触发本回调时，
        // 若再次用「Process exited (code: N)」覆盖，会丢失 dispatcher 写入的原始 abort reason——
        // 第一个终态优先（abort 是用户主动行为，reason 比 process exit 更具诊断价值）。
        const existingOutcome = this.sessionStore.extractSessionOutcome(session.sessionFilePath)
        if (existingOutcome !== 'done' && existingOutcome !== 'error' && existingOutcome !== 'stopped') {
          this.sessionStore.persistSessionEnd(
            session.sessionFilePath,
            'stopped',
            `Process exited (code: ${code})`,
          )
        }
      }

      this.broker.broadcast({ type: 'config.sessions', payload: { groups: this.listPersistedSessions() } })
      // session.exited（独立事件，区别于 message.error 的「单次消息失败」语义）：
      // 前端据此标记 session dead 态 + 插入 error 消息 + toast 提示。
      //（wave:perf-w09：exitedMsg 的 broadcast 腿已删——session 级单通道，上方 publish 唯一出口。）
    })
  }

  /**
   * 注入 ConfigService（组合根在所有服务构造后调用）。
   * getReplaceSystemPrompt 委托用——spawn pi 时透传用户配置的替换系统提示词。
   */
  setConfigService(configService: IConfigService): void {
    this.configService = configService
  }

  /**
   * 注入 PresetService（组合根在所有服务构造后调用）。
   * getLaunchPresetOptions 委托用——spawn pi 时按 launch preset 构建 args。
   * 与 setConfigService 同模式（setter 注入，避免破坏现有测试构造点）。
   */
  setPresetService(presetService: PresetService): void {
    this.presetService = presetService
  }

  /** W5：注入 message.complete 回调（组合根绑 ReloadOrchestrator.onMessageComplete）。 */
  setOnMessageComplete(handler: (sessionId: string) => void): void {
    this.onMessageComplete = handler
  }

  /** R3：注入 session 删除回调（组合根绑 ReloadOrchestrator.clearPending）。 */
  setOnSessionDelete(handler: (sessionId: string) => void): void {
    this.onSessionDelete = handler
  }

  /** S3-W2：注入 session 创建回调（PluginService 绑 session 事件注册表投递）。 */
  setOnSessionCreated(handler: (summary: SessionSummary) => void): void {
    this.onSessionCreated = handler
  }

  /**
   * S3-W2：注入 session 销毁回调（触发点 removeSessionEntry）。
   * D6a：追加式注册（非覆盖）——回调列表语义，PluginService 的 didDestroy 投递与
   * transport 层的挂起 UI 请求清理（server.ts setServices 注册）互不挤占。
   */
  setOnSessionDestroyed(handler: (summary: SessionSummary) => void): void {
    this.onSessionDestroyedHandlers.push(handler)
  }

  /**
   * U6（D2② 在线对账）：注入能力对账回调（组合根绑 modelService.reconcileModelCapabilities）。
   * session 附着路径（registerSession 的 onSessionRegistered 订阅,S3 前为 initializeManagedSession
   * 体内调用）fire-and-forget 调用——失败不阻断附着（内部降级：引擎不可用 / RPC 失败一律
   * 返回空）。窄回调签名避免 SessionService 反向持有 ModelService 引用（modelService 依赖
   * sessionService，构造注入会成环）。
   */
  setModelCapabilityReconciler(reconciler: (sessionId: string) => Promise<unknown>): void {
    this.modelCapabilityReconciler = reconciler
  }

  /**
   * 注入 MessageBus 单例（组合根在所有服务构造后调用，wave:runtime-wiring）。
   *
   * session 级消息（带 sessionId payload）单通道走 bus.publish（wave:perf-w09 D1-2 删双写后
   * 唯一通道）；session 销毁时 removeSessionEntry 调 bus.clearSession。未注入时所有 bus 调用
   * no-op，与 setConfigService/setOnMessageComplete 同模式（nullable 注入，不破坏现有测试构造点）。
   *
   * bus 有两条注入通道：①构造参数（index.ts 构造 SessionService 时传入，经构造器传导给
   * dispatcher）；②本 setter（后置注入）。走 ② 时 dispatcher 已在构造器中创建（持有旧 bus
   * 或 undefined），故此处必须同步回填 dispatcher.setMessageBus——否则 dispatcher 的全部
   * session 级发布静默 no-op（null-safe 但消息丢失）。组合根两条通道都走（幂等：回填同一
   * 引用无副作用）。
   */
  setMessageBus(bus: IMessageBus): void {
    this.messageBus = bus
    this.dispatcher.setMessageBus(bus)
  }

  // ── ISessionService:纯委托(lifecycle / dispatcher / scanner)─────

  async create(cwd?: string, label?: string, options?: SessionCreateOptions): Promise<SessionSummary> { return this.lifecycle.create(cwd, label, options) }
  async delete(sessionId: string): Promise<void> { return this.lifecycle.delete(sessionId) }
  async deleteByCwd(cwd: string): Promise<BatchDeleteResult> { return this.lifecycle.deleteByCwd(cwd) }
  async renameSession(sessionId: string, newName: string): Promise<void> { return this.lifecycle.renameSession(sessionId, newName) }
  async restoreSession(sessionId: string): Promise<SessionSummary> { return this.lifecycle.restoreSession(sessionId) }
  async forkSession(
    srcSessionId: string,
    fromPiEntryId: string | undefined,
    includeFrom: boolean,
    label?: string,
    opts?: {
      fromMessageTimestamp?: number
      fromMessageRole?: string
      /** Staging Mode（ADR-0056）：composer 暂存的模型覆盖，优先于源 preset.modelOverride。 */
      modelOverride?: string
      /** Staging Mode（ADR-0056）：composer 暂存的思考等级覆盖，优先于源 preset.thinkingLevel。 */
      thinkingOverride?: string
    },
  ): Promise<SessionSummary> {
    // 编排半截（find 合并 + timestamp 解析）S6 迁入 lifecycle.forkSession（始与终同模块，
    // 失败模式 B 消除）；本委托透传原始参数，语义详见 session-lifecycle.ts。
    return this.lifecycle.forkSession(srcSessionId, fromPiEntryId, includeFrom, label, opts)
  }

  async sendMessage(sessionId: string, content: string, images?: Array<{ data: string; mimeType: string }>): Promise<{ blocked: boolean; rejected?: boolean }> { return this.dispatcher.sendMessage(sessionId, content, images) }
  // [HISTORICAL] sendSubagentMessage（marker 半成品通道）已删除（composer 四符号设计 D2）：
  // base64 隐藏注释前缀在 extension 侧零消费方，且经主 agent 转发违背
  // 「直达 subagent」目标——定向消息改走 subagentAction(message/start)。
  async abort(sessionId: string): Promise<void> { return this.dispatcher.abort(sessionId) }
  /** 强制退出卡死 session（sidebar 右键入口，杀 pi 进程 + stopped 收敛）。 */
  async forceQuit(sessionId: string): Promise<void> { return this.dispatcher.forceQuit(sessionId) }
  async sendBash(sessionId: string, command: string, excludeFromContext?: boolean): Promise<{ blocked: boolean; rejected?: boolean }> {
    return this.dispatcher.sendBash(sessionId, command, excludeFromContext)
  }
  async abortBash(sessionId: string): Promise<void> { return this.dispatcher.abortBash(sessionId) }
  /**
   * W1（fix-chat-flow-order 探针 ②）：run 级联结束（pi agent_settled，晚于 pi finally 的
   * bash 落盘 flush）→ dispatcher 按序发布 per-session bash 待落列（D2 双分支延迟的 flush 腿）。
   * 经 EventInterpreter.onAgentSettled 回调注入（组合根 index.ts）。
   */
  flushPendingBashResults(sessionId: string): void { this.dispatcher.flushPendingBashResults(sessionId) }
  async steerMessage(sessionId: string, content: string): Promise<void> { return this.dispatcher.steerMessage(sessionId, content) }
  async followUpMessage(sessionId: string, content: string): Promise<void> { return this.dispatcher.followUpMessage(sessionId, content) }
  async compact(sessionId: string, customInstructions?: string): Promise<void> { return this.dispatcher.compact(sessionId, customInstructions) }
  setSendMessageHook(hook: SendMessageHook): void { this.dispatcher.setSendMessageHook(hook) }
  listPersistedSessions(): SessionGroup[] { return this.scanner.listPersistedSessions() }

  // ── ISessionService:Facade 直接实现(查 sessions / 经 rpc,轻量)─────

  /** 切换模型（实现迁 session-model-control.ts：set RPC + 回执普查 + 三实例失效 + 直写）。 */
  async switchModel(sessionId: string, provider: ProviderId, modelId: string): Promise<string> { return this.modelControl.switchModel(sessionId, provider, modelId) }
  /** 设置思考档并返回 pi 生效值（实现迁 session-model-control.ts：钳制读回 + 直写）。 */
  async setThinkingLevel(sessionId: string, level: string): Promise<string> { return this.modelControl.setThinkingLevel(sessionId, level) }

  /**
   * 更新活跃 session 的 label（内存态）——session_info_changed 事件路径的唯一写方（PR #185 MF1）。
   *
   * 调用方：pi session_info_changed 事件到达时（pi extension auto-rename，经组合根
   * onSessionRenamed 回调）。另一写方 = renameSession 活跃分支（set_session_name RPC
   * 成功后直写 session.label，见 session-lifecycle.ts，两者写点同源 pi 权威）。
   * 不持久化——pi 侧已写 session_info，此处只同步内存态（toSummary/config.sessions
   * 的即时数据源）。label 的 ReplicatedState 实例已撤销（.get() 零消费、拉取纯浪费
   * RPC，见 SessionReplicatedStates 注释 [HISTORICAL] 段）。
   */
  setLabelCache(sessionId: string, label: string): void {
    const session = this.lifecycle.get(sessionId)
    if (session) session.label = label
  }

  hasActiveSession(sessionId: string): boolean { return this.pm.hasClient(sessionId) }

  /** 活跃 session id 列表（含公共 session，供 SkillRegistry 计算 skill 变更广播范围）。 */
  getActiveSessionIds(): string[] {
    return Array.from(this.lifecycle.keys())
  }

  /** 取 session cwd（未激活/不存在返回 undefined，供 SkillRegistry 按项目 skill 变更定位受影响 session）。 */
  getSessionCwd(sessionId: string): string | undefined {
    return this.lifecycle.get(sessionId)?.cwd
  }

  /**
   * 可能返回已死 client（exited=true），业务入口（prompt / subagent / auto-restore）
   * 应走 ensureActive（死 client 视同无 client 走 restore）；直接调用方需自行处理 exited
   * （handoff-service 等依赖裸 client 观察 exited，故本方法不改语义只标注契约）。
   */
  getRpcClient(sessionId: string): IPiEngine | undefined { return this.pm.getClient(sessionId) }

  /**
   * W7/W8：per-session 实例组访问器。消费方：
   * - 组合根（index.ts）：interpreter 的失效回调延迟解析（markDirty，thinkingLevel）；
   * - session-service 自身（W8）：usage / commands 失效接线（applyContextUpdate /
   *   getCommands）；
   * - 测试：断言 switchModel 后 modelId 实例 markDirty、事件路径写点后 usage/commands markDirty。
   * session 未注册（非活跃 / 已销毁）返回 undefined，调用方安全跳过。
   * 方法名沿用 W7 的 ScalarReplicatedStates 语义（index.ts 组合根接线稳定，四实例后为
   * 全量实例组访问器——结构收窄不破坏既有消费方）。
   */
  getScalarReplicatedStates(sessionId: string): SessionReplicatedStates | undefined {
    return this.projection.getReplicatedStates(sessionId)
  }

  // ── W18：record entry 派生缓存（S6 迁出至 session-records.ts；interpreter 经组合根
  // index.ts:406 经本委托到达——u-s5 同款形态）──

  /** W18：record entry 失效信号入口（实现迁 session-records.ts，防抖与 cursor 三路径详见该模块）。 */
  invalidateRecordEntries(sessionId: string, customType: string): void {
    return this.records.invalidateRecordEntries(sessionId, customType)
  }

  /** 确保会话活跃;不存在则自动 restore。并发 restore 时去重拒绝。 */
  async ensureActive(sessionId: string): Promise<IPiEngine> {
    const existing = this.pm.getClient(sessionId)
    // 纵深防御（pi-exit-notification-and-respawn §6.6）：上游清理（onSessionExit）出现竞态时
    // processes Map 可能残留已死 client——视同无 client 走下方 restoreSession（其内部对
    // existing sessions 条目已有 detach + safeDestroy + removeSessionEntry 清场），
    // 不把死 client 交给 prompt。
    if (existing && !existing.exited) return existing
    if (this.restoringSessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} is already being restored`)
    }
    this.restoringSessions.add(sessionId)
    try {
      console.log(`[session-service] ensureActive: restoring ${sessionId}...`)
      await this.restoreSession(sessionId)
      const client = this.pm.getClient(sessionId)
      if (!client) throw new Error('Restore succeeded but client not available')
      return client
    } finally {
      this.restoringSessions.delete(sessionId)
    }
  }

  // ── history 读编排域（S6 迁出至 history-rebuild-cache.ts；三分支重建/inflight 合并/尾读降级详见该模块）──

  /** 拉取 session 历史（缓存增量三分支重建，实现迁 history-rebuild-cache.ts）。 */
  async getHistory(sessionId: string): Promise<{ messages: Message[]; truncated: boolean }> { return this.historyReader.getHistory(sessionId) }
  /** 全量文件读取（「加载更多」fallback，实现迁 history-rebuild-cache.ts）。 */
  async getFullHistory(sessionId: string): Promise<Message[]> { return this.historyReader.getFullHistory(sessionId) }

  // ── subagent/workflow 记录域（S6 迁出至 session-records.ts；磁盘扫描/引擎配置/动作详见该模块）──

  /** subagent 列表（冷启动磁盘扫描，实现迁 session-records.ts）。 */
  async getSubagents(sessionId: string): Promise<SubagentRecord[]> { return this.records.getSubagents(sessionId) }
  /** subagent 对话流历史（record.sessionFile 直读 + 非 pi 引擎降级链，实现迁 session-records.ts）。 */
  async getSubagentHistory(sessionId: string, subagentId: string): Promise<Message[]> { return this.records.getSubagentHistory(sessionId, subagentId) }
  /** [U7] 引擎配置视图（engines.json + config.json，实现迁 session-records.ts）。 */
  async getSubagentEngineConfig(): Promise<SubagentEngineConfigView> { return this.records.getSubagentEngineConfig() }
  /** [U7] 设置默认引擎（带跨进程锁的 RMW + 原子写，实现迁 session-records.ts）。 */
  async setSubagentDefaultEngine(engineId: string): Promise<void> { return this.records.setSubagentDefaultEngine(engineId) }
  /** workflow 列表（冷启动磁盘扫描，实现迁 session-records.ts）。 */
  async getWorkflows(sessionId: string): Promise<WorkflowRunRecord[]> { return this.records.getWorkflows(sessionId) }

  /**
   * session-trace 台账全量拉取（RPC 混合路由 → 文件降级 → empty 空态）。
   * 实现在 trace-sync.ts（S4 迁出），路由与失败路径详见该模块。
   */
  async getTraceEntries(sessionId: string): Promise<SessionTraceSnapshot> {
    return this.traceSync.getTraceEntries(sessionId)
  }

  /**
   * session-trace 增量腿补拉（触发事件/lifecycle RPC 成功后 since 拉取 + 广播）。
   * 实现在 trace-sync.ts（S4 迁出）：无基线 no-op、串行链防 burst，详见该模块。
   */
  syncTraceEntries(sessionId: string, trigger: string): void {
    this.traceSync.syncTraceEntries(sessionId, trigger)
  }

  /**
   * 现取当前 system prompt（常驻扩展通道：prompt 命令 → 轮询 get_entries 命中 custom entry）。
   * 实现在 trace-sync.ts（S4 迁出），busy 预检与轮询时序详见该模块。
   */
  async fetchCurrentSystemPrompt(sessionId: string): Promise<ServerMessageMap['session.currentSystemPrompt']> {
    return this.traceSync.fetchCurrentSystemPrompt(sessionId)
  }

  /** agent call 对话流（agent call 本质是 subagent，record 查找路径详见 session-records.ts）。 */
  async getAgentCallHistory(sessionId: string, agentCallSessionId: string): Promise<Message[]> { return this.records.getAgentCallHistory(sessionId, agentCallSessionId) }
  /** agent call JSONL 路径（展示型，找不到返回空串；实现迁 session-records.ts）。 */
  async getAgentCallFilePath(sessionId: string, agentCallSessionId: string): Promise<string> { return this.records.getAgentCallFilePath(sessionId, agentCallSessionId) }
  /** workflow 生命周期操作（经扩展 slash command，实现迁 session-records.ts）。 */
  async workflowAction(sessionId: string, action: 'pause' | 'resume' | 'abort', runId: string): Promise<void> { return this.records.workflowAction(sessionId, action, runId) }
  /** subagent 生命周期/定向消息操作（encodeDirectiveText 编码，实现迁 session-records.ts）。 */
  async subagentAction(
    sessionId: string,
    action: 'cancel' | 'message' | 'start',
    params: { subagentId?: string; text?: string; slug?: string; task?: string },
  ): Promise<void> { return this.records.subagentAction(sessionId, action, params) }

  /**
   * W5：session 是否处于可 reload 的空闲态（进程存活且非生成中）。
   * 供 ReloadOrchestrator 判断 skill 变更时是立即 reload 还是排队。
   */
  isSessionIdle(sessionId: string): boolean {
    const session = this.lifecycle.get(sessionId)
    return !!session && !session.isGenerating
  }

  /**
   * W5：session 是否仍存活（sessions Map 含此 id，进程未退出 / 未被 delete）。
   * 供 ReloadOrchestrator 检测排队期 session 删除，避免对已死 session 发 reload。
   */
  hasSession(sessionId: string): boolean {
    return this.lifecycle.has(sessionId)
  }

  /**
   * W5：向 session 发 `/__xyz_reload__` 触发 pi reload（重扫 skill + 重建 runtime）。
   * 对称 workflowAction 的转发模式：直接 client.prompt 绕过 dispatcher busy 预检 / hook，
   * 专用于 internal reload action（builtin extension 注册，不经 LLM）。client 不存在或
   * prompt 抛错向上抛，由 ReloadOrchestrator 降级 catch（best-effort，不阻塞）。
   */
  async promptReload(sessionId: string): Promise<void> {
    const client = this.pm.getClient(sessionId)
    if (!client) throw new Error(`Session ${sessionId} not active`)
    await client.prompt('/__xyz_reload__')
  }

  /**
   * U3（composer 四符号 §3.3.5）：reload 完成后失效 commands 快照（slash 列表动态刷新
   * 链路闭合点）。失效点挂在这里的时机依据（设计 F8）：pi 对 extension 命令
   * `await _tryExecuteExtensionCommand`（agent-session.js:800），promptReload resolve 即
   * reload 已完成；而 `session_start(reason='reload')` 事件是 extension-only 不出 stdout
   * （agent-session.js:2072），runtime 侧不存在可订阅的 reload 完成事件。
   *
   * 事件只做失效（对齐 applyContextUpdate 范式）——markDirty 置 dirty + 防抖重拉
   * get_commands（commands 实例唯一数据写路径），重拉成功后经既有挂钩
   * fetchCommandsSnapshot 内的 publishCommandsSnapshot 自动广播 session.commands，
   * 本方法无需额外广播。
   */
  handleSessionReloaded(sessionId: string): void {
    this.projection.getReplicatedStates(sessionId)?.commands.markDirty()
  }

  getSummary(sessionId: string): SessionSummary | undefined {
    const session = this.lifecycle.get(sessionId)
    return session ? this.toSummary(session) : undefined
  }

  /**
   * W10：inputTokens 读点唯一化——usage 实例快照派生（fetch get_session_stats 写入的唯一
   * 数据源）。旧 session.inputTokens 缓存直写（applyContextUpdate / fetchContext 回写，
   * 及已删除的外部 setter）已删，sessions Map 内字段退化为恒 0 的派生基线（types 必填
   * 字段，读点全部走本方法）。
   */
  getInputTokens(sessionId: string): number {
    return this.projection.getReplicatedStates(sessionId)?.usage.get()?.inputTokens ?? 0
  }

  /**
   * 处理 context.update（事件只失效 usage 实例，发布归快照挂钩——语义注释随实现迁
   * session-state-projection.ts）。组合根 index.ts onContextUpdate 经本委托消费。
   */
  applyContextUpdate(sessionId: string, inputTokens: number, totalTokens?: number): void {
    this.projection.applyContextUpdate(sessionId, inputTokens, totalTokens)
  }

  /** turn_end 单 turn 副作用（project sidecar 兜底；语义注释随实现迁 session-state-projection.ts）。 */
  handleTurnUsageSideEffects(sessionId: string): void {
    this.projection.handleTurnUsageSideEffects(sessionId)
  }

  /** agent_end 副作用（isGenerating 复位 + sidecar 兜底 + session_end 终态；语义注释随实现迁 session-state-projection.ts）。 */
  handleTurnEndSideEffects(sessionId: string, stopReason?: string): void {
    this.projection.handleTurnEndSideEffects(sessionId, stopReason)
  }

  /**
   * 写 session_end 终态 entry（W4，ADR 0042）。
   * 3 个终态点复用：正常完成（handleTurnEndSideEffects）/ abort（message-dispatcher）/ 进程崩溃（onSessionExit）。
   * sessionFilePath 不存在时静默跳过（首 turn 前崩溃 / pi 延迟写入窗口）。
   */
  persistSessionOutcome(sessionId: string, outcome: SessionOutcome, reason?: string): void {
    const session = this.lifecycle.get(sessionId)
    if (!session?.sessionFilePath) return
    this.sessionStore.persistSessionEnd(session.sessionFilePath, outcome, reason)
  }

  /**
   * W10：取 session 当前 usagePercent——usage 实例快照派生（pi 权威 percent 投影）。
   * 旧实现按「缓存 inputTokens + resolver 窗口」本地重算（computeUsage），W10 起快照
   * 已持有 pi 侧按当前模型窗口算出的权威 percent，读点直接派生；dirty 期间返回上次
   * 快照（核心不变量 2 的 UI 语义）。
   */
  getUsagePercent(sessionId: string): number {
    return this.projection.getReplicatedStates(sessionId)?.usage.get()?.usagePercent ?? 0
  }

  async destroyAll(): Promise<void> {
    for (const session of this.lifecycle.values()) {
      session.adapter.detach()
    }
    await this.pm.destroyAll()
    // shutdown 路径：只清 sessions Map（Map 所有者执行），刻意不触发 dispose/销毁通知
    // ——进程将亡，缓存随进程同灭（迁移前行为保持，设计 D2②）。
    this.lifecycle.clear()
  }

  // ── 内部协议（lifecycle/dispatcher/scanner 窄接口 + 过渡宽接口）:子模块经此访问 sessions / 共享 helper ──

  /** 有效 skill 路径（实现迁 launch-params.ts：cwd resolve + existsSync 过滤 + expandHome）。 */
  getSkillPaths(cwd: string): string[] { return resolveSkillPaths(this.configStore, cwd) }
  /** 有效 extension 路径（实现迁 launch-params.ts：断链 fail-fast + 其余降级空列表）。 */
  async getExtensionPaths(cwd?: string): Promise<string[]> { return resolveExtensionPaths(this.extensionService, cwd) }
  /** 替换系统提示词（实现迁 launch-params.ts；未注入 ConfigService 时 undefined）。 */
  getReplaceSystemPrompt(): string | undefined { return resolveReplaceSystemPrompt(this.configService) }
  /** launch preset 解析（实现迁 launch-params.ts：builtin:full fallback 语义详见该模块）。 */
  async getLaunchPresetOptions(presetId: string, cwd: string): Promise<PresetResolution | undefined> { return resolveLaunchPresetOptions(this.presetService, presetId, cwd) }

  findScannedSession(sessionId: string): ScannedSession | undefined {
    // wave:perf-w26（D9-1 消费方分层，plan M-3）：本方法的全部消费方（rename/delete/restore/
    // fork 的源文件解析、setProject 的 sidecar 写入）都是单 session 路径解析——统一 force
    // 旁路 TTL，刚落盘 session 在窗口内也能解析到。
    return this.sessionStore.scanSessions({ force: true }).find(s => s.id === sessionId)
  }

  /**
   * 手动归类（D14 语义修正，2026-08-04）：写 session 归属 project 到 `.project.json` sidecar。
   *
   * active session 同步内存态（toSummary 从内存透传，广播后 summary 立即携带新归属）；
   * 磁盘 session 经扫描拿 filePath 写 sidecar（scanner 下次扫描读到）。
   * 空 projectId = 归回默认项目（等价删除绑定，persistProjectBinding 空值守卫跳过）。
   * session 不存在/文件未落盘（延迟写入窗口）→ 静默跳过（不阻断归类流程，下次 create 兑底）。
   */
  async setProject(sessionId: string, projectId: string): Promise<void> {
    const active = this.lifecycle.get(sessionId) as (IManagedSessionView & { projectId?: string }) | undefined
    if (active) {
      active.projectId = projectId || undefined
      if (active.sessionFilePath) {
        this.sessionStore.persistProjectBinding(active.sessionFilePath, projectId)
      }
      return
    }
    const scanned = this.findScannedSession(sessionId)
    if (scanned?.filePath) {
      this.sessionStore.persistProjectBinding(scanned.filePath, projectId)
    }
  }

  toSummary(s: IManagedSessionView): SessionSummary {
    const git = this.gitInfoReader.readGitInfo(s.cwd)
    return {
      id: s.id, label: s.label, cwd: s.cwd,
      gitBranch: git?.branch, gitIsWorktree: git?.isWorktree,
      // R1：复用 WorkspaceDetector 检测 .bare workspace（带缓存），填 isBareWorkspace
      // 供前端 Landing.vue 派生「新建 worktree」动作项显隐。
      isBareWorkspace: detectBareWorkspaceCached(s.cwd),
      status: s.isGenerating ? ('active' as SessionStatus) : ('idle' as SessionStatus),
      lastActiveAt: s.lastActiveAt, modelId: s.modelId,
      thinkingLevel: s.thinkingLevel,
      // W10：tokenCount 派生自 usage 实例快照（context 占用口径——事件链路三条路径的
      // totalTokens 与 inputTokens 同值直出，快照 inputTokens 保持同语义）。旧
      // session.tokenCount 直写（applyContextUpdate）已删，字段退化为恒 0 派生基线
      // （types 必填）；磁盘 session（非 active）无实例，fallback 字段值。
      tokenCount: this.projection.getReplicatedStates(s.id)?.usage.get()?.inputTokens ?? s.tokenCount,
      hidden: s.hidden,
      parentSession: s.parentSession,
      forkEntryId: s.forkEntryId,
      handedOffTo: s.handedOffTo,
      sessionFile: s.sessionFilePath,
      // W-RT-4/§4.2：active session 的 launchPresetId 透传到 summary（内存态与 sidecar 并列）。
      // ManagedSession 实例携带此字段；普通 IManagedSessionView 无此字段时为 undefined（安全）。
      launchPresetId: (s as ManagedSession).launchPresetId,
      // D14 语义修正：归属 project 透传到 summary（内存态兑底，sidecar 扫描路径在 scanner）。
      projectId: (s as ManagedSession).projectId,
      // B-2：agent-managed 标记透传——list 按 spawnSource/parentAgentSessionId 过滤时
      // active session 走本路径（scanned 路径被 activeFilePaths 排除），漏透传 = 过滤失效。
      spawnSource: (s as ManagedSession).spawnSource,
      parentAgentSessionId: (s as ManagedSession).parentAgentSessionId,
    }
  }

  getSession(sessionId: string): IManagedSessionView | undefined { return this.lifecycle.get(sessionId) }

  /**
   * M3：标记源 session 已交接给新 session。
   *
   * 把 handedOffTo 的写入（内存 + 磁盘 handoff_marker）收归 SessionService（拥有 sessions Map
   * 与 sessionFilePath），避免 handoff-service 直接改内部对象（srcSession.handedOffTo = newId）
   * 绕过所有权——getSession 未来若返回防御性副本会让外部直接写入静默失效。
   *
   * 仅处理 active session（sessions Map 命中）：内存写 handedOffTo（toSummary 透传到
   * SessionSummary，活跃态立即生效不等 scanner 重扫）+ 磁盘写 handoff_marker（scanner
   * 读后填 SessionSummary.handedOffTo，前端跳转/标记用）。
   *
   * handoff 编排保证源 session 在交接时仍 active（由前端触发跳转前 pi turn 已结束、进程未退出），
   * 故非 active 路径（已被删 / 纯 RPC）按 no-op 处理。若未来需支持非 active 源 session 交接，
   * 此处应通过 findScannedSession(srcSessionId)?.filePath 解析路径后补写磁盘。
   */
  markHandedOff(srcSessionId: string, newSessionId: string): void {
    const session = this.lifecycle.get(srcSessionId)
    if (session) {
      session.handedOffTo = newSessionId
    }
    if (session?.sessionFilePath) {
      this.sessionStore.persistHandoffSidecar(session.sessionFilePath, newSessionId)
    }
  }
  /**
   * S3-W2：session 创建通知（lifecycle 全部创建入口收敛点：create / restoreSession /
   * forkSession 三处 spawn 路径的 return 前调用）。触发 onSessionCreated →
   * PluginService session 事件注册表定向投递插件 didCreate。回调异常不外抛。
   */
  notifySessionCreated(summary: SessionSummary): void {
    try {
      this.onSessionCreated?.(summary)
      // catch 内有 console.error（非 silent catch），无需 no-silent-catch 豁免。
    } catch (e: unknown) {
      // 降级策略（best-effort）：插件回调异常不阻断创建主流程，仅落日志供排查
      console.error(`[session-service] onSessionCreated listener error (sessionId=${summary.id}):`, e)
    }
  }

  removeSessionEntry(sessionId: string): void {
    // S3-W2：删除前缓存 summary（插件 didDestroy 通知需要 SessionInfo；删除后 Map 查不到）。
    // Map 无条目（防御路径）时构造最小形状——id 之外的字段无从得知，宁发少知不发错。
    const session = this.lifecycle.get(sessionId)
    const destroyedSummary: SessionSummary = session
      ? this.toSummary(session)
      : { id: sessionId, label: sessionId, cwd: '', status: 'dead', lastActiveAt: 0, modelId: '', tokenCount: 0 }
    // 销毁 9 步的第 ② 步（设计 D2②）：委托 lifecycle 删 Map 条目——所有者执行，纯删除
    // 不发事件（其余步骤编排权留本 wrapper，体内顺序 = 迁移前行为等价的一部分）。
    this.lifecycle.removeEntry(sessionId)
    // R3：所有删除路径（lifecycle.delete 主动删 + onSessionExit 进程异常退）汇聚于此，
    // 触发 onSessionDelete 清 ReloadOrchestrator.pendingReload 残留。
    this.onSessionDelete?.(sessionId)
    // S3-W2 + D6a：同一汇聚点触发回调列表（插件 didDestroy 投递 + 挂起 UI 请求清理等）。
    // 逐个 try/catch 隔离：单 handler 异常不阻塞删除主流程，也不阻断列表内其余 handler。
    for (const handler of this.onSessionDestroyedHandlers) {
      try {
        handler(destroyedSummary)
      // eslint-disable-next-line taste/no-silent-catch -- best-effort 降级：销毁回调异常不外抛（删除主流程优先），仅落日志供排查
      } catch (e: unknown) {
        console.error(`[session-service] onSessionDestroyed listener error (sessionId=${sessionId}):`, e)
      }
    }
    // wave:perf-w20（D6-1）：session 删除 / pi 进程退出时清历史重建缓存 + lastLeafId。
    // pi 进程退出后缓存基线（lastLeafId）不再与新进程的 entry 集合对应，保留只会
    // 走 "Entry not found" fallback（防御兜底存在，但清理是正路径）。S6 起清理随域迁入
    // historyReader（onSessionDisposed 直调形态，traceSync/projection/records 同款）。
    this.historyReader.onSessionDisposed(sessionId)
    // session-trace（A33）：同汇聚点清 trace 增量腿基线与串行链（与 historyCache 同因——
    // 基线跨进程存活无意义；链已 settled，删 Map 条目只释放槽位）。S4：清理随域迁入
    // TraceSync（各域 onSessionDisposed 直调形态）。
    this.traceSync.onSessionDisposed(sessionId)
    // W7/W8 + W12：销毁 per-session 实例组与 state_changed diff 基线（与 historyCache.delete
    // 同汇聚点——主动删 + 进程退出）。dispose 停防抖/退避/周期兜底全部定时器。S5 起清理
    // 随域迁入 projection（onSessionDisposed 直调形态，traceSync 同款）。
    this.projection.onSessionDisposed(sessionId)
    // W18：销毁 record entry 派生缓存（同汇聚点）。停防抖定时器（在途 inflight 的拉取
    // 完成后 applyRecordEntries 的 hasSession 守卫拦住发布，不复活已清 bus 条目）。S6 起
    // 清理随域迁入 records（onSessionDisposed 直调形态，traceSync/projection 同款）。
    this.records.onSessionDisposed(sessionId)
    // wave:runtime-wiring（GAP1 决策）：session 销毁时清理 MessageBus 的该 session 状态
    // （ring buffer + state snapshot + 订阅者集合 + 反查表）。幂等（ES1：session 不存在 no-op）。
    // 不在 pi flush / turn 结束时清理——ring 容量 1000 会自然 FIFO 淘汰旧 turn delta，
    // turn 边界清理是阶段 2 的精细化策略（届时评估）。
    this.messageBus?.clearSession(sessionId)
  }

  getSessionByClient(client: IPiEngine): IManagedSessionView | undefined {
    const id = this.pm.getSessionIdByClient(client)
    return id ? this.lifecycle.get(id) : undefined
  }

  detachSession(sessionId: string): void {
    const session = this.lifecycle.get(sessionId)
    if (!session) return
    session.adapter.detach()
  }

  getActiveSummaries(): SessionSummary[] {
    return Array.from(this.lifecycle.values()).map(s => this.toSummary(s))
  }

  getActiveFilePaths(): Set<string> {
    const filePaths = new Set<string>()
    for (const s of this.lifecycle.values()) {
      if (s.sessionFilePath) filePaths.add(s.sessionFilePath)
    }
    return filePaths
  }

  /**
   * 初始化 ManagedSession（S3/D2② 迁入 lifecycle.registerSession 后的兼容委托——
   * 生产注册路径 = lifecycle create/restore/fork 内部直调 this.registerSession；
   * 本方法保留给测试/历史调用点，行为与迁移前等价：session 构造 + sessions Map 写入 +
   * onSessionRegistered 同步直发（订阅者 = 本 Facade 构造器接线的各域注册）。
   */
  async initializeManagedSession(
    id: string, client: IPiEngine, cwd: string, label: string, sessionFilePath?: string, hidden?: boolean,
    parentSession?: string, forkEntryId?: string, modelOverride?: string,
  ): Promise<IManagedSessionView> {
    return this.lifecycle.registerSession(id, client, cwd, label, sessionFilePath, hidden, parentSession, forkEntryId, modelOverride)
  }

  // ── 私有协作者 ────────────────────────────────────────────────

  /**
   * 归属 project sidecar 延迟写入兑底（D14 语义修正，2026-08-04）。
   *
   * create 时 session 文件可能未落盘（pi 延迟写入窗口）→ persistProjectBinding 的
   * existsSync 守卫跳过（规则 #6 禁止提前建文件），只有内存态 projectId。
   * 本方法在 turn_end（主路径）/ agent_end（兑底）时补写——此时 pi 已完成 flush，
   * 文件存在，写 sidecar 安全。无归属（undefined）或文件仍不存在 → 跳过（下次兑底）。
   *
   * 用 projectBindingPersisted 标记防重复写（session 级运行时标记，不进 toSummary）。
   */
  private tryPersistProjectBinding(s: IManagedSessionView): void {
    const projectId = (s as IManagedSessionView & { projectId?: string }).projectId
    const persisted = (s as IManagedSessionView & { projectBindingPersisted?: boolean }).projectBindingPersisted
    if (persisted || !projectId || !s.sessionFilePath || !existsSync(s.sessionFilePath)) return
    this.sessionStore.persistProjectBinding(s.sessionFilePath, projectId)
    ;(s as IManagedSessionView & { projectBindingPersisted?: boolean }).projectBindingPersisted = true
  }

  /**
   * 查询 session 的扩展命令（pi getCommands）。纯查询，无副作用。
   * 用于 renderer 切 session 后主动拉取（修复 broadcast 与订阅时序竞争）。
   *
   * W8 commands 失效接线：本方法是 commands 失效信号的全部汇聚点（W12 起激活发布路径
   * 已删——播种 fetch 经 fetchCommandsSnapshot 挂钩发布，仅剩 renderer 的 session.getCommands
   * RPC 查询路径经此）——查询即失效，markDirty 触发 commands 实例防抖重拉 get_commands
   * 快照（实例唯一数据写路径），重拉完成后经挂钩刷新 session.commands last-value，
   * RPC 响应本身不直写实例数据、也不直接 publish。
   *
   * @throws session 未激活或 pi getCommands 失败时抛（调用方 try-catch）
   */
  async getCommands(sessionId: string): Promise<PiCommandInfo[]> {
    // W8：对齐现有发布路径的事件源全集（激活发布 + 主动查询），失效信号在 RPC 调用前发。
    this.projection.getReplicatedStates(sessionId)?.commands.markDirty()
    const client = this.pm.getClient(sessionId)
    if (!client) throw new Error(`session ${sessionId} not active`)
    return client.getCommands()
  }

  /**
   * 查询 pi 当前上下文占用（get_session_stats.contextUsage），返回 context.update payload。
   * 用于 session 恢复后拉取用量——pi 从历史估算，重启后旧 session 也能显示当前占用。
   * 复用 context.update 契约（inputTokens/contextLimit/usagePercent）。
   * contextUsage.tokens=null（compaction 后未跑新 turn）或 session 未激活时返回 null。
   * @throws session 未激活或 pi rpc 失败时抛（调用方 try-catch）
   */
  async fetchContext(sessionId: string): Promise<{
    inputTokens: number; contextLimit: number; usagePercent: number
  } | null> {
    const client = this.pm.getClient(sessionId)
    if (!client) throw new Error(`session ${sessionId} not active`)
    const stats = await client.getSessionStats()
    const cu = stats.contextUsage
    // pi 的 contextUsage 在 compact 后无新 turn 时返回 tokens=null（保守设计：
    // compact 前 last assistant usage 反映压缩前 context size，不可信；只有 compact 后
    // 产生新 assistant usage 才能算出真实 context 占用）。
    // 此时不应 fallback 到 tokens.total——那是 session 全生命周期的 token 累加
    // （含 cacheRead），远大于当前 context 占用，会显示荒谬的百分比（如 compact 后 978%）。
    // 正确行为：返回 null，前端不显示 ctx 用量，等用户发消息后 turn_end 刷成精确值。
    if (cu && cu.tokens != null) {
      // W10：restore 拉取写点 = usage 失效源（session 激活后 context 权威值可能已变——markDirty
      // 防抖重拉 get_session_stats 快照刷新 usage 实例，快照是 inputTokens 唯一数据源）。
      // 旧外部 setter 缓存回写已删：switchModel → broadcastSessionState 读实例快照，
      // 注册播种（registerReplicatedStates refetch）已保证快照非空，不再依赖本方法回写。
      this.projection.getReplicatedStates(sessionId)?.usage.markDirty()
      return {
        inputTokens: cu.tokens,
        contextLimit: cu.contextWindow,
        usagePercent: Math.round(cu.percent ?? 0),
      }
    }
    return null
  }

  /**
   * 拉取上下文用量并触发广播（restoreSession / forkSession 兜底用；语义注释随实现迁
   * session-state-projection.ts）。ILifecycleSessionOps 声明保持，单一实现 = 本委托。
   */
  async fetchAndBroadcastContext(sessionId: string): Promise<void> {
    return this.projection.fetchAndBroadcastContext(sessionId)
  }

  // ── 附件存储（S1 迁出至 attachment-store.ts；安全校验语义 TC3 零削弱，回归见该模块头注释）──
  async writeImage(
    sessionId: string,
    base64: string,
    mimeType: string,
    name: string,
  ): Promise<{ path: string; fileName: string; displayName: string; id: string; persisted: boolean }> {
    return this.attachmentStore.writeImage(sessionId, base64, mimeType, name)
  }

  async migrateImage(
    fromPath: string,
    sessionId: string,
    fileName: string,
  ): Promise<{ path: string }> {
    return this.attachmentStore.migrateImage(fromPath, sessionId, fileName)
  }

  async writeSegmentsMetadata(sessionId: string, entry: SegmentsMetadataEntry): Promise<void> {
    return this.attachmentStore.writeSegmentsMetadata(sessionId, entry)
  }
}
