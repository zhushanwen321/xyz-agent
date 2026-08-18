import { PluginPermissionChecker as PermissionChecker } from './plugin-permission.js'
import type { PluginDescriptor, ToolEntry, HookEntry, HookContext, HookResult, BridgeToolExecuteRequest, BridgeToolExecuteResponse, BridgeInterceptResponse, BridgeSyncPayload, ToolRegistration, IPluginServiceDeps } from './plugin-types.js'
import type { StatusBarItem, PluginInfo } from '@xyz-agent/shared'
import type { IPluginService, ISessionService } from '../../interfaces.js'
import type { IMessageBroker } from '../../interfaces.js'
import type { ServerMessage } from '@xyz-agent/shared'
import { PluginRegistry } from './plugin-registry.js'
import { PluginStorage } from './plugin-storage.js'
import { SessionDataStore } from './session-data-store.js'
import { PluginRpcServer } from './plugin-rpc-server.js'
import { PluginHost, resolveAndValidateFile } from './plugin-host.js'
import { PluginActivator } from './plugin-activator.js'
import { registerAllRpcMethods } from './plugin-rpc-setup.js'
import { bootstrapPluginService } from './plugin-lifecycle.js'
import { ActiveSessionResolver, SessionEventDispatch, sessionInfoFromSummary } from './api/session-api.js'
import { COMMAND_RPC_METHODS, commandCompositeKey } from './api/commands-api.js'
import type { CommandRegistration } from './api/commands-api.js'
import type { InstallResult } from '../ports/plugin-installer.js'
import { handleBridgeToolExecute, handleBridgeEvent, handleBridgeIntercept, BridgeToolCache, PI_HOOK_EVENT_MAP } from './bridge-interop.js'
import { toConfigKey, fromConfigKey, isConfigKey } from './api/config-api.js'
import { HookPipeline, OBSERVE_HOOK_TYPES } from './hook-pipeline.js'
import { UiRequestQueue } from './ui-request-queue.js'
import { StatusBarRegistry } from './status-bar-registry.js'
import { PermissionStorage } from './plugin-permission-storage.js'
import { EXTERNAL_PLUGIN_ENABLED, EXTERNAL_PLUGIN_DISABLED_MESSAGE } from './plugin-security.js'
import { join } from 'node:path'
import { toErrorMessage } from '../../utils/errors.js'
import { PendingTracker } from '../../utils/async/pending-tracker.js'
// type-only：IMessageBus 不反向依赖 plugin-service，无运行时环（与 message-dispatcher 同款约束）
// wave:perf-w09（接口收敛）：依赖 publish 抽象而非 MessageBus 具体类
import type { IMessageBus } from '../message-bus/message-bus.js'


const COMMAND_EXECUTE_TIMEOUT_MS = 10_000

/**
 * 从 execArgv 中提取 tsx 注入的 --import 值（dev 模式判定）。
 *
 * tsx 运行时（`npx tsx src/index.ts`）向 node 注入（实测 Node 24 + tsx）：
 *   ['--require', '<...>/node_modules/tsx/dist/preflight.cjs',
 *    '--import', 'file://<...>/node_modules/tsx/dist/loader.mjs']
 * 判定条件：--import 的值含 `node_modules/tsx/`（同时覆盖 file:// URL 与裸路径、
 * npm/pnpm 安装布局）。支持 `--import <value>` 与 `--import=<value>` 两种形态。
 */
export function findTsxImportArg(execArgv: readonly string[]): string | undefined {
  for (let i = 0; i < execArgv.length; i++) {
    const arg = execArgv[i]
    if (arg === '--import' && i + 1 < execArgv.length) {
      const value = execArgv[i + 1]
      if (value.includes('node_modules/tsx/')) return value
    } else if (arg.startsWith('--import=')) {
      const value = arg.slice('--import='.length)
      if (value.includes('node_modules/tsx/')) return value
    }
  }
  return undefined
}

/**
 * 解析 sandbox 子进程 ESM loader 路径，构建 execArgv（--import 注入）。
 *
 * loader（plugin-esm-loader.cjs）经 execArgv 注入 fork 子进程，注册 ESM resolve
 * hook 封堵 node:* 内置模块 + 越界路径 import（重构 3：消除 ESM import 绕过）。
 * 与 plugin-bootstrap.cjs 同目录约定，路径经 resolveAndValidateFile 动态推导
 * （AGENTS.md #12：打包后 __dirname → app.asar.unpacked/dist/runtime/，
 * dev → src/services/plugin-service/）。
 *
 * F1（dev sandbox fork 修复）：主进程运行于 tsx 时（execArgv 含 tsx 的 --import），
 * 把该项追加到 fork execArgv 末尾。fork 默认不继承父进程 execArgv（C3），子进程
 * 入口 plugin-bootstrap-process.ts 内部 `import './plugin-bootstrap.js'`（TS ESM
 * 风格后缀）依赖 tsx loader 的 resolve hook 做 .js→.ts remap——esm-loader 只透传
 * 不 remap，Node 原生 resolver 找不到 .js 文件 → ERR_MODULE_NOT_FOUND，dev 模式
 * sandbox 插件激活必炸。顺序约束：esm-loader 必须在前（fork 边界 MF-1 断言
 * execArgv 含 --import，且 Node hooks 链后注册先调用——tsx remap 后的路径仍会流经
 * esm-loader 的沙箱边界检查，不破坏封堵语义）。
 *
 * MF-1（fail-closed 分层）：loader 缺失时本函数返回 undefined（不阻塞 runtime 启动），
 * 真正的 fail-closed 在 PluginHostProcess.createProcess 的 fork 边界——sandbox fork 前
 * 断言 execArgv 含 --import，缺失即 throw（拒绝创建无 ESM 防护的 sandbox 进程）。
 * 故 loader 缺失时 runtime 仍能启动（trusted 插件正常），仅 sandbox（external）插件激活
 * 会被拒。loader 存在性另由 postbuild-validate.sh + validate-runtime-bundle.sh CI 强制校验。
 */
export function resolveEsmLoaderExecArgv(): string[] | undefined {
  try {
    const loaderPath = resolveAndValidateFile('plugin-esm-loader.cjs')
    const execArgv = ['--import', loaderPath]
    const tsxImport = findTsxImportArg(process.execArgv)
    if (tsxImport) {
      execArgv.push('--import', tsxImport)
    }
    return execArgv
  } catch (e: unknown) {
    console.error(
      '[plugin-service] plugin-esm-loader.cjs not found; sandbox ESM guard inactive ' +
      '(sandbox plugin activation will be refused at fork boundary; fix loader packaging before shipping):',
      e,
    )
    return undefined
  }
}

