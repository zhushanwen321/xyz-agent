import type { ISessionService, IConfigService } from '../../interfaces.js'

// 本文件内部仍引用以下「已拆分」域的类型（lifecycle/bridge/agent-api 等
// 内联类型用到了它们），故在此 import 以供本地使用；对外仍通过文件末尾的
// `export ... from` 重导出，保证 `from './plugin-types.js'` 不破坏。
import type {
  RpcRequest,
  RpcResponse,
  RpcNotification,
} from './plugin-types/rpc-protocol.js'
import type {
  HookType,
  HookInterceptor,
  HookObserver,
  PiEventCallback,
} from './plugin-types/hook-types.js'

/**
 * 插件系统内部类型定义
 *
 * 这些类型仅用于 runtime（主进程/Worker）内部的插件管理，
 * 不出现在前端↔runtime 的共享协议中。
 */

// ── Descriptor / Manifest 域 ───────────────────────────────────────
// 已拆分到 ./plugin-types/descriptor-types.ts。此处 re-export 保持
// 现有 `from './plugin-types.js'` 导入不破坏（NON-BREAKING）。
export type {
  PluginSource,
  XyzAgentManifest,
  XyzAgentPackageJson,
  PluginDescriptor,
  PluginContributes,
} from './plugin-types/descriptor-types.js'

// ── Worker 类型 ─────────────────────────────────────────────────

export interface WorkerHandle {
  workerId: string
  threadId: number
  trustLevel: 'trusted' | 'sandbox'
  pluginIds: string[]
  status: 'idle' | 'active' | 'crashed' | 'terminated'
  lastActiveAt: number
  memoryUsage?: number
}

// ── Activation 类型 ────────────────────────────────────────────

export type ActivationEventType = 'onStartupFinished' | 'onSessionCreate' | 'onSlashCommand' | 'onToolCall'

export interface ActivationEvent {
  type: ActivationEventType
  command?: string
  tool?: string
}

// ── Plugin Context（传递给插件 activate 函数的上下文）──────────

export interface PluginContext {
  readonly pluginId: string
  readonly pluginPath: string
  readonly globalState: PluginStateStorage
  readonly workspaceState: PluginStateStorage
  readonly api: Phase2AgentAPI
  readonly subscriptions: Disposable[]
}

export interface PluginModule {
  activate(context: PluginContext): void | Promise<void>
  deactivate?(): void | Promise<void>
}

// ── AgentAPI 类型（Phase 1 最小集）───────────────────────────────
//
// TODO(keystone): Phase1AgentAPI / Phase2AgentAPI / SessionInfo 是「漏的拱顶石」——
// Phase2AgentAPI 跨域引用 ToolRegistration、HookInterceptor、PiEventCallback、
// StatusBarItemOptions，SessionInfo 又被 api/session-api 等消费。把它移到独立文件
// 只会搬运耦合、制造 import 纠缠，故本轮 P3 拆分刻意将其保留在此处。
// 待 tool/hook 域各自稳定、API 表面收敛后再独立。

export interface Phase1AgentAPI {
  readonly storage: {
    readonly global: PluginStateStorage
    readonly workspace: PluginStateStorage
  }
  readonly notify: {
    info(message: string): Promise<void>
    warning(message: string): Promise<void>
    error(message: string): Promise<void>
  }
  readonly sessions: {
    list(): Promise<SessionInfo[]>
    get(id: string): Promise<SessionInfo | undefined>
    getActive(): Promise<SessionInfo | undefined>
    sendMessage(params: { sessionId?: string; role: 'user' | 'system'; content: string }): Promise<void>
    onDidCreateSession(handler: (session: SessionInfo) => void): Disposable
    onDidDestroySession(handler: (session: SessionInfo) => void): Disposable
  }
  readonly events: {
    on(event: string, handler: (data: unknown) => void): Disposable
    emit(event: string, data: unknown): void
  }
}

export interface SessionInfo {
  id: string
  label: string
  cwd: string
  status: 'active' | 'idle' | 'error'
  createdAt: number
  lastActiveAt: number
}

// ── Storage 类型 ─────────────────────────────────────────────────

export interface PluginStateStorage {
  get<T>(key: string): Promise<T | undefined>
  get<T>(key: string, defaultValue: T): Promise<T>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
}

// ── RPC 线协议域 ──────────────────────────────────────────────────
// 已拆分到 ./plugin-types/rpc-protocol.ts。此处 re-export 保持
// 现有 `from './plugin-types.js'` 导入不破坏（NON-BREAKING）。
export type {
  RpcRequest,
  RpcSuccessResponse,
  RpcErrorResponse,
  RpcResponse,
  RpcNotification,
  RpcMessage,
} from './plugin-types/rpc-protocol.js'

