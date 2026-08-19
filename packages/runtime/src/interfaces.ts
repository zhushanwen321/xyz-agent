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
  BuiltinProviderTemplate,
  ModelInfo,
  SkillInfo,
  AgentInfo,
  ScannedSkillInfo,
  ScannedAgentInfo,
  SourceDetectResult,
  ProviderSource,
  ProviderImportPreview,
  ProviderImportResult,
  PluginInfo,
  GitStatusResult,
  FileNode,
  SubagentRecord,
  WorkflowRunRecord,
  SystemPromptConfig,
  TerminalConfig,
  BatchDeleteResult,
  SegmentsMetadataEntry,
  SkillDirConfig,
  ProviderId,
} from '@xyz-agent/shared'
import type { DirScopes } from './services/skill-dir-config.js'
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
 *
 * wave:perf-w09（02 文档 D1-2 / ADR-0055 7d）：`broadcast` 退化为**纯全局通道**——
 * 只服务 payload 无 sessionId 的全局消息（config.*、app.info、plugin:statusBar*、
 * session.forkNotice、session.handoffComplete/handoffAborted 等，见 02 文档 D5-1 排除清单）。
 * session 级 push 型消息（payload 带 sessionId）一律走 `IMessageBus.publish`
 * （services/message-bus，seq/ring/snapshot + 只推订阅该 sid 的连接），双写已收口。
 */
export interface IMessageBroker {
  send(ws: unknown, msg: ServerMessage): void
  /** 纯全局通道：盲推所有连接。session 级消息禁止走此方法（见接口注释）。 */
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
  /** Launch preset id（设计文档 §4.1），绑定到新 session 并解析为 pi 启动参数。 */
  presetId?: string
  /**
   * Landing Model Chip 传入值，覆盖 preset.modelOverride。
   * 优先级（设计文档 §5.2）：Landing Chip > preset.modelOverride > 全局默认。
   */
  modelOverride?: string
  /**
   * Landing Thinking Chip 传入值，覆盖 preset.thinkingLevel。
   * 优先级（设计文档 §5.2）：Landing Chip > preset.thinkingLevel > 全局默认。
   */
  thinkingOverride?: string
  /** 归属 project id（D14 语义修正 2026-08-04）：创建时归属当前 activeProject；空 = 默认项目兑底。 */
  projectId?: string
}