/**
 * PluginService — 纯门面 + 初始化编排（ADR-0012/0013/0014/0023/0001）。
 *
 * 5 个原交职责已下沉到内聚模块，本类仅保留：
 *  (a) initialize 编排（9 步生命周期装配）；
 *  (b) 协作者装配（registry/storage/rpcServer/host/activator/...）；
 *  (c) 薄门面方法：委托 HookPipeline / UiRequestQueue / StatusBarRegistry /
 *      bridge-interop。
 */
export class PluginService implements IPluginService {
  /** 插件注册表（与 host/rpcServer/activator 同为协作者装配位，公开供测试直注 descriptor） */
  readonly registry: PluginRegistry
  private storage: PluginStorage
  rpcServer: PluginRpcServer
  host: PluginHost
  /** 激活状态机（与 host/rpcServer 同为协作者装配位，公开供编排层与测试直查状态） */
  readonly activator: PluginActivator
  private broker: IMessageBroker
  private initialized = false

  /** Tool 注册表，key 为 toolKey（`${pluginId}:${name}`） */
  private toolRegistry = new Map<string, ToolEntry>()

  /** Hook 执行管道（持有 hookRegistry、共享 host/rpcServer 引用） */
  readonly hookPipeline: HookPipeline

  /** Status bar 注册表（持有 items，广播交由注入回调） */
  readonly statusBarRegistry: StatusBarRegistry

  /** UI 请求串行队列（独立状态机，广播交由注入回调） */
  readonly uiRequestQueue: UiRequestQueue

  /** SessionData 内存缓存 + flush + 持久化编排 */
  private readonly sessionDataStore: SessionDataStore

  /** 注入的外部依赖 */
  private deps: IPluginServiceDeps

  /** xyz-agent 配置根（~/.xyz-agent/），plugin/session-data 持久化根。组合根注入。 */
  private readonly configDir: string

  /** bridge 工具 schema 缓存 + sync 负载塑形（P5：职责收口到 bridge-interop） */
  private readonly bridgeToolCache = new BridgeToolCache()

  private permissionChecker: PermissionChecker

  /** 活跃 session 解析器（P6：取代 plugin-rpc-setup 模块级全局缓存，随实例生命周期） */
  private readonly activeSessionResolver: ActiveSessionResolver

  /**
   * 命令注册表（复合键 `pluginId:commandId` → CommandRegistration，D7 隔离），
   * commands 域 RPC handler 共享（IF2 DM1）。
   */
  private readonly commandRegistry = new Map<string, CommandRegistration>()

  /**
   * 命令执行 pending 登记表（S3-W1 发送段闭环）：executeCommand 发
   * plugin.commands.invoke 通知后按 handlerId 等待 Worker 经
   * plugin.commands.invoke.result 回传的结果/错误；超时兜底 reject。
   */
  private readonly commandInvokes = new PendingTracker<string, unknown>()

  /** session 生命周期事件注册表（S3-W2）：handlerId → workerId 定向投递 */
  private readonly sessionEventDispatch: SessionEventDispatch

  /** 挂载点集合（renderer 经 plugin.mountPoints.sync 上报，views.listMountPoints 中继查询，AC10） */
  private mountPoints: string[] = []

  /**
   * IMessageBus（wave:perf-w08，02 文档 D1-1）：plugin 的 session 级广播接 bus 定向发布。
   * 经 setMessageBus 后置注入（与 SessionService.setMessageBus 同模式）。wave:perf-w09
   * 接口收敛后 wire 归组合根（index.ts，pluginService 构造后直调）。未注入时回退全局广播。
   */
  private messageBus: IMessageBus | null = null

  constructor(registry: PluginRegistry, broker: IMessageBroker, deps?: IPluginServiceDeps) {
    this.registry = registry
    this.broker = broker
    this.deps = deps ?? {}
    // configDir 注入：plugin 切片经此拿配置根（~/.xyz-agent/），不再直连 infra（design.md
    // T5 切片自治）。生产由 index.ts 注入；缺省回退 process.cwd() 仅供单测。
    const configDir = this.deps.configDir ?? process.cwd()
    this.configDir = configDir
    const pluginsDir = join(configDir, 'plugins')
    this.storage = new PluginStorage()
    this.rpcServer = new PluginRpcServer()
    // sandbox 子进程 ESM loader 经 execArgv --import 注入（重构 3：消除 ESM 绕过）。
    // MF-1：loader 缺失时 resolveEsmLoaderExecArgv 返回 undefined → 不传 execArgv 选项 →
    // PluginHostProcess.execArgv 默认 [] → sandbox fork 边界 fail-closed throw（见
    // plugin-host-process.ts createProcess 的 SANDBOX_LOADER_MISSING 断言）。runtime 不崩。
    const esmExecArgv = resolveEsmLoaderExecArgv()
    this.host = new PluginHost(
      this.rpcServer,
      esmExecArgv ? { execArgv: esmExecArgv } : undefined,
    )
    this.sessionDataStore = new SessionDataStore(configDir)
    this.permissionChecker = new PermissionChecker(registry, new PermissionStorage(pluginsDir))

    // 活跃 session 解析器：持有同一 deps 引用（setSessionService 后续 mutate 可见）
    this.activeSessionResolver = new ActiveSessionResolver(this.deps)

    // session 事件注册表：复用同一 rpcServer（workerId↔port 映射 + notify 通道）
    this.sessionEventDispatch = new SessionEventDispatch(this.rpcServer)

    // Hook 管道：持有共享 hookRegistry（rpc-setup 注册侧与本类消费侧同一实例），
    // 复用 host / rpcServer 引用。
    this.hookPipeline = new HookPipeline({
      hookRegistry: new Map<string, HookEntry[]>(),
      host: this.host,
      rpcServer: this.rpcServer,
    })

    // UI 请求队列：广播走 broadcastFn（优先）或 broker.broadcast（回退），与原实现一致。
    // MF-2：广播 payload 注入当前活跃 sessionId（与 views.update 同源，ActiveSessionResolver 求值时点）——
    // 前端 DialogRequestQueue/useExtensionUI 均按 sessionId 分区消费，无 sid 的 uiRequest 会被双消费方
    // 丢弃（C2 守卫），plugin dialog 永不弹出。resolve 时点求值：同一会话串行队列内 resolve 稳定。
    // wave:perf-w08（02 文档 D1-1）：sid 为 string 且 bus 已装配 → bus.publish(sid) 定向发布
    // （plugin:uiRequest 归 stream 类，分配 seq + 入 ring 可回放），不再 broadcast；
    // sid undefined（无活跃 session 的弹窗仍须必达全部连接）或 bus 未装配 → 保持全局广播。
    this.uiRequestQueue = new UiRequestQueue((type, payload) => {
      const active = this.activeSessionResolver.resolve()
      const sid = active?.id
      const fullPayload = { ...payload, sessionId: sid }
      if (sid !== undefined && this.messageBus) {
        // m2：'plugin:uiRequest' 已收录 ServerMessageMap 具名条目（requestId 必带 + 索引签名
        // 透传 dialog 字段），UiBroadcastFn payload 同步收紧——免 as ServerMessage 断言，
        // payload 形状漂移在编译期被 shared 契约拦截。
        this.messageBus.publish(sid, {
          type,
          id: `ui_${payload.requestId}`,
          payload: fullPayload,
        })
        return
      }
      this.broadcastOrBroker(type, `ui_${payload.requestId}`, fullPayload)
    })

    // Status bar 注册表：广播保持 `plugin:statusBarUpdate` 契约（ADR-0015）。
    this.statusBarRegistry = new StatusBarRegistry((payload) => this.broker.broadcast({
      type: 'plugin:statusBarUpdate', id: `sb_${Date.now()}`, payload,
    } as ServerMessage))

    this.activator = new PluginActivator({
      permissionChecker: this.permissionChecker,
      onPermissionRequest: (payload) =>
        this.broadcastOrBroker('plugin:permissionRequest', `perm_${payload.pluginId}`, payload),
    })
  }

