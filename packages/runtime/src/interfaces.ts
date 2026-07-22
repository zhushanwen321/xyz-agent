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
  PluginInfo,
  GitStatusResult,
  FileNode,
  SubagentRecord,
  WorkflowRunRecord,
  SystemPromptConfig,
} from '@xyz-agent/shared'
import type { IPiEngine, PiEventListener } from './services/ports/pi-engine.js'

/**
 * pi 引擎 / 进程池 port 的权威定义在 services/ports/pi-engine.ts（D24 收口）。
 *
 * 历史上 IRpcClient（engine 的重复定义）与 IProcessManager 都在本文件，
 * 现已迁移到 ports/。此处仅 re-export，保留 interfaces.ts 作为「跨服务 facade
 * 契约」入口的同时，避免下游大量 import 改动一次性断裂。新代码请直接从
 * services/ports/pi-engine.js 导入。
 *
 * @deprecated 从 services/ports/pi-engine.js 导入 IPiEngine / IProcessManager。
 */
export type { IPiEngine, IProcessManager } from './services/ports/pi-engine.js'
/**
 * IRpcClient 是 IPiEngine 的兼容别名（D24 合并遗留）。
 * @deprecated 改用 IPiEngine（见 services/ports/pi-engine.js）。
 */
export type IRpcClient = IPiEngine

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
  /** D10/P0-B: 第 5 参数从 sessionId(string) 改为 details(ErrorDetails)，sessionId 进 details.sessionId。 */
  sendError(ws: unknown, code: string, message: string, id?: string, details?: { sessionId?: string; [key: string]: unknown }): void
}

// ── IEventAdapter ─────────────────────────────────────────────────

/** Translates pi RPC events into WS protocol ServerMessages. */
export interface IEventAdapter {
  attach(client: { onEvent: (listener: PiEventListener) => (() => void) }): void
  detach(): void
}

// ── ISessionService ───────────────────────────────────────────────

/** Session create 选项（SessionService.create / SessionLifecycle.create 共用）。 */
export interface SessionCreateOptions {
  /**
   * 隐藏 session（公共 session）：scanner listAll 过滤，不进 sidebar 列表。
   * 用于 landing 态命令源等内部场景。
   */
  hidden?: boolean
}