// ── Lifecycle 消息类型（Worker ↔ 主线程）────────────────────────

export type HostToWorkerMessage =
  | { type: 'load'; pluginId: string; pluginPath: string; trustLevel?: 'trusted' | 'sandbox' }
  | { type: 'activate'; pluginId: string; pluginDir: string; event: ActivationEvent }
  | { type: 'deactivate'; pluginId: string }
  | { type: 'rpc'; response?: RpcResponse; notification?: RpcNotification; request?: RpcRequest }

export type WorkerToHostMessage =
  | { type: 'loaded'; pluginId: string }
  | { type: 'activated'; pluginId: string }
  | { type: 'deactivated'; pluginId: string }
  | { type: 'error'; pluginId: string; error: string }
  | { type: 'fatal_error'; error: string; stack?: string }
  | { type: 'rpc' } & (RpcRequest | RpcNotification)

// ── 通用类型 ─────────────────────────────────────────────────────

// D28: Disposable 与 plugin-sdk/src/types.ts 的定义重复。理论上应提升到
// @xyz-agent/shared 作 single source of truth，但 SDK 通过 sync-types.sh 从本文件
// 自动生成、且刻意保持零依赖（第三方插件作者无需装整个 monorepo）。若改 re-export
// 会让 sync 后的 SDK 引入 @xyz-agent/shared 依赖，破坏独立性。故保留独立定义——
// 这是有意的跨包契约重复，sync 脚本是它的「真相源」。
export interface Disposable {
  dispose(): void
}

export type PluginPermission = string

export type PluginState = 'UNLOADED' | 'LOADING' | 'ACTIVATING' | 'ACTIVE' | 'DEACTIVATING' | 'CRASHED' | 'DEPS_MISSING'

// ── RPC Error Codes 域 ────────────────────────────────────────────
// 已拆分到 ./plugin-types/rpc-protocol.ts。const 必须用 export-from 重导出。
export { PluginRpcErrorCodes } from './plugin-types/rpc-protocol.js'
export type { PluginRpcErrorCode } from './plugin-types/rpc-protocol.js'

// ── Permission Constants ─────────────────────────────────────────

/** 插件权限常量，用于 PermissionChecker 的权限校验 */
export const PermissionConstants = {
  /** 允许注册自定义工具 */
  TOOLS_REGISTER: 'tools.register',
  /** 允许注册 hooks */
  HOOKS_REGISTER: 'hooks.register',
  /** 允许向 session 发送消息 */
  SESSIONS_SEND_MESSAGE: 'sessions.sendMessage',
  /** 允许读取 session 状态 */
  SESSIONS_READ_STATE: 'sessions.readState',
  /** 允许读写插件存储 */
  STORAGE_ACCESS: 'storage.access',
  /** 允许发送通知 */
  NOTIFY: 'notify',
} as const

export type PermissionConstant = (typeof PermissionConstants)[keyof typeof PermissionConstants]

/** Bridge 拦截响应，包含注入的消息列表 */
export interface BridgeInterceptResponse {
  blocked?: boolean
  reason?: string
  injectedMessages: unknown[]
}

/**
 * bridge:sync 同步负载（plugin-service 塑形后返回）。
 *
 * transport 只 reply 此对象，不再做 schema 塑形。
 * commands 目前固定为空数组（pi 侧命令发现另走 getCommands）。
 */
export interface BridgeSyncPayload {
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  commands: Array<{ name: string }>
  success: true
}

// ── Bridge 类型（插件 Worker ↔ 主进程桥接）─────────────────────────

/** Bridge 连接状态 */
export interface BridgeState {
  pluginId: string
  connected: boolean
  lastSyncAt: number
}

/** 插件向主进程同步工具和 hooks 的请求 */
export interface BridgeSyncRequest {
  type: 'bridge.sync'
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  hooks: HookType[]
}

/** 主进程响应 Bridge 同步的结果 */
export interface BridgeSyncResponse {
  success: boolean
  registeredTools: string[]
  registeredHooks: HookType[]
}

/** 主进程调用插件注册的工具 */
export interface BridgeToolExecuteRequest {
  type: 'bridge.tool.execute'
  toolName: string
  parameters: Record<string, unknown>
  sessionId?: string
  toolCallId?: string
}

/** 插件返回工具执行结果 */
export interface BridgeToolExecuteResponse {
  content: string
  isError?: boolean
}