  /** 广播优先走 broadcastFn，否则回退 broker.broadcast（广播契约不变） */
  private broadcastOrBroker(type: string, id: string, payload: unknown): void {
    if (this.deps.broadcastFn) {
      this.deps.broadcastFn(type, payload)
    } else {
      this.broker.broadcast({ type, id, payload } as ServerMessage)
    }
  }

  /**
   * 覆盖式写入挂载点集合（DM3 全量镜像，不合并）。
   * renderer 壳在注册/注销挂载点后经 plugin.mountPoints.sync WS 上报整表。
   * 注意：必须原地清空重填（length=0 + push）而非整体替换引用——
   * registerRpcMethods 已把 this.mountPoints 的引用透传给 ctx → registerViewRpcHandlers，
   * 替换引用会让 RPC handler 读到旧数组（AC10 中继失效）。
   */
  syncMountPoints(mountPoints: string[]): void {
    this.mountPoints.length = 0
    this.mountPoints.push(...mountPoints)
  }

  /** Wire sessionService after construction (breaks circular dependency at creation time) */
  setSessionService(sessionService: ISessionService): void {
    this.deps.sessionService = sessionService
  }

  /**
   * Wire IMessageBus（02 文档 D1-1）：plugin 的 session 级广播点（plugin:viewUpdate /
   * plugin:uiRequest）接 bus 定向发布。wave:perf-w09 接口收敛：wire 归组合根
   *（index.ts 在 pluginService 构造后直调，不再经 server.setServices 中转）。
   * 未注入时广播点回退全局广播（broker.broadcast 兜底，消息不丢）。
   */
  setMessageBus(bus: IMessageBus): void {
    this.messageBus = bus
  }

  /**
   * views.update 的广播出口（wave:perf-w08，02 文档 D1-1；rpc-setup 的
   * handleViewUpdate 构造 payload 后经此发布）。
   *
   * payload.sessionId 由调用方保证存在（rpc-setup ES2：无活跃 session 已提前丢弃）。
   * bus 已装配 → publish 定向（plugin:viewUpdate 归 transient 类：高频 UI 流，不占
   * seq、不入 ring，直传订阅者——丢失可接受，ExtensionHost 不靠 ring 回放重建状态），
   **不再 broadcast**；bus 未装配（测试构造）→ 回退全局广播，保持消息不丢。
   */
  publishViewUpdate(payload: {
    sessionId: string
    viewId: string
    pluginId: string
    guiTree: import('@xyz-agent/extension-protocol').GuiComponent[]
    updatedAt: number
  }): void {
    if (this.messageBus) {
      // m2/m3：'plugin:viewUpdate' 已是 ServerMessageMap 精确条目（payload 形状一致），
      // 免 as ServerMessage 断言；push id 改单调计数（Date.now() 同毫秒多视图更新会碰撞，
      // 前端按 id 去重/追踪场景下碰撞导致更新被误判重复）。
      this.messageBus.publish(payload.sessionId, {
        type: 'plugin:viewUpdate',
        id: this.nextViewUpdateId(),
        payload,
      })
      return
    }
    this.broadcastOrBroker('plugin:viewUpdate', this.nextViewUpdateId(), payload)
  }

  /**
   * viewUpdate push id 单调计数（m3，对齐 broker.nextPushId 语义）。
   * `vu_${Date.now()}` 在同一毫秒内多次 views.update（批量刷新多视图）会产出相同 id。
   */
  private viewUpdateIdCounter = 0
  private nextViewUpdateId(): string {
    this.viewUpdateIdCounter += 1
    return `vu_${this.viewUpdateIdCounter}`
  }

  async initialize(): Promise<void> {
    if (this.initialized) return

    // Worker 回调（crash/rebuilt/reply）紧耦合多个私有协作者（activator/broker/
    // registry/host），搬出会引入更宽的注入缝，故作为委托缝留在本类（P4 PARTIAL）。
    this.registerWorkerCallbacks()

    // 9 步顺序启动装配委托 plugin-lifecycle（god-orchestrator 收口）。
    await bootstrapPluginService({
      registry: this.registry,
      storage: this.storage,
      rpcServer: this.rpcServer,
      host: this.host,
      activator: this.activator,
      permissionChecker: this.permissionChecker,
      sessionDataStore: this.sessionDataStore,
      configDir: this.configDir,
      registerRpcMethods: () => this.registerRpcMethods(),
      broadcastPluginList: () => this.broadcastPluginList(),
      watchExternalIfActive: (desc) => this.watchExternalIfActive(desc),
      registerSendMessageHook: () => this.registerSendMessageHook(),
    })

    this.initialized = true
  }