/** Session lifecycle: creation, deletion, messaging, history. */
export interface ISessionService {
  create(cwd?: string, label?: string, options?: SessionCreateOptions): Promise<SessionSummary>
  delete(sessionId: string): Promise<void>
  deleteByCwd(cwd: string): Promise<BatchDeleteResult>
  renameSession(sessionId: string, newName: string): Promise<void>
  /** 手动归类（D14 语义修正 2026-08-04）：写 session 归属 project sidecar（空 = 归回默认项目）。 */
  setProject(sessionId: string, projectId: string): Promise<void>
  /**
   * 发送用户消息。
   *
   * images 透传给 pi prompt（message.send 的 images 字段，shared 形状 {data;base64;mimeType}）。
   * 类型组装（补 pi 私有 type:'image'）在 infra 层 RpcClient 内完成，本接口只暴露 shared 形状。
   * undefined 时不传 images，走原路径。
   */
  sendMessage(sessionId: string, content: string, images?: Array<{ data: string; mimeType: string }>): Promise<{ blocked: boolean; rejected?: boolean }>
  sendSubagentMessage(sessionId: string, agent: string, task: string, content?: string): Promise<{ blocked: boolean; rejected?: boolean }>
  abort(sessionId: string): Promise<void>
  /**
   * 直接执行 bash 命令（pi bash RPC，不经 LLM turn）。
   *
   * 返回语义与 sendMessage 对称：{ blocked: true, rejected?: true } 表示预检拒绝或执行失败。
   * excludeFromContext 透传给 pi bash RPC（控制是否进 LLM 上下文）。
   */
  sendBash(sessionId: string, command: string, excludeFromContext?: boolean): Promise<{ blocked: boolean; rejected?: boolean }>
  /** 取消进行中的 bash 执行（pi abort_bash）。 */
  abortBash(sessionId: string): Promise<void>
  switchModel(sessionId: string, provider: string, modelId: string): Promise<string>
  compact(sessionId: string, customInstructions?: string): Promise<void>
  getHistory(sessionId: string): Promise<{ messages: Message[]; truncated: boolean }>
  /**
   * 获取 session 全量历史（直读 JSONL 文件，不截断）。
   * 与 getHistory 的区别：getHistory 优先走 RPC（pi client.getEntries entry 树重建），文件路径 fallback 截断尾读；
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
   * 解析 agent call 对话流 JSONL 绝对路径（与 getAgentCallHistory 共用 _findAgentCallFile）。
   * 找不到返回空串（展示型功能，不 throw）。
   */
  getAgentCallFilePath(sessionId: string, agentCallSessionId: string): Promise<string>
  /** 触发 workflow 生命周期操作（pause/resume/abort，经扩展 slash command，不经 LLM） */
  workflowAction(sessionId: string, action: 'pause' | 'resume' | 'abort', runId: string): Promise<void>
  /** 取消 running subagent（经扩展 /subagents cancel，不经 LLM；对称 workflowAction） */
  subagentAction(sessionId: string, action: 'cancel', subagentId: string): Promise<void>
  /** W5：session 是否空闲（进程存活且非生成中），供 ReloadOrchestrator 判断立即/排队 reload。 */
  isSessionIdle(sessionId: string): boolean
  /** W5：session 是否仍存活（未被 delete），供 ReloadOrchestrator 检测排队期删除。 */
  hasSession(sessionId: string): boolean
  /** W5：发 `/__xyz_reload__` 触发 pi reload（builtin extension handler 调 ctx.reload）。 */
  promptReload(sessionId: string): Promise<void>
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
    opts?: {
      fromMessageTimestamp?: number
      fromMessageRole?: string
      /** Staging Mode（ADR-0056）：composer 暂存的模型覆盖，优先于源 preset.modelOverride。 */
      modelOverride?: string
      /** Staging Mode（ADR-0056）：composer 暂存的思考等级覆盖，优先于源 preset.thinkingLevel。 */
      thinkingOverride?: string
    },
  ): Promise<SessionSummary>
  hasActiveSession(sessionId: string): boolean
  getSummary(sessionId: string): SessionSummary | undefined
  /** W10：取最近 inputTokens——usage 实例快照派生（唯一数据源 = get_session_stats，旧缓存直写已删）。 */
  getInputTokens(sessionId: string): number
  /**
   * 处理 context.update（pi agent_end/turn_end 推 inputTokens + totalTokens）。session 级状态单一 owner：
   * 失效 usage 实例 + 即时广播 context.update（事件参数即时值 + resolver 窗口重算）。
   * index.ts onContextUpdate 仅调本方法。W10：事件参数不再直写 session 缓存
   * （totalTokens 与 inputTokens 同值，tokenCount 由 usage 实例快照派生）。
   */
  applyContextUpdate(sessionId: string, inputTokens: number, totalTokens?: number): void
  /** W10：取 session 当前 usagePercent——usage 实例快照派生（pi 权威 percent 投影）。 */
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

  /** 注册 onBeforeSendMessage hook，由 PluginService 调用（可阻止发送或改写内容） */
  setSendMessageHook(hook: (sessionId: string, content: string) => Promise<{ blocked: boolean; reason?: string; modifiedContent?: string } | null>): void
  /** S3-W2：注册 session 创建回调（PluginService 绑插件 session 事件注册表投递） */
  setOnSessionCreated(handler: (summary: SessionSummary) => void): void
  /** S3-W2：注册 session 销毁回调（触发点 removeSessionEntry，全部删除路径汇聚处） */
  setOnSessionDestroyed(handler: (summary: SessionSummary) => void): void
  /** Set thinking level for a session's pi subprocess */
  setThinkingLevel(sessionId: string, level: string): Promise<void>
  /** Steer an actively generating session */
  steerMessage(sessionId: string, content: string): Promise<void>
  /** Queue a follow-up message for a session */
  followUpMessage(sessionId: string, content: string): Promise<void>

  // ── wave:runtime-patch ipc-converge-a3 W2：业务持久化写（从 main IPC 迁 WS，安全校验原样搬 TC3）──
  /** 写入粘贴截图（base64→attachments/tmpdir）。安全校验：mimeType image/* + 20MB 上限 + name sanitize */
  writeImage(sessionId: string, base64: string, mimeType: string, name: string): Promise<{ path: string; fileName: string; displayName: string; id: string; persisted: boolean }>
  /** 迁移 tmpdir 图片到 attachments 持久化目录。安全校验：fromPath 白名单（tmpdir/attachments） */
  migrateImage(fromPath: string, sessionId: string, fileName: string): Promise<{ path: string }>
  /** 追加/覆盖 segments.json sidecar（atomic 写，同 clientUuid 覆盖） */
  writeSegmentsMetadata(sessionId: string, entry: SegmentsMetadataEntry): Promise<void>
}

