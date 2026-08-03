/**
 * !! 此文件由 packages/plugin-sdk/scripts/sync-types.sh 自动生成 !!
 * !! 请勿手动编辑 —— 修改 runtime 的 plugin-types 后重跑 sync-types.sh  !!
 *
 * 来源（single source of truth）:
 *   packages/runtime/src/services/plugin-service/plugin-types.ts
 *   packages/runtime/src/services/plugin-service/plugin-types/{descriptor-types,rpc-protocol,hook-types}.ts
 *   packages/extension-protocol/src/core/types.ts（GuiComponent 渲染协议类型）
 *
 * 生成规则：
 *   - 拍平 runtime 主文件的 re-export shim + 3 个子域文件 + extension-protocol 协议类型 → 单个自包含文件
 *   - 剥离所有 import（SDK 保持零依赖，第三方插件作者无需装整个 monorepo）
 *   - runtime 内部 service 接口（ISessionService / IConfigService /
 *     IModelService / IPluginInstaller）替换为 `unknown`
 *   - 剥离不应进 SDK 的内部类型：IPluginServiceDeps（PluginService 构造参数）、
 *     BridgeSyncPayload（plugin-service 内部塑形对象）
 *
 * D28: 本文件刻意与 runtime 的 plugin-types 镜像而非 re-export，这是有意的跨包
 * 契约重复——sync 脚本是它的「真相源」，避免 SDK 引入对 @xyz-agent/runtime 的依赖。
 */

/**
 * GUI 渲染协议核心类型定义。
 *
 * GuiComponent 是 pi Component { render(width): string[] } 的可序列化镜像。
 * extension 按 ctx.mode 分支：TUI 走原生 Component，RPC 走 GuiComponent（放进 details.__gui__）。
 *
 * GuiComponentProps 是类型路由的聚合点：通用布局原语 + extension 专属组件
 * 全部在此声明键值，子类型直接内联本文件（纯类型，无运行时逻辑）。
 *
 * @see docs/architecture/extension-gui-protocol.md
 */

// ── 协议版本 ──

export const PROTOCOL_VERSION = 1 as const

// ── 核心：GuiComponent ──

/**
 * GUI 渲染组件——pi Component 的可序列化镜像。
 *
 * pi:  Component { render(width): string[] }   ← ANSI 文本行
 * gui: GuiComponent = { type, props }           ← 结构化数据
 */
export interface GuiComponent<T extends GuiComponentType = GuiComponentType> {
  /** 组件类型，前端按此路由到 Vue 组件 */
  type: T
  /** 组件 props，类型由 type 决定 */
  props: GuiComponentProps[T]
}

export type GuiComponentType = keyof GuiComponentProps

// ── 组件 props 映射（聚合点：通用原语 + extension 专属）──

export interface GuiComponentProps {
  /** ANSI 文本兜底——保留原始 ANSI 序列，前端用 ansi_up 渲染 */
  'ansi-text': {
    lines: string[]
  }

  // ── 布局原语（替代 TUI ASCII 布局）──

  /** 卡片容器——替代 TUI 的 ┌─┐││└─┘ box 边框 */
  'card': {
    variant?: 'default' | 'elevated' | 'danger' | 'success'
    header?: GuiComponent | string
    body: GuiComponent[]
  }

  /** 统计行——替代 TUI 的 "N turns · Nk · Ns" */
  'stats-line': {
    items: StatItem[]
  }

  /** 进度条——替代 TUI 的 ████░░░░ */
  'progress-bar': {
    label?: string
    current: number
    total: number
    unit?: string
    severity?: 'ok' | 'warn' | 'danger'
  }

  /** 列表树——替代 TUI 的 ⎿ ├─ └─ 缩进 */
  'list-tree': {
    items: TreeItem[]
  }

  /** 双列网格——替代 TUI 的 │ 列分隔 */
  'columns': {
    children: GuiComponent[]
    ratios?: number[]
  }

  /** 标签栏——替代 TUI 的 tab │ 分隔 */
  'tab-bar': {
    tabs: { label: string; active?: boolean; status?: 'done' | 'pending' }[]
  }

  /** 自定义组件——逃生口（仅限内置 extension 编译期注册） */
  'custom': {
    component: string
    props: Record<string, unknown>
  }
}

// ── tool result / message details 中 __gui__ 字段的完整类型 ──

export interface GuiRenderResult {
  /** 版本协商，前端检测，不认识降级 ansi-text */
  v: typeof PROTOCOL_VERSION
  component: GuiComponent
}

// ── 布局原语子类型 ──

export interface StatItem {
  label?: string
  value: string
  severity?: 'ok' | 'warn' | 'danger'
  icon?: string
}