  /**
   * 注册 Worker 生命周期回调（crash / rebuilt / reply）。
   *
   * P4：这三个回调紧耦合 activator.markCrashed、broker.broadcast、
   * registry.getDescriptor、host.loadPlugin、activator.activatePlugin 等
   * 私有协作者，搬出 plugin-service 会引入更宽的注入缝，故作为委托缝留在本类。
   */
  private registerWorkerCallbacks(): void {
    // 4. Worker crash callback
    this.host.setCrashCallback((workerId, pluginIds, error) => {
      for (const pluginId of pluginIds) {
        this.activator.markCrashed(pluginId)
      }
      // D6/W4 贡献清理：崩溃插件的 statusBar/hook/tool/command 贡献不残留——对齐
      // togglePlugin(false) 的清理集（僵尸 statusbar 条目/仍可被路由的 tool/command
      // 都指向已死 Worker，调用必超时）。rebuild 成功后 onRebuilt 重激活会重新注册。
      for (const pluginId of pluginIds) {
        this.statusBarRegistry.clearForPlugin(pluginId)
        this.removeHookEntriesFor(pluginId)
        this.removeToolEntriesFor(pluginId)
        this.removeCommandEntriesFor(pluginId)
        this.sessionEventDispatch.clearForPlugin(pluginId)
      }
      void this.syncToolsToBridge().catch((err: unknown) => {
        console.error('[plugin-service] syncToolsToBridge after crash failed:', toErrorMessage(err))
      })
      for (const pluginId of pluginIds) {
        this.broker.broadcast({
          type: 'plugin:crashed',
          id: `crash_${pluginId}_${Date.now()}`,
          payload: { pluginId, workerId, error },
        })
      }
      // Trusted Worker 崩溃后通过 rebuildWorker 自动重建
    })

    // 4a. Worker 重建后的重新加载回调
    this.host.setRebuiltCallback((newWorkerId, pluginIds) => {
      this.handleWorkerRebuilt(newWorkerId, pluginIds)
    })

    // 4b. Worker 生命周期回复回调（activated/deactivated/error）
    this.host.setReplyCallback((msg) => {
      this.activator.handleWorkerReply(msg as import('./plugin-types.js').WorkerToHostMessage)
    })
  }

  /**
   * Worker 重建后的重载编排（rebuild 回调实现，D6/W3）。
   *
   * 只重激活当前状态为 CRASHED 的插件：冷却窗口内用户 disable（UNLOADED）或
   * uninstall（状态已移除）的插件跳过——rebuild 无条件重激活会复活用户明确
   * 关闭的插件（幽灵激活）。单插件重载失败只记日志，不影响同 Worker 其他插件。
   */
  handleWorkerRebuilt(newWorkerId: string, pluginIds: string[]): void {
    for (const pluginId of pluginIds) {
      const state = this.activator.getState(pluginId)
      if (state !== 'CRASHED') {
        console.log(`[plugin-service] skip reload after rebuild: ${pluginId} state=${state ?? 'REMOVED'}（非 CRASHED，用户已 disable/uninstall）`)
        continue
      }
      try {
        const descriptor = this.registry.getDescriptor(pluginId)
        if (descriptor) {
          this.host.loadPlugin(newWorkerId, pluginId, descriptor.pluginPath, 'trusted').then(() => {
            // Re-activate the plugin after loading
            return this.activator.activatePlugin(pluginId, { type: 'onStartupFinished' }, this.host)
          }).catch((err: unknown) => {
            console.error(`[plugin-service] failed to reload plugin ${pluginId}:`, err)
          })
        }
      // eslint-disable-next-line taste/no-silent-catch -- worker reload: error logged, other plugins unaffected
      } catch (err: unknown) {
        console.error(`[plugin-service] failed to reload plugin ${pluginId}:`, err)
      }
    }
  }

  /**
   * 由 initialize() 调用，确保 session 创建时 hook 已就绪。
   */
  private registerSendMessageHook(): void {
    if (this.deps?.sessionService) {
      this.deps.sessionService.setSendMessageHook(async (sessionId, content) => {
        const result = await this.executeHooks('onBeforeSendMessage', {
          sessionId,
          content,
          pluginId: '',
          hookType: 'onBeforeSendMessage' as import('./plugin-types.js').HookType,
          data: { content },
          timestamp: Date.now(),
        })
        if (result.blocked) return { blocked: true, reason: result.reason }
        // transform 语义消费侧（01 文档 §3.1 第 4 步）：拦截器经 modifiedData 改写的
        // {content} 由 HookPipeline 映射为 transformedData（D2-3），此处透传给
        // message-dispatcher 作为实际发送内容（demo 插件 !important → IMPORTANT 即此链路）
        const modifiedContent = (result.transformedData as { content?: unknown } | undefined)?.content
        if (typeof modifiedContent === 'string') {
          return { blocked: false, modifiedContent }
        }
        return null
      })
      // S3-W2：session 生命周期事件接线——session-service 的创建/销毁回调（其内部
      // 收敛点 notifySessionCreated / removeSessionEntry）转发到注册表，按 handlerId
      // 记录的 workerId 定向投递 plugin.sessions.didCreate/didDestroy 到对应 Worker。
      this.deps.sessionService.setOnSessionCreated(summary => {
        this.sessionEventDispatch.didCreate(sessionInfoFromSummary(summary))
      })
      this.deps.sessionService.setOnSessionDestroyed(summary => {
        this.sessionEventDispatch.didDestroy(sessionInfoFromSummary(summary))
      })
    }
  }

  getDiscoveredPlugins(): PluginInfo[] {
    return this.toPluginInfos(this.registry.getAllDescriptors())
  }

  async togglePlugin(pluginId: string, enabled: boolean): Promise<PluginInfo[]> {
    const descriptor = this.registry.getDescriptor(pluginId)
    if (!descriptor) throw new Error(`Plugin not found: ${pluginId}`)

    try {
      if (enabled) {
        // 启用：只激活目标插件（非全部）
        await this.activator.activatePlugin(pluginId, { type: 'onStartupFinished' }, this.host)
        // 激活成功后，对外部插件启动热重载监听
        this.watchExternalIfActive(descriptor)
      } else {
        // 禁用
        await this.activator.deactivatePlugin(pluginId, this.host)
        this.activator.stopWatching(pluginId) // 停止热重载监听
        this.statusBarRegistry.clearForPlugin(pluginId) // 清理 status bar items
        this.removeHookEntriesFor(pluginId) // P-1：清 hook 注册，禁用插件的 hook 不再执行
        // Fix-7：禁用插件的工具/命令同步清注册——与 P-1 的 hook 清理对称，否则禁用插件的
        // 工具仍可被 bridge 调用、命令 invoke 仍发向该插件（worker 已 deactivate，必超时）
        this.removeToolEntriesFor(pluginId)
        this.removeCommandEntriesFor(pluginId)
        // S3-W2：session 事件注册表同步清理（禁用插件的 didCreate/didDestroy 订阅不再投递）
        this.sessionEventDispatch.clearForPlugin(pluginId)
        await this.syncToolsToBridge()
      }
     
    } catch (err: unknown) {
      console.error(`[plugin-service] togglePlugin(${pluginId}, ${enabled}) failed:`, toErrorMessage(err))
      // 激活/停用失败仍然返回当前插件列表（允许前端回滚 UI）
    }

    this.broadcastPluginList()
    return this.getDiscoveredPlugins()
  }