// ── ISessionServiceInternal ───────────────────────────────────────
// R5：已迁移到 services/session/session-internal.ts（session 域内部契约收归 session 目录）。
// 此处 re-export 保持向后兼容，新代码请从 services/session/session-internal.js 导入。
export type { ISessionServiceInternal } from './services/session/session-internal.js'

// ── IConfigService ────────────────────────────────────────────────

/** Provider / Skill / Agent CRUD and tool permissions. */
export interface IConfigService {
  listProviders(): ProviderInfo[]
  /** 列出内置 provider 模板（wave 2，import generated JSON，无参只读）。 */
  listBuiltinProviders(): BuiltinProviderTemplate[]
  /**
   * 环境变量检测（I3，wave-env-check）：检查 runtime process.env 中指定变量是否已设置。
   * 安全红线：只返回布尔不返回值（env 值可能含凭证，不能泄露到前端）。names 去重。
   */
  checkEnvVars(names: string[]): Record<string, boolean>
  getDefaultModel(): { provider: ProviderId; modelId: string } | null
  setDefaultModel(provider: string, modelId: string): void
  setProvider(providerId: string, data: {
    name?: string
    type?: string
    apiKey?: string
    authMethod?: 'api_key' | 'oauth' | 'env_var' | 'ambient'
    baseUrl?: string
    models?: Array<string | { id: string; name?: string; contextWindow?: number; input?: Array<'text' | 'image'>; thinkingLevelMap?: Record<string, string | null> }>
    enabled?: boolean
  }): Promise<{ newDefault?: { provider: ProviderId; modelId: string } }>
  /**
   * 切换 provider 启用状态（wave3 IF2）——写 enabledModels 白名单。
   *
   * enabled=true: 若 enabledModels 非空加 `<id>/*`；空时 no-op（CL1）。
   * enabled=false: 移除所有 `<id>/*`/`<id>/<model>` pattern；边界3 空时 delete 字段（CL2）；
   *   边界2 若 defaultModel 承载该 provider 重选并返回 newDefault。
   *
   * @returns 触发 defaultModel 重选时含 newDefault；否则空对象。
   */
  toggleProviderEnabled(providerId: string, enabled: boolean): { newDefault?: { provider: ProviderId; modelId: string } }
  /**
   * 按体系移除 provider（wave4 IF3）——catalog 清凭据/override/残留（不删 pi catalog 定义），
   * custom 删 models.json 条目 + 清残留。renderer 传 ProviderInfo.kind（CL1）。
   *
   * @returns custom 分支透传 configStore.removeProvider 的 newDefault（default 承载被删 provider 时重选）；
   *          catalog 分支透传 removeProvider 的 newDefault（override 承载 default 时重选 default + mutate settings.json）。
   */
  removeProviderByKind(providerId: string, kind: 'catalog' | 'custom'): Promise<{ removed: boolean; newDefault?: { provider: ProviderId; modelId: string } }>
  deleteProvider(providerId: string): Promise<{ removed: boolean; newDefault?: { provider: ProviderId; modelId: string } }>
  getProvider(providerId: string): { apiKey?: string; name?: string; type?: string; baseUrl?: string; models?: unknown[]; enabled?: boolean } | undefined
  updateToolPermissions(permissions: Record<string, string>): void
  // ── Skill/Agent 加载路径（ADR-0021 §1 discovery.json v2 SSOT）──
  /** 覆盖 skill 路径（SkillDirConfig[] 带 scope，按 scope 分发写 projectPaths/globalPaths）。写 discovery.json + 投影 settings.json。 */
  setSkillDirs(dirs: SkillDirConfig[]): void
  /** 读取 skill 合并路径（project ∪ global 去重，项目在前）。 */
  getSkillDirs(): string[]
  /** 读取 skill 的 v2 分 scope 结构（projectPaths / globalPaths）。 */
  getSkillPathScopes(): DirScopes
  /** 覆盖 agent 路径（SkillDirConfig[] 带 scope）。写 discovery.json。 */
  setAgentDirs(dirs: SkillDirConfig[]): void
  /** 读取 agent 合并路径（project ∪ global 去重，项目在前）。 */
  getAgentDirs(): string[]
  /** 读取 agent 的 v2 分 scope 结构（projectPaths / globalPaths）。 */
  getAgentPathScopes(): DirScopes
  /** 覆盖 extension 路径（SkillDirConfig[] 带 scope）。写 discovery.json。 */
  setExtensionDirs(dirs: SkillDirConfig[]): void
  /** 读取 extension 合并路径（project ∪ global 去重，项目在前）。 */
  getExtensionDirs(): string[]
  /** 读取 extension 的 v2 分 scope 结构（projectPaths / globalPaths）。 */
  getExtensionPathScopes(): DirScopes
  /** 一次性迁移：settings.json.skills → discovery.json（首启用，幂等）。 */
  migrateSettingsSkillsToDiscovery(): void
  loadSkills(projectRoot: string): SkillInfo[]
  saveSkills(projectRoot: string, skills: SkillInfo[]): void
  /** @deprecated ADR-0021 §5：目录级管道模型，无文件级 CRUD。保留为兼容 no-op。 */
  upsertSkill(skill: SkillInfo): void
  /** @deprecated ADR-0021 §5：目录级管道模型，无文件级 CRUD。保留为兼容 no-op。 */
  deleteSkill(skillId: string): void
  loadAgents(projectRoot: string): AgentInfo[]
  saveAgents(projectRoot: string, agents: AgentInfo[]): void
  /** @deprecated ADR-0021 §5：目录级管道模型，无文件级 CRUD。保留为兼容 no-op。 */
  upsertAgent(agent: AgentInfo): void
  /** @deprecated ADR-0021 §5：目录级管道模型，无文件级 CRUD。保留为兼容 no-op。 */
  deleteAgent(agentId: string): void
  scanSkills(sources: string[], existingIds: Set<string>): ScannedSkillInfo[]
  scanAgents(sources: string[], existingIds: Set<string>): ScannedAgentInfo[]
  /**
   * 检测本机其他 agent（Claude/Codex/Pi/ZCode）的 skill/agent 配置目录（W1 迁移功能）。
   * 只读检测，不读文件内容；返回每个源的安装状态 + 资源计数。
   */
  detectSources(): SourceDetectResult[]
  /**
   * W2 迁移：预览从其他 agent 源导入的 provider 列表（脱敏，不含 apiKey 值）。
   *
   * 安全红线（DM1）：返回的 ProviderImportPreview 只含 apiKeyExtracted 布尔，**不含 apiKey 明文**。
   * 完整配置（含 apiKey 明文）暂存在 runtime 内存缓存（5min TTL），由 applyImportProviders 消费。
   *
   * @param source 迁移源（pi/zcode/codex/claude）。
   * @returns 成功 { importId, preview }；源未安装 { error: { code: 'SOURCE_NOT_INSTALLED', message } }。
   *          importId 供 applyImportProviders 第二步使用。
   */
  previewImportProviders(source: ProviderSource): { importId: string; preview: ProviderImportPreview } | { error: { code: string; message: string } }
  /**
   * W2 迁移：应用导入（写入 models.json）。从缓存取完整配置 → 剥离 _ 元数据 → 逐个 upsertProvider。
   *
   * apply 成功后立即删缓存（一次性，防 importId 复用）。apply 时再次查冲突（preview 后 models.json 可能被改），
   * 同名 provider 标 skipped（不覆写）。
   *
   * @param importId previewImportProviders 返回的 importId。
   * @param selectedIds 用户勾选导入的 provider id 列表（对应源里的 provider 名）。
   * @returns 成功 { result }；缓存过期/不存在 { error: { code: 'PREVIEW_EXPIRED', message } }。
   */
  applyImportProviders(importId: string, selectedIds: string[]): Promise<{ result: ProviderImportResult } | { error: { code: string; message: string } }>
  /** pi agent 配置目录（settings.json/agents/skills 所在地）。 */
  getPiAgentDir(): string
  /** xyz-agent 配置根目录（~/.xyz-agent/，plugins/session-data 所在地）。 */
  getConfigDir(): string
  // ── System prompt config（FR-6/FR-7，ADR-0044）──
  /** 读取 system-prompt.json。损坏时 corrupted=true 且返回默认配置。 */
  getSystemPromptConfig(): { config: SystemPromptConfig; corrupted: boolean }
  /** 写入 system-prompt.json。replace.prompt 超长（>SYSTEM_PROMPT_MAX_LENGTH）返回 ok:false + error，不写盘。 */
  setSystemPromptConfig(config: SystemPromptConfig): { ok: boolean; error?: string }
  /** 返回当前生效的替换提示词（replace.enabled && prompt 非空白时），否则 undefined。rpc-client spawn 时透传。 */
  getReplaceSystemPrompt(): string | undefined
  // ── Terminal config（Phase 6 settings）──
  /** 读取 terminal.json。损坏时 corrupted=true 且返回默认配置。 */
  getTerminalConfig(): { config: TerminalConfig; corrupted: boolean }
  /** 写入 terminal.json。校验失败返回 ok:false + error，不写盘。 */
  setTerminalConfig(config: TerminalConfig): { ok: boolean; error?: string }
  // ── Worktree config（git-cwt-anywhere）──
  /** 读取 worktree 根目录（config.json.worktreeRootDir），默认 '~/worktrees'。 */
  getWorktreeRootDir(): string
  /** 写入 worktree 根目录到 config.json.worktreeRootDir。 */
  setWorktreeRootDir(dir: string): void
  /** 读取 setup 脚本路径（config.json.setupScript），默认 'custom-hooks/setup-worktree.sh'。 */
  getSetupScript(): string
  /** 写入 setup 脚本路径到 config.json.setupScript。 */
  setSetupScript(script: string): void
  /** 读取 bare-workspace 初始化脚本路径（config.json.bareSetupScript），默认 'custom-hooks/setup-worktree.sh'。 */
  getBareSetupScript(): string
  /** 写入 bare-workspace 初始化脚本路径到 config.json.bareSetupScript。 */
  setBareSetupScript(script: string): void
  /** 读取 worktree 创建超时时间（config.json.worktreeTimeout），默认 60 秒。 */
  getTimeout(): number
  /** 写入 worktree 创建超时时间到 config.json.worktreeTimeout。 */
  setTimeout(timeout: number): void
  /** 读取默认基分支（config.json.defaultBaseBranch），默认 'origin/main'。 */
  getDefaultBaseBranch(): string
  /** 写入默认基分支到 config.json.defaultBaseBranch。 */
  setDefaultBaseBranch(baseBranch: string): void
  /** 读取是否启用 session 自动重命名（标志文件存在=开），默认 false。 */
  getAutoRenameEnabled(): boolean
  /** 设置 session 自动重命名开关（true 创建标志文件 / false 删除）。 */
  setAutoRenameEnabled(enabled: boolean): void
  /** 读取 rename 标题生成模型（"provider/modelId"，未设置 = 空串；读 extension 配置文件）。 */
  getRenameModel(): string
  /** 设置 rename 标题生成模型（读改写 extension 配置文件的 model 字段，保留其他字段）。 */
  setRenameModel(model: string): void
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
  /** 启用的 extension 路径列表（供 pi --extension 参数）。cwd 用于解析相对的 discovery extension 目录。 */
  getExtensionPaths(cwd?: string): Promise<string[]>
  /**
   * 供 PresetService 做 preset 二次筛选：返回原始发现结果（不含 builtin、不过滤）+ disabled 集合。
   * M1 修复：builtin 注入点唯一化，避免 preset-service 拿到含 builtin 的列表再 prepend 导致 double-builtin。
   */
  getDiscoveredAndDisabled(cwd?: string): Promise<{ discovered: import('./services/ports/installer.js').DiscoveredExtension[]; disabledSet: Set<string> }>
  /**
   * builtin 文件型 extension 路径（existsSync 过滤后），永远注入不受 preset.extensionMode 影响。
   * 设计文档 §2.3：供 PresetService.resolveExtensionPaths 复用。
   */
  getBuiltinExtensionPaths(): string[]
  installExtension(source: string): Promise<void>
  uninstallExtension(name: string): Promise<void>
  installLocalDirectory(sourcePath: string): Promise<{ tempDir: string; candidates: import('@xyz-agent/shared').ExtensionInfo[] }>
  installGitRepository(url: string): Promise<{ tempDir: string; candidates: import('@xyz-agent/shared').ExtensionInfo[] }>
  finishInstall(tempDir: string, selected: string[]): Promise<void>
  cancelInstall(tempDir: string): Promise<void>
}