/** Session lifecycle: creation, deletion, messaging, history. */
export interface ISessionService {
  create(cwd?: string, label?: string, options?: SessionCreateOptions): Promise<SessionSummary>
  delete(sessionId: string): Promise<void>
  renameSession(sessionId: string, newName: string): Promise<void>
  sendMessage(sessionId: string, content: string): Promise<{ blocked: boolean; rejected?: boolean }>
  sendSubagentMessage(sessionId: string, agent: string, task: string, content?: string): Promise<{ blocked: boolean; rejected?: boolean }>
  abort(sessionId: string): Promise<void>
  switchModel(sessionId: string, provider: string, modelId: string): Promise<string>
  compact(sessionId: string, customInstructions?: string): Promise<void>
  getHistory(sessionId: string): Promise<{ messages: Message[]; truncated: boolean }>
  /**
   * 获取 session 全量历史（直读 JSONL 文件，不截断）。
   * 与 getHistory 的区别：getHistory 优先走 RPC（pi client.getHistory），文件路径 fallback 截断尾读；
   * getFullHistory 直接全量读文件，供前端「加载更多历史」按钮调用（FR-4）。
   */
  getFullHistory(sessionId: string): Promise<Message[]>
  /**
   * 获取 session 派生的 subagent 列表（从主 session JSONL 的 subagent toolCall/toolResult 提取）。
   * 纯磁盘读取，不依赖 pi 进程活跃。文件不存在或无 subagent 调用时返回空数组。
   */
  getSubagents(sessionId: string): Promise<SubagentRecord[]>
  /**
   * 获取 subagent 的对话流历史（直读 subagent JSONL，复用 convertPiHistory 转换）。
   * subagentId 对应 SubagentRecord.subagentId，从 getSubagents 结果中查找 sessionFile 路径。
   */
  getSubagentHistory(sessionId: string, subagentId: string): Promise<Message[]>
  /**
   * 获取 session 派生的 workflow 列表（从主 session JSONL 的 workflow-state-link 提取）。
   * 纯磁盘读取，不依赖 pi 进程活跃。文件不存在或无 workflow 调用时返回空数组。
   */
  getWorkflows(sessionId: string): Promise<WorkflowRunRecord[]>
  /**
   * 获取 workflow 内 agent call 的对话流历史。
   * agentCallSessionId 是 trace[].sessionId（pi session ID），按 sessionId 全局查找 JSONL。
   */
  getAgentCallHistory(sessionId: string, agentCallSessionId: string): Promise<Message[]>
  /**
   * 解析 agent call 对话流 JSONL 绝对路径（与 getAgentCallHistory 共用 findAgentCallFile）。
   * 找不到返回空串（展示型功能，不 throw）。
   */
  getAgentCallFilePath(sessionId: string, agentCallSessionId: string): Promise<string>
  /** 触发 workflow 生命周期操作（pause/resume/abort，经扩展 slash command，不经 LLM） */
  workflowAction(sessionId: string, action: 'pause' | 'resume' | 'abort', runId: string): Promise<void>
  /** 取消 running subagent（经扩展 /subagents cancel，不经 LLM；对称 workflowAction） */
  subagentAction(sessionId: string, action: 'cancel', subagentId: string): Promise<void>
  /** 查询 session 的扩展命令（pi getCommands）。纯查询无副作用，用于 renderer 主动拉取。 */
  getCommands(sessionId: string): Promise<Array<{ name: string; description?: string; source: string }>>
  /**
   * 拉取 session 上下文用量（pi getSessionStats → contextUsage）。
   * contextUsage.tokens=null（compaction 后未跑新 turn）或 session 未激活时返回 null。
   * 用于 renderer 切 session 后主动拉取（修复 broadcast 与订阅时序竞争）。
   */
  fetchContext(sessionId: string): Promise<{ inputTokens: number; contextLimit: number; usagePercent: number } | null>
  /** 活跃 session id 列表（含公共 session）。供 SkillRegistry 计算 skill 变更广播的 affectedSessionIds。 */
  getActiveSessionIds(): string[]
  /** 取 session 的 cwd（未激活/不存在返回 undefined）。供 SkillRegistry 按项目 skill 变更定位受影响 session。 */
  getSessionCwd(sessionId: string): string | undefined
  restoreSession(sessionId: string): Promise<SessionSummary>
  /**
   * Fork session：从 srcSessionId 截断到 fromPiEntryId，创建新 session（独立 pi 进程）。
   * runtime 读源 JSONL 按树回溯截断，写新文件后 switch_session 加载。源 session 不受影响。
   */
  forkSession(
    srcSessionId: string,
    fromPiEntryId: string | undefined,
    includeFrom: boolean,
    label?: string,
    opts?: { fromMessageTimestamp?: number; fromMessageRole?: string },
  ): Promise<SessionSummary>
  hasActiveSession(sessionId: string): boolean
  getSummary(sessionId: string): SessionSummary | undefined
  /** 取 session 缓存的最近 inputTokens（供 model.switch 重算 usagePercent，见 onContextUpdate/handleTurnEndSideEffects） */
  getInputTokens(sessionId: string): number
  /** 回写 session 缓存的 inputTokens（onContextUpdate 拿到真实值后同步写入，打通 context.update 与 state_changed 数据源） */
  setInputTokens(sessionId: string, tokens: number): void
  /**
   * 处理 context.update（pi agent_end/turn_end 推 inputTokens + totalTokens）。session 级状态单一 owner：
   * 回写 inputTokens 缓存 + 写 tokenCount + 算 usagePercent + 广播 context.update。
   * index.ts onContextUpdate 仅调本方法。totalTokens（W3）写入 session.tokenCount。
   */
  applyContextUpdate(sessionId: string, inputTokens: number, totalTokens?: number): void
  /** 取 session 当前 usagePercent（按缓存 inputTokens + 当前 modelId contextWindow 算）。 */
  getUsagePercent(sessionId: string): number
  /** 仅回写 thinkingLevel 缓存（不调 pi RPC），供 thinking_level_changed 事件 callback 用 */
  setThinkingLevelCache(sessionId: string, level: string | undefined): void
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
// R5：已迁移到 services/session/session-internal.ts（session 域内部契约收归 session 目录）。
// 此处 re-export 保持向后兼容，新代码请从 services/session/session-internal.js 导入。
export type { ISessionServiceInternal } from './services/session/session-internal.js'

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
    models?: Array<string | { id: string; name?: string; contextWindow?: number; input?: Array<'text' | 'image'>; thinkingLevelMap?: Record<string, string | null> }>
    enabled?: boolean
  }): { newDefault?: { provider: string; modelId: string } }
  deleteProvider(providerId: string): { removed: boolean; newDefault?: { provider: string; modelId: string } }
  getProvider(providerId: string): { apiKey?: string; name?: string; type?: string; baseUrl?: string; models?: unknown[]; enabled?: boolean } | undefined
  updateToolPermissions(permissions: Record<string, string>): void
  // ── Skill/Agent 加载路径（ADR-0020 §1 discovery.json SSOT）──
  /** 覆盖 skillDirs（有序数组 = 优先级，靠前覆盖靠后）。写 discovery.json + 投影 settings.json。 */
  setSkillDirs(dirs: string[]): void
  /** 读取 skillDirs（有序数组）。 */
  getSkillDirs(): string[]
  /** 覆盖 agentDirs（有序数组 = 优先级，靠前覆盖靠后）。写 discovery.json。 */
  setAgentDirs(dirs: string[]): void
  /** 读取 agentDirs（有序数组）。 */
  getAgentDirs(): string[]
  /** 一次性迁移：settings.json.skills → discovery.json（首启用，幂等）。 */
  migrateSettingsSkillsToDiscovery(): void
  loadSkills(projectRoot: string): SkillInfo[]
  saveSkills(projectRoot: string, skills: SkillInfo[]): void
  /** @deprecated ADR-0020 §5：目录级管道模型，无文件级 CRUD。保留为兼容 no-op。 */
  upsertSkill(skill: SkillInfo): void
  /** @deprecated ADR-0020 §5：目录级管道模型，无文件级 CRUD。保留为兼容 no-op。 */
  deleteSkill(skillId: string): void
  loadAgents(projectRoot: string): AgentInfo[]
  saveAgents(projectRoot: string, agents: AgentInfo[]): void
  /** @deprecated ADR-0020 §5：目录级管道模型，无文件级 CRUD。保留为兼容 no-op。 */
  upsertAgent(agent: AgentInfo): void
  /** @deprecated ADR-0020 §5：目录级管道模型，无文件级 CRUD。保留为兼容 no-op。 */
  deleteAgent(agentId: string): void
  scanSkills(sources: string[], existingIds: Set<string>): ScannedSkillInfo[]
  scanAgents(sources: string[], existingIds: Set<string>): ScannedAgentInfo[]
  /** pi agent 配置目录（settings.json/agents/skills 所在地）。 */
  getPiAgentDir(): string
  /** xyz-agent 配置根目录（~/.xyz-agent/，plugins/session-data 所在地）。 */
  getConfigDir(): string
  // ── System prompt config（FR-6/FR-7，ADR-0038）──
  /** 读取 system-prompt.json。损坏时 corrupted=true 且返回默认配置。 */
  getSystemPromptConfig(): { config: SystemPromptConfig; corrupted: boolean }
  /** 写入 system-prompt.json。replace.prompt 超长（>SYSTEM_PROMPT_MAX_LENGTH）返回 ok:false + error，不写盘。 */
  setSystemPromptConfig(config: SystemPromptConfig): { ok: boolean; error?: string }
  /** 返回当前生效的替换提示词（replace.enabled && prompt 非空白时），否则 undefined。rpc-client spawn 时透传。 */
  getReplaceSystemPrompt(): string | undefined
}