  /** external 且已 ACTIVE 的插件启动 hot-reload 监听（重复逻辑统一） */
  private watchExternalIfActive(descriptor: PluginDescriptor): void {
    if (descriptor.source !== 'external' || this.activator.getState(descriptor.pluginId) !== 'ACTIVE') return
    this.activator.watchAndReload(descriptor.pluginId, descriptor.pluginPath, descriptor.source, this.host, (payload) => {
      this.broker.broadcast({ type: 'plugin:statusChange', id: `watch_${payload.pluginId}_${Date.now()}`, payload })
    })
  }

  async uninstallPlugin(pluginId: string): Promise<PluginInfo[]> {
    // descriptor 先取（removeDescriptor 之前）：pluginPath 供磁盘删除、source 供
    // builtin 判定
    const descriptor = this.registry.getDescriptor(pluginId)

    // 停用插件。Fix-5：deactivate 失败不阻断后续清理——注册表/工具/hook/命令清理是
    // uninstall 的核心语义，Worker 侧 deactivate 抛错（如超时）时仍必须完成本地拆除
    try {
      await this.activator.deactivatePlugin(pluginId, this.host)
    } catch (err: unknown) {
      // best-effort 降级（Fix-5）：deactivate 失败不阻断清理——uninstall 的注册表/工具/
      // hook/命令拆除必须完成（Worker 已 deactivate 抛超时等错误时仍要拆本地状态）
      console.error(`[plugin-service] deactivate during uninstall failed (continuing cleanup) for ${pluginId}:`, toErrorMessage(err))
    }

    // F2-①：停该插件的 fs.watch 热重载监听（toggle(false) 有 stopWatching，uninstall
    // 此前缺失——目录删除后残留 watcher 持续触发 reload 事件）
    this.activator.stopWatching(pluginId)

    // F2-③：sandbox 子进程真杀。deactivate 只 postMessage 不 terminate（fork 宿主的
    // 进程复用设计），但 uninstall 后插件目录即删，复用无意义且泄漏进程。
    // terminateProcess 内置 SIGTERM→2s→SIGKILL 升级链。trusted Worker 共享
    //（≤10 插件/线程），terminate 会误杀同 worker 其他插件，跳过。未激活/无进程
    // 时 getWorkerHandle 返回 undefined，天然 no-op。
    const handle = this.host.getWorkerHandle(pluginId)
    if (handle && handle.workerId.startsWith('sandbox-')) {
      await this.host.terminateWorker(handle.workerId).catch((err: unknown) => {
        console.error(`[plugin-service] terminate sandbox process during uninstall failed for ${pluginId}:`, toErrorMessage(err))
      })
    }

    // F2-②：删除磁盘插件目录（此前缺失 → 重启后 registry.scan() 把插件扫回来）。
    // 仅 external 插件删盘——builtin（resources/plugins，随应用分发）删盘会破坏安装
    // 产物。删除失败记日志不中断内存清理：磁盘残留重启后被 scan 扫回、可重试；
    // 内存清理（下方 registry/activator/工具/hook 拆除）是 uninstall 的核心语义。
    if (descriptor && descriptor.source === 'external') {
      const installer = this.deps.pluginInstaller
      if (installer) {
        try {
          await installer.uninstall(pluginId, descriptor.pluginPath)
        } catch (err: unknown) {
          console.error(`[plugin-service] on-disk removal during uninstall failed (continuing in-memory cleanup) for ${pluginId}:`, toErrorMessage(err))
        }
      } else {
        console.warn(`[plugin-service] no pluginInstaller configured; on-disk removal skipped for ${pluginId}`)
      }
    }

    // 从注册表中移除
    this.registry.removeDescriptor(pluginId)

    // F2-④：清理 activator 侧描述符/状态/eventMap（此前缺失 → 幽灵重激活：
    // activationEvent 下次触发时 eventMap 仍命中已卸载插件）
    this.activator.removeDescriptor(pluginId)

    // 清理工具和 hook 注册
    this.removeToolEntriesFor(pluginId)
    this.removeHookEntriesFor(pluginId)
    // 清理命令注册表（插件卸载后残留命令会导致 invoke 通知发向已死 worker）
    this.removeCommandEntriesFor(pluginId)
    // S3-W2：session 事件注册表同步清理（卸载插件的订阅不再投递）
    this.sessionEventDispatch.clearForPlugin(pluginId)

    // 清理 status bar items
    this.statusBarRegistry.clearForPlugin(pluginId)

    await this.syncToolsToBridge()
    this.broadcastPluginList()
    return this.getDiscoveredPlugins()
  }

  /**
   * 清理指定插件的全部 hook 注册条目（P-1：togglePlugin(false) 与 uninstallPlugin 共用）。
   *
   * filter 重建数组保序（注册时的 priority 排序不受影响）；清空的 hookType 条目整键删除。
   * Worker 侧对偶清理在 plugin-bootstrap 的 'deactivate' 分支（disposePluginHooks）。
   */
  private removeHookEntriesFor(pluginId: string): void {
    for (const [hookType, entries] of this.hookPipeline.registry) {
      const filtered = entries.filter(e => e.pluginId !== pluginId)
      if (filtered.length === 0) {
        this.hookPipeline.registry.delete(hookType)
      } else {
        this.hookPipeline.registry.set(hookType, filtered)
      }
    }
  }

  /**
   * 清理指定插件的全部工具注册条目（Fix-7：与 removeHookEntriesFor 同模式）。
   *
   * togglePlugin(false) 与 uninstallPlugin 共用——禁用插件的工具不再出现在 bridge
   * schema 同步（syncToolsToBridge）与 bridge 执行路由中。Worker 侧对偶清理在
   * plugin-bootstrap 的 'deactivate' 分支（disposePluginTools）。
   */
  private removeToolEntriesFor(pluginId: string): void {
    for (const [toolKey, entry] of this.toolRegistry) {
      if (entry.pluginId === pluginId) {
        this.toolRegistry.delete(toolKey)
      }
    }
  }