export interface TreeItem {
  icon?: TreeItemIcon
  label: string
  status?: 'running' | 'done' | 'failed'
  depth?: number
  children?: TreeItem[]
}
export type TreeItemIcon = 'arrow' | 'check' | 'cross' | 'circle' | 'dot' | 'pause' | 'branch'

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
  views?: PluginContributesView[]
  menus?: PluginContributesMenu
  commands?: PluginContributesCommand[]
  configuration?: PluginContributesConfiguration
  statusBarItems?: PluginContributesStatusBarItem[]
}

/** schema v2：views 声明（panels 演进产物，placement 为开放字符串——挂载点由壳注册） */
export interface PluginContributesView {
  id: string
  title: string
  view?: string
  /** 挂载点名：'sidebar.tab' | 'panel.header' | 'composer.toolbar' | 'drawer.tab' | 'statusbar' 等，开放字符串（壳注册制） */
  placement: string
  viewType?: 'gui' | 'webview' | 'tree'
  activationEvent?: string
  initialVisibility?: 'visible' | 'hidden'
}

/** schema v2：menus 按挂载点名分组的命令菜单映射（VSCode contribution points 风格） */
export interface PluginContributesMenu {
  'composer.toolbar'?: PluginMenuItem[]
  'panel.header'?: PluginMenuItem[]
  'sidebar.footer'?: PluginMenuItem[]
}

export interface PluginMenuItem {
  command: string
  when?: string
  group?: string
}

/** schema v2：声明式命令表（与 api.commands.register 互补：声明提供元数据，register 提供 handler） */
export interface PluginContributesCommand {
  command: string
  title: string
  category?: string
  keybinding?: string
  when?: string
  icon?: string
}

/** schema v2：JSON Schema 子集（VSCode configuration 风格），驱动设置页表单 */
export interface PluginContributesConfiguration {
  title?: string
  properties: Record<string, PluginConfigurationProperty>
}

export interface PluginConfigurationProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object'
  default?: unknown
  description?: string
  enum?: unknown[]
  enumDescriptions?: string[]
}

/** schema v2：旧三字段（id/text/priority）原样保留保证向后兼容，扩展字段全 optional */
export interface PluginContributesStatusBarItem {
  id: string
  text: string
  priority: number
  alignment?: 'left' | 'right'
  scope?: 'per-session' | 'global'
  commandId?: string
  tooltip?: string
}

// ── RPC 线协议类型（Wire Protocol）────────────────────────────────────
//
// 本文件仅包含 RPC 层的线协议类型与错误码，无跨域依赖——是 plugin-types
// 拆分中最独立的一个域。

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

// ── Hook 类型（插件拦截/观察机制）────────────────────────────────────
//
// 本文件包含插件 hook 系统的全部类型：可拦截/可观察的 hook 类型、
// 拦截器/观察者处理函数、执行上下文与返回结果。无跨域依赖。

/** 可拦截的 hook 类型，插件可阻止或修改数据 */
export type InterceptorHookType =
  | 'onToolCall'
  | 'onSlashCommand'
  | 'onMessageSend'
  | 'onBeforeSendMessage'
  | 'onBeforeToolCall'
  | 'onBeforeAgentStart'
  | 'onAfterToolResult'

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

/** Hook 拦截器处理函数 — 可阻止或修改数据 */
export type HookInterceptor = (context: HookContext) => Promise<InterceptorResult>

/** Hook 观察者处理函数 — 只能读取数据 */
export type HookObserver = (context: HookContext) => Promise<void>

/** PiEvent 处理函数 */
export type PiEventCallback = (eventName: string, data: unknown) => Promise<void>

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

// 本文件内部仍引用以下「已拆分」域的类型（lifecycle/bridge/agent-api 等
// 内联类型用到了它们），故在此 import 以供本地使用；对外仍通过文件末尾的
// `export ... from` 重导出，保证 `from './plugin-types.js'` 不破坏。
/**
 * 插件系统内部类型定义
 *
 * 这些类型仅用于 runtime（主进程/Worker）内部的插件管理，
 * 不出现在前端↔runtime 的共享协议中。
 */

// ── Descriptor / Manifest 域 ───────────────────────────────────────
// 已拆分到 ./plugin-types/descriptor-types.ts。此处 re-export 保持
// 现有 `from './plugin-types.js'` 导入不破坏（NON-BREAKING）。
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
  // 与 shared/session.ts 的 SessionStatus 对齐（含 W4 新增的 'done'/'stopped' 终态）。
  status: 'active' | 'idle' | 'error' | 'dead' | 'done' | 'stopped'
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
  readonly commands: {
    register(
      command: { id: string; title?: string; category?: string; keybinding?: string; when?: string },
      handler: (args?: unknown) => unknown | Promise<unknown>,
    ): Promise<Disposable>
    unregister(commandId: string): Promise<void>
  }
  readonly views: {
    update(viewId: string, guiTree: GuiComponent[]): Promise<void>
    listMountPoints(): Promise<string[]>
  }
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
