/**
 * Dependency Injection interfaces for the Service layer.
 *
 * These interfaces decouple the Transport layer (server.ts) from
 * concrete implementations, enabling independent testing and
 * future swaps of business logic modules.
 */
import type {
  ServerMessage,
  SessionSummary,
  SessionGroup,
  Message,
  ProviderInfo,
  ModelInfo,
  SkillInfo,
  AgentInfo,
  ScannedSkillInfo,
  ScannedAgentInfo,
} from '@xyz-agent/shared'
import type { PiEventListener } from './services/ports/pi-engine.js'
import type { IManagedSessionView, ScannedSession } from './services/session/types.js'

// ── IRpcClient ────────────────────────────────────────────────────

/** pi subprocess RPC client — high-level command API. */
export interface IRpcClient {
  prompt(content: string): Promise<unknown>
  abort(): Promise<unknown>
  setModel(provider: string, modelId: string): Promise<unknown>
  getHistory(): Promise<unknown>
  compact(): Promise<unknown>
  clear(): Promise<unknown>
  sendCommand(type: string, params?: Record<string, unknown>, timeout?: number): Promise<unknown>
  getCommands(): Promise<unknown>
  onEvent(listener: PiEventListener): () => void
  onExit(callback: (code: number | null) => void): void
  readonly exited: boolean
  kill(): Promise<void>
  start(): Promise<void>
  setThinkingLevel(level: string): Promise<unknown>
  steer(content: string): Promise<unknown>
  followUp(content: string): Promise<unknown>
}

// ── IProcessManager ───────────────────────────────────────────────

/** pi subprocess lifecycle manager. */
export interface IProcessManager {
  createSession(sessionId: string, cwd: string, options?: {
    cwd?: string
    provider?: string
    model?: string
    env?: Record<string, string>
    skillPaths?: string[]
    extensionPaths?: string[]
    piCommand?: string
  }): Promise<IRpcClient>
  destroySession(sessionId: string): Promise<void>
  getClient(sessionId: string): IRpcClient | undefined
  getSessionIdByClient(client: IRpcClient): string | undefined
  hasClient(sessionId: string): boolean
  rekey(oldId: string, newId: string): void
  onSessionExit(callback: (sessionId: string, code: number | null) => void): void
  destroyAll(): Promise<void>
}

// ── IMessageBroker ────────────────────────────────────────────────

/**
 * Transport-layer message broker.
 *
 * Uses `unknown` for the WebSocket parameter to avoid coupling
 * the Service layer to the `ws` module.
 */
export interface IMessageBroker {
  send(ws: unknown, msg: ServerMessage): void
  broadcast(msg: ServerMessage): void
  sendError(ws: unknown, code: string, message: string, id?: string, sessionId?: string): void
}

// ── IEventAdapter ─────────────────────────────────────────────────

/** Translates pi RPC events into WS protocol ServerMessages. */
export interface IEventAdapter {
  attach(client: { onEvent: (listener: PiEventListener) => (() => void) }): void
  detach(): void
}

// ── ISessionService ───────────────────────────────────────────────

/** Session lifecycle: creation, deletion, messaging, history. */
export interface ISessionService {
  create(cwd?: string, label?: string): Promise<SessionSummary>
  delete(sessionId: string): Promise<void>
  renameSession(sessionId: string, newName: string): Promise<void>
  sendMessage(sessionId: string, content: string): Promise<void>
  sendSubagentMessage(sessionId: string, agent: string, task: string, content?: string): Promise<void>
  abort(sessionId: string): Promise<void>
  switchModel(sessionId: string, provider: string, modelId: string): Promise<string>
  compact(sessionId: string): Promise<void>
  getHistory(sessionId: string): Promise<Message[]>
  restoreSession(sessionId: string): Promise<SessionSummary>
  /** Fork 后重新绑定 session（更新 runtime 和 process manager 的 key） */
  rebindAfterFork(oldSessionId: string, newSessionId: string, label: string, sessionFilePath?: string): Promise<void>
  hasActiveSession(sessionId: string): boolean
  getSummary(sessionId: string): SessionSummary | undefined
  /** Get the underlying RpcClient for direct command sending (e.g., extension responses). */
  getRpcClient(sessionId: string): IRpcClient | undefined

  /**
   * Ensure a session is active (has a running pi process). If not, auto-restore it.
   * @returns The active RpcClient
   * @throws if restore fails or session not found
   */
  ensureActive(sessionId: string): Promise<IRpcClient>

  listPersistedSessions(): SessionGroup[]
  destroyAll(): Promise<void>

