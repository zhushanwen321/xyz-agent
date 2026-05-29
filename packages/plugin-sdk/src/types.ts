/**
 * xyz-agent Plugin SDK — 公开类型定义
 *
 * 从 plugin-types.ts 提取的插件开发者可见类型。
 * 不 import 原文件，避免循环依赖。
 */

// ── 通用类型 ─────────────────────────────────────────────────────

export interface Disposable {
  dispose(): void
}

export type PluginPermission = string

export type PluginState =
  | 'UNLOADED'
  | 'LOADING'
  | 'ACTIVATING'
  | 'ACTIVE'
  | 'DEACTIVATING'
  | 'CRASHED'
  | 'DEPS_MISSING'

// ── Manifest 类型 ────────────────────────────────────────────────

export type PluginSource = 'built-in' | 'external'

export interface XyzAgentManifest {
  manifestVersion: 1
  main: string
  activationEvents: string[]
  trustLevel?: 'trusted' | 'sandbox'
  permissions?: string[]
  contributes?: PluginContributes
  source?: PluginSource
  extensionDependencies?: string[]
}

export interface PluginContributes {
  slashCommands?: Array<{ name: string; description: string }>
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  hooks?: string[]
  panels?: Array<{ id: string; title: string; view: string }>
  statusBarItems?: Array<{ id: string; text: string; priority: number }>
}

// ── Storage 类型 ─────────────────────────────────────────────────

export interface PluginStateStorage {
  get<T>(key: string): Promise<T | undefined>
  get<T>(key: string, defaultValue: T): Promise<T>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
}

// ── Session 类型 ─────────────────────────────────────────────────

export interface SessionInfo {
  id: string
  label: string
  cwd: string
  status: 'active' | 'idle' | 'error'
  createdAt: number
  lastActiveAt: number
}

// ── Hook 类型 ────────────────────────────────────────────────────

export type InterceptorHookType =
  | 'onToolCall'
  | 'onSlashCommand'
  | 'onMessageSend'
  | 'onBeforeSendMessage'
  | 'onBeforeToolCall'
  | 'onBeforeAgentStart'
  | 'onAfterToolResult'

export type ObserverHookType = 'onMessage' | 'onSessionCreate' | 'onSessionDestroy'

export type HookType = InterceptorHookType | ObserverHookType

export interface HookContext {
  pluginId: string
  hookType: HookType
  data: unknown
  timestamp: number
  sessionId?: string
  content?: string
}

export interface InterceptorResult {
  proceed: boolean
  reason?: string
  modifiedData?: unknown
}

export interface HookResult {
  blocked: boolean
  blockedBy?: string
  reason?: string
  transformedData?: unknown
}

export type HookInterceptor = (context: HookContext) => Promise<InterceptorResult>
export type HookObserver = (context: HookContext) => Promise<void>
export type PiEventCallback = (eventName: string, data: unknown) => Promise<void>

// ── Tool 类型 ────────────────────────────────────────────────────

export interface BridgeToolExecuteResponse {
  content: string
  isError?: boolean
}

export type ToolExecuteHandler = (params: {
  arguments: Record<string, unknown>
  sessionId?: string
  toolCallId?: string
}) => Promise<BridgeToolExecuteResponse>

export interface ToolRegistration {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute?: ToolExecuteHandler
}

// ── AgentAPI 类型 ────────────────────────────────────────────────

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
    updateStatusBarItem(id: string, text: string): Promise<void>
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

// ── Plugin Context & Module ──────────────────────────────────────

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