  /**
   * 清理指定插件的全部命令注册条目（Fix-7：与 removeHookEntriesFor 同模式）。
   * 禁用/卸载后 command invoke 不再投递给该插件。
   */
  private removeCommandEntriesFor(pluginId: string): void {
    for (const [commandId, reg] of this.commandRegistry) {
      if (reg.pluginId === pluginId) {
        this.commandRegistry.delete(commandId)
      }
    }
  }

  async approvePermissions(pluginId: string, permissions: string[]): Promise<void> {
    const descriptor = this.registry.getDescriptor(pluginId)
    if (!descriptor) throw new Error(`Plugin not found: ${pluginId}`)

    // Update descriptor permissions
    descriptor.permissions = [...new Set([...descriptor.permissions, ...permissions])]
    // Update permission checker's granted map
    this.permissionChecker.grant(pluginId, permissions)
    await this.permissionChecker.save()

    // 唤醒正挂在权限审批等待的那次激活（若有）：只 grant 不 resolve pending 的话，
    // 挂起中的激活（boot/handleEvent 里 await 着）要干等 30s 超时才回落。无 pending
    // 时 no-op（resolvePermissionApproval 内部守卫）。
    this.activator.resolvePermissionApproval(pluginId, true)

    // activatePlugin 真幂等（in-flight 重入返回同一 promise）：
    // - 挂起中的激活刚被唤醒、仍在 ACTIVATING → 此处 await 与它同步完成（毫秒级）；
    // - 已 ACTIVE → no-op；
    // - UNLOADED（等待早已超时回落 / 从未激活）→ 权限已 grant，新起激活不再挂起。
    await this.activator.activatePlugin(pluginId, { type: 'onStartupFinished' }, this.host)
    this.watchExternalIfActive(descriptor)
  }

  async revokePermissions(pluginId: string): Promise<void> {
    const descriptor = this.registry.getDescriptor(pluginId)
    if (!descriptor) throw new Error(`Plugin not found: ${pluginId}`)

    descriptor.permissions = []
    this.permissionChecker.revoke(pluginId)
    await this.permissionChecker.save()

    // 拒绝语义：该插件正挂在权限审批等待时唤醒为「拒绝」——挂起中的激活走既有
    // 失败路径（UNLOADED、不分配 Worker），而非干等 30s 超时。无 pending 时 no-op
    // （仅撤销已授权限，不主动停用已激活插件）。
    this.activator.resolvePermissionApproval(pluginId, false)
  }

  /**
   * 执行插件注册的命令（S3-W1 发送段闭环）。
   *
   * 链路：复合键查 registry → rpcServer.notify 向 Worker 发 plugin.commands.invoke
   * （handler 驻留 Worker，方法名 COMMAND_RPC_METHODS.invoke 统一 SSOT）→ Worker
   * 执行 handler 后经 plugin.commands.invoke.result 回传结果/错误 → 本类
   * deliverInvokeResult resolve/reject 对应 pending（超时 COMMAND_EXECUTE_TIMEOUT_MS）。
   *
   * 前端消费契约（useExtensionHostBridge commandExecutor）：payload 携带分离的
   * pluginId + commandId，本方法组复合键 `${pluginId}:${commandId}` 查表——
   * 命令表按插件隔离（B 无法覆盖/注销 A 的同名命令）。
   */
  async executeCommand(pluginId: string, commandId: string, args?: Record<string, unknown>): Promise<unknown> {
    const descriptor = this.registry.getDescriptor(pluginId)
    if (!descriptor) throw new Error(`Plugin not found: ${pluginId}`)

    const compositeKey = commandCompositeKey(pluginId, commandId)
    const registration = this.commandRegistry.get(compositeKey)
    if (!registration) throw new Error(`Command not found: ${compositeKey}`)

    const handle = this.host.getWorkerHandle(pluginId)
    if (!handle) throw new Error(`Plugin worker not available: ${pluginId}`)

    // 并发守卫：同 handlerId 二次执行会覆盖 pending 登记表条目（旧 promise 永挂），
    // 显式拒绝并发（用户双击同一命令的第二次触发立即失败优于静默挂死）。
    if (this.commandInvokes.has(registration.handlerId)) {
      throw new Error(`Command already executing: ${compositeKey}`)
    }

    // 顺序约束：先登记 pending、立即发 notify、最后才 await——notify 必须在函数体
    // 挂起等待 result 之前发出（await 放前面会挂住函数体，通知永远发不出）。
    const result = this.commandInvokes.register(
      registration.handlerId,
      COMMAND_EXECUTE_TIMEOUT_MS,
      Object.assign(new Error(`Command execution timeout: ${compositeKey}`), { code: -32000 }),
    )
    this.rpcServer.notify(
      handle.workerId,
      COMMAND_RPC_METHODS.invoke,
      { handlerId: registration.handlerId, args: args ?? {} },
    )
    return result
  }

  /**
   * Worker 经 plugin.commands.invoke.result 回传的执行结果（commands 域 RPC
   * handler 调用）。error 非空 = handler 抛错，reject 对应 pending。
   *
   * 归属校验（D2 回传段）：handlerId 必须属于来源通道——查注册表找该 handlerId
   * 的 registration，registration.workerId（register 时从 ctx 捕获）不等于
   * sourceWorkerId 即拒绝投递（warn 落日志，pending 留给自身超时）。否则恶意/
   * 失控 Worker 可伪造他人 handlerId 的 result/error，resolve/reject 其他插件
   * 的命令 pending。registration 不存在（执行中被注销/禁用清理）同样 fail-closed
   * 拒绝——归属无从比对即不放行。
   *
   * 查表方式：registry 键是复合键 `pluginId:commandId` 而非 handlerId，此处直接
   * 遍历 values 找 handlerId 匹配。不建 handlerId 反查表的原因：反查表需在
   * register/unregister handler、removeCommandEntriesFor 及一切直接 set/delete
   * registry 的路径同步维护，多一处数据源多一处漂移出安全漏洞的机会；命令注册
   * 量级（单插件个位数 × 插件数十）下每次回传遍历 O(n) 为微秒级，且仅在命令
   * 执行回传时发生。单一数据源（registry 本身）无一致性风险。
   */
  private deliverInvokeResult(
    handlerId: string,
    payload: { result?: unknown; error?: unknown },
    sourceWorkerId: string,
  ): void {
    let registration: CommandRegistration | undefined
    for (const reg of this.commandRegistry.values()) {
      if (reg.handlerId === handlerId) {
        registration = reg
        break
      }
    }

    if (!registration) {
      console.warn(
        `[plugin-service] invoke result dropped: no registration for handlerId='${handlerId}' ` +
          `(command unregistered or plugin cleaned up?) sourceWorker=${sourceWorkerId}; ` +
          `pending (if any) left to its own timeout`,
      )
      return
    }
    if (registration.workerId !== sourceWorkerId) {
      console.warn(
        `[plugin-service] invoke result dropped: handlerId='${handlerId}' belongs to ` +
          `worker='${registration.workerId}' but result arrived from worker='${sourceWorkerId}' ` +
          `(possible forgery); pending left to its own timeout`,
      )
      return
    }

    if (payload.error !== undefined) {
      this.commandInvokes.reject(
        handlerId,
        new Error(`Command handler error: ${toErrorMessage(payload.error)}`),
      )
      return
    }
    this.commandInvokes.resolve(handlerId, payload.result)
  }