  /** 注册 onBeforeSendMessage hook，由 PluginService 调用 */
  setSendMessageHook(hook: (sessionId: string, content: string) => Promise<{ blocked: boolean; reason?: string } | null>): void
  /** Set thinking level for a session's pi subprocess */
  setThinkingLevel(sessionId: string, level: string): Promise<void>
  /** Steer an actively generating session */
  steerMessage(sessionId: string, content: string): Promise<void>
  /** Queue a follow-up message for a session */
  followUpMessage(sessionId: string, content: string): Promise<void>
}

// ── ISessionServiceInternal ───────────────────────────────────────

/**
 * Facade 暴露给 session/ 子模块(lifecycle / dispatcher / scanner)的内部协议。
 *
 * 放在 interfaces.ts(独立文件)而非 session-service.ts,是为了打断模块级循环:
 * 子模块 `import type { ISessionServiceInternal } from '../../interfaces.js'`,
 * Facade `implements` 此接口 —— 子模块 → 接口 → Facade 单向,无 import 环。
 * (运行期 Facade 调子模块、子模块经接口回调 Facade 是调用环,非依赖环。)
 *
 * sessions Map 单写者:Facade 唯一持有,子模块只经此接口拿到元素引用做字段更新,
 * 不直接 new / 持有 Map。
 */
export interface ISessionServiceInternal {
  // ── lifecycle 使用的共享 helper ──
  /** 初始化 ManagedSession 并写入 sessions Map,返回子模块可见视图。 */
  initializeManagedSession(id: string, client: IRpcClient, cwd: string, label: string, sessionFilePath?: string): Promise<IManagedSessionView>
  /** Detach adapter + 退订 usage listener(按 id 查 Map)。 */
  detachSession(sessionId: string): void
  /** 将 ManagedSession 转为对外 SessionSummary(含 git 信息)。 */
  toSummary(s: IManagedSessionView): SessionSummary
  /** 从 scanPiSessions 结果中按 id 查找持久化 session。 */
  findScannedSession(sessionId: string): ScannedSession | undefined
  /** 收集有效的 skill 路径(pi-config-bridge + 存在性过滤)。 */
  getSkillPaths(cwd: string): string[]
  /** 收集有效的 extension 路径(经 ExtensionService)。 */
  getExtensionPaths(): Promise<string[]>

  // ── dispatcher 使用 ──
  /** 确保会话活跃,必要时自动 restore。 */
  ensureActive(sessionId: string): Promise<IRpcClient>
  /** 按 RPC client 反查 managed session(更新 lastActiveAt / isGenerating 用)。 */
  getSessionByClient(client: IRpcClient): IManagedSessionView | undefined

  // ── lifecycle 使用(Map 单写者:查/删经 Facade)──
  /** 只读查 Map,返回 managed session 视图(active 判定 + 字段读改)。 */
  getSession(sessionId: string): IManagedSessionView | undefined
  /** 从 Map 删除条目(仅删条目,不 detach adapter / 不 destroy 进程)。 */
  removeSessionEntry(sessionId: string): void

  // ── scanner 使用 ──
  /** 当前活跃会话的 summary 列表(已含 git 信息)。 */
  getActiveSummaries(): SessionSummary[]
  /** 当前活跃会话占用的 session 文件路径集合(去重用)。 */
  getActiveFilePaths(): Set<string>
}

// ── IConfigService ────────────────────────────────────────────────

/** Provider / Skill / Agent CRUD and tool permissions. */
export interface IConfigService {
  listProviders(): ProviderInfo[]
  getDefaultModel(): { provider: string; modelId: string } | null
  setDefaultModel(provider: string, modelId: string): void
  setProvider(providerId: string, data: {
    name?: string
    type?: string
    apiKey?: string
    baseUrl?: string
    models?: Array<string | { id: string; name?: string; contextWindow?: number }>
    enabled?: boolean
  }): { newDefault?: { provider: string; modelId: string } }
  deleteProvider(providerId: string): { removed: boolean; newDefault?: { provider: string; modelId: string } }
  getProvider(providerId: string): { apiKey?: string; name?: string; type?: string; baseUrl?: string; models?: unknown[]; enabled?: boolean } | undefined
  updateToolPermissions(permissions: Record<string, string>): void
  loadSkills(projectRoot: string): SkillInfo[]
  saveSkills(projectRoot: string, skills: SkillInfo[]): void
  upsertSkill(skill: SkillInfo): void
  deleteSkill(skillId: string): void
  loadAgents(projectRoot: string): AgentInfo[]
  saveAgents(projectRoot: string, agents: AgentInfo[]): void
  upsertAgent(agent: AgentInfo): void
  deleteAgent(agentId: string): void
  scanSkills(sources: string[], existingIds: Set<string>): ScannedSkillInfo[]
  scanAgents(sources: string[], existingIds: Set<string>): ScannedAgentInfo[]
  /** pi agent 配置目录（settings.json/agents/skills 所在地）。 */
  getPiAgentDir(): string
  /** xyz-agent 配置根目录（~/.xyz-agent/，plugins/session-data 所在地）。 */
  getConfigDir(): string
}

