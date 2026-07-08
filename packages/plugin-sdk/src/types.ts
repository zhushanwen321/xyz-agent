
/**
 * 插件系统内部类型定义
 *
 * 这些类型仅用于 runtime（主进程/Worker）内部的插件管理，
 * 不出现在前端↔runtime 的共享协议中。
 */

// ── Manifest 类型（解析自 package.json 的 xyzAgent 字段）──────────

/** 插件来源：随应用分发的内置插件 或 用户安装的外部插件 */
export type PluginSource = 'built-in' | 'external'

export interface XyzAgentManifest {
  manifestVersion: 1
  main: string
  activationEvents: string[]
  trustLevel?: 'trusted' | 'sandbox'
  permissions?: string[]
  contributes?: PluginContributes
  /** 插件来源，由 registry 扫描时自动设置，manifest 中声明无效 */
  source?: PluginSource
  /** 该插件依赖的其他插件 ID 列表 */
  extensionDependencies?: string[]
}

export interface XyzAgentPackageJson {
  name: string
  version: string
  description?: string
  displayName?: string
  xyzAgent: XyzAgentManifest
  engines?: { 'xyz-agent'?: string }
}

// ── Descriptor（扫描后产出的完整描述）──────────────────────────

export interface PluginDescriptor {
  pluginId: string
  version: string
  displayName: string
  description: string
  main: string
  activationEvents: string[]
  trustLevel: 'trusted' | 'sandbox'
  status: PluginState
  contributes: PluginContributes
  permissions: string[]
  engines: { 'xyz-agent': string }
  pluginPath: string
  /** 插件来源：built-in（随应用分发）或 external（用户安装） */
  source: PluginSource
  /** 该插件依赖的其他插件 ID 列表 */
  extensionDependencies: string[]
  /** 版本不兼容时的错误描述 */
  compatibilityError?: string
}

export interface PluginContributes {
  slashCommands?: Array<{ name: string; description: string }>
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  hooks?: string[]
  panels?: Array<{ id: string; title: string; view: string }>
  statusBarItems?: Array<{ id: string; text: string; priority: number }>
}

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
  status: 'active' | 'idle' | 'error' | 'dead'
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

// ── RPC 类型 ─────────────────────────────────────────────────────

export interface RpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params: Record<string, unknown>
}

export interface RpcSuccessResponse {
  jsonrpc: '2.0'
  id: number
  result: unknown
}

export interface RpcErrorResponse {
  jsonrpc: '2.0'
  id: number
  error: { code: number; message: string; data?: unknown }
}

export type RpcResponse = RpcSuccessResponse | RpcErrorResponse

export interface RpcNotification {
  jsonrpc: '2.0'
  method: string
  params: Record<string, unknown>
}

export type RpcMessage = RpcRequest | RpcResponse | RpcNotification

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

// ── Error Codes ──────────────────────────────────────────────────

export const PluginRpcErrorCodes = {
  RPC_TIMEOUT: -32000,
  PERMISSION_DENIED: -32001,
  PLUGIN_NOT_FOUND: -32010,
  PLUGIN_NOT_ACTIVE: -32011,
  STORAGE_FULL: -32040,
  PAYLOAD_TOO_LARGE: -32021,
  METHOD_NOT_FOUND: -32601,
  INTERNAL_ERROR: -32603,
} as const

export type PluginRpcErrorCode = (typeof PluginRpcErrorCodes)[keyof typeof PluginRpcErrorCodes]

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

/** Hook 拦截器处理函数 — 可阻止或修改数据 */
export type HookInterceptor = (context: HookContext) => Promise<InterceptorResult>

/** Hook 观察者处理函数 — 只能读取数据 */
export type HookObserver = (context: HookContext) => Promise<void>

/** PiEvent 处理函数 */
export type PiEventCallback = (eventName: string, data: unknown) => Promise<void>

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

// ── Hook 类型（插件拦截/观察机制）────────────────────────────────────

/** 可拦截的 hook 类型，插件可阻止或修改数据 */
export type InterceptorHookType = 'onToolCall' | 'onSlashCommand' | 'onMessageSend' | 'onBeforeSendMessage' | 'onBeforeToolCall' | 'onBeforeAgentStart' | 'onAfterToolResult'

/** 只观察的 hook 类型，插件只能读取数据不能阻止 */
export type ObserverHookType = 'onMessage' | 'onSessionCreate' | 'onSessionDestroy'

/** 所有 hook 类型 */
export type HookType = InterceptorHookType | ObserverHookType

/** 拦截器返回结果：允许/阻止/修改数据 */
export interface InterceptorResult {
  proceed: boolean
  reason?: string
  modifiedData?: unknown
}

/** Hook 执行上下文 */
export interface HookContext {
  pluginId: string
  hookType: HookType
  data: unknown
  timestamp: number
  /** Phase 3: 从 event-adapter/index.ts 透传的额外上下文 */
  sessionId?: string
  content?: string
}

/** Hook 通用返回结果 */
export interface HookResult {
  blocked: boolean
  blockedBy?: string
  reason?: string
  transformedData?: unknown
}

/** Hook 被阻止时的详细结果 */
export interface HookBlockedResult extends HookResult {
  blocked: true
  reason: string
}

// ── PluginService 依赖注入 ──────────────────────────────────────────

/** PluginService 外部依赖，构造时可选注入 */
export interface IPluginServiceDeps {
  sessionService?: unknown
  configService?: unknown
  modelService?: unknown
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