  async getPluginConfig(pluginId: string, key?: string): Promise<unknown> {
    if (key === undefined || key === '__all__') {
      // Return all config（key 前缀约定委托 config-api，P7 收口）
      const allKeys = this.storage.keys(pluginId)
      const configKeys = allKeys.filter(isConfigKey)
      const result: Record<string, unknown> = {}
      for (const configKey of configKeys) {
        result[fromConfigKey(configKey)] = this.storage.get(pluginId, configKey)
      }
      return result
    }
    return this.storage.get(pluginId, toConfigKey(key))
  }

  async setPluginConfig(pluginId: string, key: string, value: unknown): Promise<void> {
    this.storage.set(pluginId, toConfigKey(key), value)
  }

  async shutdown(): Promise<void> {
    if (!this.initialized) return
    this.initialized = false

    // D6/W3 rebuild 受约束：关停第一步立即关闭 rebuild 通道——deactivateAll 可能耗时
    // 数秒（单插件 deactivate 5s 超时），期间 rebuild 冷却到期会复活插件（LC-C2）。
    // host.shutdown 在链末尾才清，此时已晚。
    this.host.cancelPendingRebuilds()

    // S3-W1/W2：命令执行 pending 全部拒绝 + session 事件注册表清空
    //（Worker 即将终止，等待中的 executeCommand 与后续事件投递都无意义）。
    this.commandInvokes.rejectAll(new Error('Plugin service shutting down'))
    this.sessionEventDispatch.clearAll()

    // S3-W4：statusbar 广播合并窗口的待发 timer 清理（关停后不再广播）
    this.statusBarRegistry.dispose()

    // D6/W4 关停顺序（反转）：deactivateAll（allSettled，单插件 deactivate 超时不
    // 阻塞整体——每插件自带 DEACTIVATE_TIMEOUT_MS 兜底）→ sessionData flush+dispose
    // → storage flush+dispose → host.shutdown。旧顺序 flush 先于 deactivateAll，
    // 插件在 onDeactivate 里写的 sessionData 落在「表已停」窗口（debounce 500ms 的
    // flush timer 永不再触发）→ 正常关停丢数据（G6）。每步独立 catch：一步失败
    // 不跳过后续步骤（关停是 best-effort 链，错误只记日志）。
    try {
      this.activator.stopAllWatchers()
    } catch (err: unknown) {
      // best-effort 降级：watcher 清理失败不阻塞关停链（fs 句柄随进程退出释放）
      console.error('[plugin-service] shutdown: stopAllWatchers failed:', toErrorMessage(err))
    }

    try {
      // 插件 onDeactivate 在此执行（其 sessionData/storage 写入发生在后面两步 flush 之前）
      await this.activator.deactivateAll(this.host)
    } catch (err: unknown) {
      // best-effort 降级：单步失败继续 flush/dispose，保数据优先于保插件状态
      console.error('[plugin-service] shutdown: deactivateAll failed:', toErrorMessage(err))
    }

    try {
      this.sessionDataStore.flushAll()
      this.sessionDataStore.dispose()
      console.log('[plugin-service] shutdown: sessionData flushed and disposed')
    } catch (err: unknown) {
      // best-effort 降级：flush 失败仍继续后续关停（进程即将退出，重试无消费方）
      console.error('[plugin-service] shutdown: sessionData flush/dispose failed:', toErrorMessage(err))
    }

    try {
      this.storage.flushAll()
      this.storage.dispose()
    } catch (err: unknown) {
      // best-effort 降级：同上，一步失败不跳过 host.shutdown（Worker/子进程必须终止）
      console.error('[plugin-service] shutdown: storage flush/dispose failed:', toErrorMessage(err))
    }

    try {
      await this.host.shutdown()
    } catch (err: unknown) {
      // best-effort 降级：Worker/子进程终止失败记日志（进程退出兜底回收）
      console.error('[plugin-service] shutdown: host shutdown failed:', toErrorMessage(err))
    }

    try {
      this.rpcServer.dispose()
    } catch (err: unknown) {
      // best-effort 降级：注册表清理由进程退出兜底
      console.error('[plugin-service] shutdown: rpcServer dispose failed:', toErrorMessage(err))
    }
  }

  private registerRpcMethods(): void {
    registerAllRpcMethods({
      rpcServer: this.rpcServer,
      storage: this.storage,
      toolRegistry: this.toolRegistry,
      hookRegistry: this.hookPipeline.registry,
      statusBarItems: this.statusBarRegistry.items,
      deps: this.deps,
      broadcastStatusBarItems: () => this.statusBarRegistry.broadcastAll(),
      handleUiRequest: (method, params, pluginId) => this.uiRequestQueue.handleRequest(method, params, pluginId),
      syncToolsToBridge: () => this.syncToolsToBridge(),
      getDescriptor: (pluginId) => this.registry.getDescriptor(pluginId),
      sessionDataStore: this.sessionDataStore,
      activeSessionResolver: this.activeSessionResolver,
      commandRegistry: this.commandRegistry,
      sessionEvents: this.sessionEventDispatch,
      deliverInvokeResult: (handlerId, payload, sourceWorkerId) =>
        this.deliverInvokeResult(handlerId, payload, sourceWorkerId),
      mountPoints: this.mountPoints,
      publishViewUpdate: (payload) => this.publishViewUpdate(payload),
    })
  }

  /**
   * 执行 hookType 的钩子管道。
   *
   * observe 类 hookType（OBSERVE_HOOK_TYPES，D2-2）走零往返快捷路径：notifyObservers
   * 经 rpcServer.notify 派发后立即返回（无 pending/超时定时器/响应等待）；block/transform
   * 类委托 HookPipeline.execute（排序/串行/5s 超时/block/transform）。
   */
  async executeHooks(hookType: string, context: HookContext): Promise<HookResult> {
    if (OBSERVE_HOOK_TYPES.has(hookType)) {
      this.hookPipeline.notifyObservers(hookType, context)
      return { blocked: false }
    }
    return this.hookPipeline.execute(hookType, context)
  }