// ── IModelService ─────────────────────────────────────────────────

/**
 * OAuth Login 编排服务（slice design I1/T5）。
 * 实现：services/auth/auth-service.ts（路径 B 自实现：device/callback flow 拿 token 写 auth.json）。
 */
export interface IAuthService {
  /** 启动 OAuth login（异步执行）。无 oauthConfig / 已有进行中 flow → started:false + error。 */
  login(providerId: string): { started: boolean; error?: string }
  /** 中止进行中 flow。幂等：无 flow 返回 cancelled:false。 */
  cancel(providerId: string): { cancelled: boolean }
  /** 读 auth.json：该 provider 是否有 oauth 凭据。 */
  hasOAuth(providerId: string): Promise<boolean>
}

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
  /** Execute a command contributed by a plugin（S3-W1：返回插件 handler 的执行结果） */
  executeCommand(pluginId: string, commandId: string, args?: Record<string, unknown>): Promise<unknown>
  /** Get plugin config value(s) */
  getPluginConfig(pluginId: string, key?: string): Promise<unknown>
  /** Set a plugin config value */
  setPluginConfig(pluginId: string, key: string, value: unknown): Promise<void>
  /** 覆盖式写入挂载点集合（renderer 经 plugin.mountPoints.sync 上报，DM3 全量镜像） */
  syncMountPoints(mountPoints: string[]): void
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
  checkoutByCwd(cwd: string, name: string): Promise<void>
  createBranch(sessionId: string, name: string): Promise<void>
  /**
   * 写操作成功后的状态缓存失效（perf W17）：handler 在 stage/unstage/commit/checkout/
   * createBranch（sessionId）与 checkoutCwd（cwd，session-less）成功后调用。
   */
  invalidateStatusCache(target: { sessionId?: string; cwd?: string }): void
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