// ── IExtensionService ──────────────────────────────────────────────

/** Extension lifecycle: discovery, enable/disable, install/uninstall, path resolution. */
export interface IExtensionService {
  scanExtensions(): Promise<import('@xyz-agent/shared').ExtensionInfo[]>
  /** 推荐扩展列表（含已安装状态，前端 Settings 快捷安装按钮数据源） */
  getRecommendedExtensions(): Promise<Array<{ name: string; description: string; installed: boolean }>>
  toggleExtension(name: string, enabled: boolean): Promise<void>
  /** 升级单个 user-installed 扩展到 npm latest 版本（已是最新则 upgraded=false）。 */
  upgradeExtension(name: string): Promise<{ upgraded: boolean; from: string; to: string }>
  /** 开关某扩展的启动期自动升级。 */
  setAutoUpgrade(name: string, autoUpgrade: boolean): Promise<void>
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
  /**
   * 已发现插件列表，按 WS 协议契约返回 PluginInfo[]（config.plugins）。
   *
   * 内部 PluginDescriptor（含 main/activationEvents/contributes 等私有字段）由
   * PluginRegistry.getDescriptor/getAllDescriptors 暴露给 service 内部协作；
   * 对 transport 仅暴露协议类型，避免内部类型外泄。
   */
  getDiscoveredPlugins(): PluginInfo[]
  togglePlugin(pluginId: string, enabled: boolean): Promise<PluginInfo[]>
  shutdown(): Promise<void>