// ── IExtensionService ──────────────────────────────────────────────

/** Extension lifecycle: discovery, enable/disable, install/uninstall, path resolution. */
export interface IExtensionService {
  scanExtensions(): Promise<import('@xyz-agent/shared').ExtensionInfo[]>
  toggleExtension(name: string, enabled: boolean): Promise<void>
  getExtensionPaths(): Promise<string[]>
  installExtension(source: string): Promise<void>
  uninstallExtension(name: string): Promise<void>
  installLocalDirectory(sourcePath: string): Promise<{ tempDir: string; candidates: import('@xyz-agent/shared').ExtensionInfo[] }>
  installGitRepository(url: string): Promise<{ tempDir: string; candidates: import('@xyz-agent/shared').ExtensionInfo[] }>
  finishInstall(tempDir: string, selected: string[]): Promise<void>
  cancelInstall(tempDir: string): Promise<void>
}

// ── IModelService ─────────────────────────────────────────────────

/** Model aggregation, API discovery, and model/thinking-level orchestration. */
export interface IModelService {
  aggregateModels(providers: ProviderInfo[]): ModelInfo[]
  discoverModelsFromApi(
    baseUrl: string,
    apiKey?: string,
    providerType?: string,
  ): Promise<Array<{ id: string; name: string; contextWindow?: number }>>

  /** Switch model with full side-effects: pi RPC + persist default + broadcast. */
  switchModel(sessionId: string, provider: string, modelId: string): Promise<void>

  /** Set thinking level for a session's pi subprocess. */
  setThinkingLevel(sessionId: string, level: string): Promise<void>
}

// ── IPluginService ────────────────────────────────────────────────

/** Plugin lifecycle: discovery, activation, deactivation, shutdown. */
export interface IPluginService {
  initialize(): Promise<void>
  getDiscoveredPlugins(): import('./services/plugin-service/plugin-types.js').PluginDescriptor[]
  togglePlugin(pluginId: string, enabled: boolean): Promise<import('./services/plugin-service/plugin-types.js').PluginDescriptor[]>
  shutdown(): Promise<void>

  /** Uninstall a plugin: deactivate, remove files, rescan registry */
  uninstallPlugin(pluginId: string): Promise<import('./services/plugin-service/plugin-types.js').PluginDescriptor[]>
  /** Approve specific permissions for a plugin */
  approvePermissions(pluginId: string, permissions: string[]): Promise<void>
  /** Revoke all permissions for a plugin */
  revokePermissions(pluginId: string): Promise<void>
  /** Execute a slash command contributed by a plugin */
  executeCommand(pluginId: string, commandId: string, args?: Record<string, unknown>): Promise<void>
  /** Get plugin config value(s) */
  getPluginConfig(pluginId: string, key?: string): Promise<unknown>
  /** Set a plugin config value */
  setPluginConfig(pluginId: string, key: string, value: unknown): Promise<void>
  /** Clear cached session data */
  clearSessionData(sessionId: string): void
  /** Handle UI response from frontend (confirm/select/input dialogs) */
  handleUiResponse(requestId: string, result: unknown): void

  /** Bridge routing methods */
  handleBridgeRequest?(method: string, payload: Record<string, unknown>, sessionId: string): Promise<unknown>

  /** Install a plugin from an npm package specifier */
  installPlugin(packageSpecifier: string): Promise<import('./services/plugin-service/plugin-installer.js').InstallResult>
  getToolSchemas?(): import('./services/plugin-service/plugin-types.js').ToolRegistration[]
  handleBridgeToolExecute?(request: import('./services/plugin-service/plugin-types.js').BridgeToolExecuteRequest): Promise<import('./services/plugin-service/plugin-types.js').BridgeToolExecuteResponse>
  handleBridgeEvent?(eventName: string, data: unknown, sessionId: string): void
  handleBridgeIntercept?(eventName: string, data: Record<string, unknown>, sessionId: string): Promise<import('./services/plugin-service/plugin-types.js').BridgeInterceptResponse>
}