/** Worker 侧 tool 执行处理函数 */
export type ToolExecuteHandler = (params: {
  arguments: Record<string, unknown>
  sessionId?: string
  toolCallId?: string
}) => Promise<BridgeToolExecuteResponse>

// ── Phase 2: Tool 类型 ──────────────────────────────────────────────

/** 工具注册请求（插件通过 api.tools.register() 提交） */
export interface ToolRegistration {
  name: string
  description: string
  parameters: Record<string, unknown>
  /** Worker 侧本地执行 handler，在 createToolApi 注册时存储 */
  execute?: ToolExecuteHandler
}

/** 工具注册表中存储的条目（主线程侧） */
export interface ToolEntry {
  pluginId: string
  handlerId: string
  schema: ToolRegistration
}

// ── Phase 2: Hook 注册表条目 ──────────────────────────────────────────

/** Status bar item options for plugin API */
export interface StatusBarItemOptions {
  tooltip?: string
  commandId?: string
  priority?: number
  scope?: 'per-session' | 'global'
  sessionId?: string
}

/** Hook 注册表中存储的条目（主线程侧） */
export interface HookEntry {
  pluginId: string
  handlerId: string
  priority: number
}

// HookInterceptor / HookObserver / PiEventCallback 已拆分到
// ./plugin-types/hook-types.ts，下方 re-export 块统一导出。

// ── Phase 2 AgentAPI（在 Phase 1 基础上增加 tools 和 hooks）─────────

/** Phase 2 AgentAPI，扩展 Phase 1 增加 tools、hooks 和 extended API 代理对象 */
export interface Phase2AgentAPI extends Phase1AgentAPI {
  readonly tools: {
    register(registration: ToolRegistration): Promise<string>
    unregister(toolKey: string): Promise<void>
  }
  readonly hooks: {
    onBeforeSendMessage(handler: HookInterceptor): Promise<Disposable>
    onBeforeToolCall(handler: HookInterceptor): Promise<Disposable>
    onBeforeAgentStart(handler: HookInterceptor): Promise<Disposable>
    onAfterToolResult(handler: HookObserver): Promise<Disposable>
    onPiEvent(eventName: string, handler: PiEventCallback): Promise<Disposable>
  }
  readonly config: {
    get(key: string): Promise<unknown>
    getAll(): Promise<Record<string, unknown>>
    set(key: string, value: unknown): Promise<void>
  }
  readonly sessionData: {
    get(sessionId: string, key: string): Promise<unknown>
    set(sessionId: string, key: string, value: unknown): Promise<void>
    delete(sessionId: string, key: string): Promise<void>
    keys(sessionId: string): Promise<string[]>
  }
  readonly ui: {
    showSelect(title: string, options: string[]): Promise<string | undefined>
    showConfirm(title: string, message: string): Promise<boolean>
    showInput(title: string, defaultValue?: string): Promise<string | undefined>
    notify(level: 'info' | 'warn' | 'error', message: string): Promise<void>
    updateStatusBarItem(id: string, text: string, options?: StatusBarItemOptions): Promise<void>
  }
  readonly agent: {
    setModel(model: string): Promise<void>
    getModel(): Promise<string>
    getThinkingLevel(): Promise<string>
    setThinkingLevel(level: string): Promise<void>
    getActiveTools(): Promise<string[]>
  }
  readonly workspace: {
    readonly rootPath: string
    readonly name: string
    findFiles(pattern: string): Promise<string[]>
  }
}

// ── Hook 域 ───────────────────────────────────────────────────────
// 已拆分到 ./plugin-types/hook-types.ts。此处 re-export 保持
// 现有 `from './plugin-types.js'` 导入不破坏（NON-BREAKING）。
export type {
  InterceptorHookType,
  ObserverHookType,
  HookType,
  InterceptorResult,
  HookContext,
  HookInterceptor,
  HookObserver,
  HookResult,
  HookBlockedResult,
  PiEventCallback,
} from './plugin-types/hook-types.js'

// ── PluginService 依赖注入 ──────────────────────────────────────────

/** PluginService 外部依赖，构造时可选注入 */
export interface IPluginServiceDeps {
  sessionService?: ISessionService
  configService?: IConfigService
  modelService?: import('../../interfaces.js').IModelService
  broadcastFn?: (type: string, payload: unknown) => void
  /** xyz-agent 配置根目录（~/.xyz-agent/）。注入后 plugin 切片不再直连 infra 取路径。 */
  configDir?: string
}

/** 插件向后端请求前端 UI 弹窗 */
export interface PluginUIRequest {
  sessionId: string
  requestId: string
  method: 'confirm' | 'select' | 'input'
  title: string
  message?: string
  options?: string[]
}