  /** Uninstall a plugin: deactivate, remove files, rescan registry */
  uninstallPlugin(pluginId: string): Promise<PluginInfo[]>
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
  installPlugin(packageSpecifier: string): Promise<import('./services/ports/plugin-installer.js').InstallResult>
  getToolSchemas?(): import('./services/plugin-service/plugin-types.js').ToolRegistration[]
  /** 构造 bridge:sync 同步负载（工具 schema 塑形下沉 service，transport 只 reply） */
  getBridgeSyncPayload?(): import('./services/plugin-service/plugin-types.js').BridgeSyncPayload
  handleBridgeToolExecute?(request: import('./services/plugin-service/plugin-types.js').BridgeToolExecuteRequest): Promise<import('./services/plugin-service/plugin-types.js').BridgeToolExecuteResponse>
  handleBridgeEvent?(eventName: string, data: unknown, sessionId: string): void
  handleBridgeIntercept?(eventName: string, data: Record<string, unknown>, sessionId: string): Promise<import('./services/plugin-service/plugin-types.js').BridgeInterceptResponse>
}

// ── IGitService ───────────────────────────────────────────────────

/**
 * Git 域 service port（与 ISessionService / IExtensionService 对称的 DI seam）。
 * GitMessageHandler 经此接口依赖 git 能力，不直接 import 具体的 GitService 类。
 * 方法签名与 GitService（services/git-service.ts）逐字对齐——行为保持不变。
 */
export interface IGitService {
  getStatus(sessionId: string): Promise<GitStatusResult>
  getFileDiff(sessionId: string, path: string): Promise<{ patch: string; binary: boolean }>
  stage(sessionId: string, filePaths?: string[]): Promise<void>
  unstage(sessionId: string, filePaths?: string[]): Promise<void>
  commit(sessionId: string, message?: string): Promise<void>
  checkout(sessionId: string, name: string): Promise<void>
  createBranch(sessionId: string, name: string): Promise<void>
}

// ── IFileService ──────────────────────────────────────────────────

/**
 * 文件树编排 service port（与 ISessionService / IExtensionService 对称的 DI seam）。
 * FileMessageHandler 经此接口依赖文件树能力，不直接 import 具体的 FileService 类。
 * 方法签名与 FileService（services/file-service.ts）逐字对齐——行为保持不变。
 */
export interface IFileService {
  listTree(sessionId: string): Promise<FileNode[]>
  expandDir(sessionId: string, path: string): Promise<FileNode[]>
  searchFiles(sessionId: string, showIgnored?: boolean): Promise<FileNode[]>
  readFile(sessionId: string, path: string): Promise<{ content: string; truncated: boolean }>
  readFileFromWhitelist(path: string): Promise<{ content: string; truncated: boolean }>
  createFile(sessionId: string, path: string, content: string): Promise<never>
  renameFile(sessionId: string, oldPath: string, newPath: string): Promise<never>
  deleteFile(sessionId: string, path: string): Promise<never>
}