  /** 同步 toolRegistry schema 到 bridge 轮询缓存（委托 bridge-interop） */
  async syncToolsToBridge(): Promise<void> {
    this.bridgeToolCache.syncFrom(this.toolRegistry)
  }

  /** 获取 bridge 轮询缓存的工具 schema（委托 bridge-interop） */
  getToolSchemas(): ToolRegistration[] {
    return this.bridgeToolCache.getSchemas()
  }

  /**
   * 构造 bridge:sync 同步负载（工具 schema 塑形下沉 bridge-interop，transport 只 reply）。
   */
  getBridgeSyncPayload(): BridgeSyncPayload {
    return this.bridgeToolCache.getSyncPayload()
  }

  /**
   * 处理 bridge 发起的工具执行请求（ADR-0012 契约不变）。委托 bridge-interop。
   * 传 bridgeToolCache 的 name 索引（微项 7：O(1) 路由；索引随 syncToolsToBridge 刷新）。
   */
  async handleBridgeToolExecute(request: BridgeToolExecuteRequest): Promise<BridgeToolExecuteResponse> {
    return handleBridgeToolExecute(request, this.toolRegistry, this.host, this.rpcServer, this.bridgeToolCache)
  }

  handleBridgeEvent(eventName: string, data: unknown, sessionId: string): void {
    handleBridgeEvent(eventName, data, sessionId, (hookType, context) => this.executeHooks(hookType, context))
  }

  /**
   * 处理 bridge 拦截请求。
   *
   * 按 PI_HOOK_EVENT_MAP 判定（D4）：无映射条目 → 空响应（ERR2）；kind=observe →
   * 转 handleBridgeEvent 观察链路（fire-and-forget，不 block）；kind=intercept →
   * 委托 bridge-interop 拦截链路（block/injectedMessages 生效）。判定下沉到 service，
   * transport 不再做事件名白名单过滤。
   */
  async handleBridgeIntercept(eventName: string, data: unknown, sessionId: string): Promise<BridgeInterceptResponse> {
    const mapping = PI_HOOK_EVENT_MAP[eventName]
    if (!mapping) {
      return { injectedMessages: [] }
    }
    if (mapping.kind === 'observe') {
      // 纯观察事件：走 fire-and-forget 观察链路，不阻塞
      this.handleBridgeEvent(eventName, data, sessionId)
      return { injectedMessages: [] }
    }
    return handleBridgeIntercept(eventName, data, sessionId, (hookType, context) => this.executeHooks(hookType, context))
  }

  async installPlugin(packageSpecifier: string): Promise<InstallResult> {
    // external 安装硬锁（§6.6 排期硬锁）：sandbox 真隔离闭环已落地、
    // EXTERNAL_PLUGIN_ENABLED=true 后放行安装；开关回退 false 时短路在 installer port
    // 之前（fail-closed）。builtin 不经此入口（TC4），无需 source 判定。
    if (!EXTERNAL_PLUGIN_ENABLED) {
      return { success: false, error: EXTERNAL_PLUGIN_DISABLED_MESSAGE }
    }
    const installer = this.deps.pluginInstaller
    if (!installer) {
      return { success: false, error: 'Plugin installer not configured (pluginInstaller deps missing)' }
    }
    const result = await installer.install(packageSpecifier)
    if (result.success && result.pluginId) {
      // Re-scan registry to pick up the new plugin
      await this.registry.reload()
      // Re-register descriptors with activator
      const descriptors = this.registry.getAllDescriptors()
      this.activator.registerDescriptors(descriptors)
      this.broadcastPluginList()
    }
    return result
  }

  /** 将所有 dirty sessionData 批量 flush（由定时器调用） */
  async flushSessionData(): Promise<void> {
    this.sessionDataStore.flushAll()
  }

  /** flush 指定 session 的 dirty 数据（deactivate/关闭时调用） */
  async flushSessionDataForSession(sessionId: string): Promise<void> {
    this.sessionDataStore.flushSession(sessionId)
  }

  /** 清理指定 session 的数据缓存、dirty 跟踪和 size 记录 */
  clearSessionData(sessionId: string): void {
    this.sessionDataStore.clearSession(sessionId)
  }

  /** 处理前端返回的 UI 响应（供 server.ts 调用）。委托 UiRequestQueue。 */
  handleUiResponse(requestId: string, result: unknown): void {
    this.uiRequestQueue.handleResponse(requestId, result)
  }

  private broadcastPluginList(): void {
    const plugins = this.getDiscoveredPlugins()
    this.broker.broadcast({
      type: 'config.plugins',
      id: `plugins_${Date.now()}`,
      payload: { plugins },
    })
  }

  /** Get all current status bar items */
  getStatusBarItems(): StatusBarItem[] {
    return this.statusBarRegistry.getItems()
  }

  /** 将内部 PluginState（UPPER_CASE）映射为协议层展示状态（lower_case） */
  private mapStateForProtocol(state: string): PluginInfo['status'] {
    switch (state) {
      case 'ACTIVE': return 'active'
      case 'CRASHED': return 'crashed'
      case 'LOADING':
      case 'UNLOADED':
        return 'discovered'
      default:
        return 'inactive'
    }
  }

  /**
   * PluginDescriptor（runtime 内部，PluginInfo 超集）→ PluginInfo（WS 协议契约）。
   *
   * 字段挑选 + status 经 mapStateForProtocol 转 lower_case + enabled 推导。
   * 这是 config.plugins 协议债的正式收口点：之前 transport 层用 `as unknown as PluginInfo[]`
   * 强转（仅类型缝合、不改运行时序列化），现在下沉到 service 做真实的字段裁剪。
   *
   * enabled 语义：runtime 无独立「启用」持久化（togglePlugin 直接驱动激活/停用），
   * 故以激活态推导——ACTIVE 视为 enabled，其余 disabled。
   */
  private toPluginInfo(descriptor: PluginDescriptor): PluginInfo {
    const status = this.mapStateForProtocol(descriptor.status)
    return {
      pluginId: descriptor.pluginId,
      version: descriptor.version,
      displayName: descriptor.displayName,
      description: descriptor.description,
      status,
      trustLevel: descriptor.trustLevel,
      enabled: status === 'active',
    }
  }

  private toPluginInfos(descriptors: PluginDescriptor[]): PluginInfo[] {
    return descriptors.map(d => this.toPluginInfo(d))
  }
}
