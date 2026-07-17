// Client → Runtime message types

import type { ProviderInfo, SkillInfo, AgentInfo, ModelInfo, SkillDirConfig } from './provider'
import type { SessionGroup, SessionSummary } from './session'
import type { FileChange, ChangeSetStatus, Message } from './message'
import type { FileNode } from './file-tree'
// 领域 DTO 已下沉到各自领域文件（E2 架构候选）：protocol.ts 仅保留 type→payload 映射 SSOT，
// 领域形状（ExtensionInfo / GitStatusResult / PluginInfo …）按领域就近归属。
import type { ExtensionInfo, RecommendedExtension, ExtensionInteractMethod } from './extension'
import type { GitStatusResult } from './git'
import type { PluginInfo } from './plugin'
import type { RecentWorkspaceRecord } from './workspace'
import type { SubagentRecord } from './subagent'
import type { WorkflowRunRecord } from './workflow'

// ── ClientMessageType（保持向后兼容）──────────────────────────

export type ClientMessageType =
  | 'session.create' | 'session.delete' | 'config.sessions' | 'session.switch' | 'session.history' | 'session.getFullHistory' | 'session.getCommands' | 'session.getContext'
  | 'session.compact' | 'session.rename' | 'session.fork'
  | 'session.getSubagents' | 'session.getSubagentHistory'
  | 'session.getWorkflows' | 'session.getAgentCallHistory' | 'session.getAgentCallFilePath'
  | 'session.workflowAction' | 'session.subagentAction'
  | 'message.send' | 'message.abort' | 'message.steer' | 'message.follow_up'
  | 'config.getProviders' | 'config.setProvider' | 'config.deleteProvider' | 'config.setToolPermissions'
  | 'config.discoverModels' | 'config.setDefaultModel'
  | 'config.scanSkills' | 'config.setSkill' | 'config.deleteSkill'
  | 'config.scanAgents' | 'config.setAgent' | 'config.deleteAgent'
  | 'config.setSkillDirs' | 'config.setAgentDirs'
  | 'config.getSystemPrompt' | 'config.setSystemPrompt'
  | 'model.list' | 'model.switch' | 'session.setThinkingLevel'
  | 'tool.approve' | 'tool.deny' | 'tool.always_allow'
  | 'extension.ui_response' | 'extension.toggle' | 'extension.list'
  | 'extension.install' | 'extension.uninstall'
  | 'extension.installDir' | 'extension.installGit' | 'extension.finishInstall' | 'extension.cancelInstall'
  | 'extension.recommended'
  | 'extension.upgrade' | 'extension.setAutoUpgrade'
  | 'extension.getPendingRequests'
  | 'ping'
  | 'plugin.list' | 'plugin.toggle'
  | 'plugin.install' | 'plugin.uninstall'
  | 'plugin.approvePermissions' | 'plugin.revokePermissions'
  | 'plugin.executeCommand'
  | 'plugin.config.get' | 'plugin.config.set'
  | 'plugin.uiResponse'
  | 'file.read'
  | 'file.tree' | 'file.tree.expand' | 'file.search'
  | 'git.diff'
  | 'file.write.create' | 'file.write.rename' | 'file.write.delete'
  | 'git.status' | 'git.stage' | 'git.unstage' | 'git.commit' | 'git.checkout' | 'git.createBranch'
  | 'workspace.listRecent' | 'workspace.record'

// ── Payload 类型定义 ────────────────────────────────────────────

/** config.setProvider 除 providerId 外的透传字段，与 IConfigService.setProvider 参数对齐。
 *  models 元素字段与 runtime ConfigModelDefinition 对齐（含 api/baseUrl/enabled 透传位，
 *  W2/W4 model 级配置不丢字段）。 */
export interface SetProviderData {
  name?: string
  type?: string
  apiKey?: string
  baseUrl?: string
  /** 自定义请求头（provider 级，与 ProviderInfo.headers 对齐）。 */
  headers?: Record<string, string>
  /** 是否把 apiKey 写入 Authorization header（与 ProviderInfo.authHeader 对齐）。 */
  authHeader?: boolean
  models?: Array<string | {
    id: string
    name?: string
    api?: string
    baseUrl?: string
    reasoning?: boolean
    input?: Array<'text' | 'image'>
    contextWindow?: number
    maxTokens?: number
    thinkingLevelMap?: Record<string, string | null>
    /** model 级启停（W2）。省略时默认 true，与 PiModelDefinition 同构。 */
    enabled?: boolean
  }>
  enabled?: boolean
}

/** 系统提示词配置（FR-6）。文件：<dataDir>/system-prompt.json。
 *  - replace: 替换 pi 核心系统提示词（走 --system-prompt CLI，仅新建会话生效）
 *  - append:  追加注入（走 before_agent_start hook，每轮读配置热生效）
 *  version: schema 版本号（SR1） */
export interface SystemPromptConfig {
  version: number
  replace: { enabled: boolean; prompt: string }
  append: { enabled: boolean; prompt: string }
}

// ── ClientMessage discriminated union ───────────────────────────

/** 每个 type 对应的 payload 类型映射 */
export interface ClientMessageMap {
  'ping': Record<string, never>
  // hidden:true 创建隐藏 session（公共 session），不进 sidebar 列表，仅供内部使用。
  'session.create': { cwd?: string; label?: string; hidden?: boolean }
  'session.delete': { sessionId: string }
  'config.sessions': Record<string, never>
  'session.switch': { sessionId: string }
  'session.history': { sessionId: string }
  'session.getFullHistory': { sessionId: string }
  'session.getCommands': { sessionId: string }
  'session.getContext': { sessionId: string }
  'session.compact': { sessionId: string; customInstructions?: string }
  'session.rename': { sessionId: string; name: string }
  // fork：从 srcSessionId 截断到 fromPiEntryId（pi JSONL entry id，前端 Message.piEntryId），
  // includeFrom=true 保留到该 entry（含），false 保留到该 entry 前（不含）。
  // runtime 按 fromPiEntryId 在源 session JSONL 树回溯截断，写新 JSONL，switch_session 加载。
  // fromPiEntryId 缺失（RPC 路径读取的 session 无 piEntryId）时，用 fromMessageTimestamp +
  // fromMessageRole fallback 读 JSONL 按 timestamp 匹配 entryId（HISTORICAL: 2026-07-16）。
  'session.fork': {
    srcSessionId: string
    fromPiEntryId?: string
    fromMessageTimestamp?: number
    fromMessageRole?: string
    includeFrom?: boolean
    label?: string
  }
  // subagent 列表/对话流读取（runtime 直读主 session JSONL + subagent JSONL，不依赖扩展）
  'session.getSubagents': { sessionId: string }
  'session.getSubagentHistory': { sessionId: string; subagentId: string }
  // workflow 列表/agent call 对话流读取（runtime 直读主 session JSONL + workflow-state JSONL，不依赖扩展）
  'session.getWorkflows': { sessionId: string }
  'session.getAgentCallHistory': { sessionId: string; agentCallSessionId: string }
  'session.getAgentCallFilePath': { sessionId: string; agentCallSessionId: string }
  'session.workflowAction': { sessionId: string; action: 'pause' | 'resume' | 'abort'; runId: string }
  // session.subagentAction：subagent 生命周期操作（当前只 cancel，对称 workflowAction 的扩展 slash command 转发）。
  // runtime 经 client.prompt("/subagents <action> <subagentId>") 调扩展（不经 LLM）。
  'session.subagentAction': { sessionId: string; action: 'cancel'; subagentId: string }
  'message.send': { sessionId: string; content: string; subagent?: { agent: string; task: string } }
  'message.abort': { sessionId: string }
  'message.steer': { sessionId: string; content: string }
  'message.follow_up': { sessionId: string; content: string }
  'config.getProviders': Record<string, never>
  'config.setProvider': { providerId: string } & SetProviderData
  'config.deleteProvider': { providerId: string }
  'config.setToolPermissions': { permissions: Record<string, string> }
  'config.discoverModels': { baseUrl: string; apiKey?: string; providerType?: string; providerId?: string }
  // W3 默认模型持久化：前端设置全局默认模型，runtime 调 configService.setDefaultModel 写 settings.json。
  'config.setDefaultModel': { provider: string; modelId: string }
  'config.scanSkills': { sources: string[] }
  'config.setSkill': { skill: SkillInfo }
  'config.deleteSkill': { skillId: string }
  'config.scanAgents': { sources: string[] }
  'config.setAgent': { agent: AgentInfo }
  'config.deleteAgent': { agentId: string }
  /** 目录级管道写入（ADR-0020 §5）：dirs 为有序数组，靠前覆盖靠后。写 discovery.json。 */
  'config.setSkillDirs': { dirs: string[] }
  'config.setAgentDirs': { dirs: string[] }
  'config.getSystemPrompt': Record<string, never>
  'config.setSystemPrompt': { config: SystemPromptConfig }
  'model.list': Record<string, never>
  'model.switch': { sessionId: string; provider: string; modelId: string }
  'session.setThinkingLevel': { sessionId: string; level: string }
  'tool.approve': { sessionId: string; toolCallId?: string }
  'tool.deny': { sessionId: string; toolCallId?: string; reason?: string }
  'tool.always_allow': { sessionId: string; toolName?: string }
  'extension.ui_response': { sessionId: string; requestId: string; method: string; result: boolean | string | null }
  'extension.toggle': { name: string; enabled: boolean }
  'extension.list': Record<string, never>
  'extension.install': { source: string }
  'extension.uninstall': { name: string }
  'extension.installDir': { path: string }
  'extension.installGit': { url: string }
  'extension.finishInstall': { tempDir: string; selected: string[] }
  'extension.cancelInstall': { tempDir: string }
  'extension.recommended': Record<string, never>
  'extension.upgrade': { name: string }
  'extension.setAutoUpgrade': { name: string; autoUpgrade: boolean }
  'extension.getPendingRequests': { sessionId: string }
  'plugin.list': Record<string, never>
  'plugin.toggle': { pluginId: string; enabled: boolean; trustLevel?: 'trusted' | 'sandbox' }
  'plugin.install': { packageSpec: string }
  'plugin.uninstall': { pluginId: string }
  'plugin.approvePermissions': { pluginId: string; permissions: string[] }
  'plugin.revokePermissions': { pluginId: string }
  'plugin.executeCommand': { pluginId: string; commandId: string; args?: Record<string, unknown> }
  'plugin.config.get': { pluginId: string; key?: string }
  'plugin.config.set': { pluginId: string; key: string; value: unknown }
  'plugin.uiResponse': { requestId: string; result: unknown }
  'file.read': { path: string; sessionId?: string }
  'file.tree': { sessionId: string }
  'file.tree.expand': { sessionId: string; path: string }
  /** file.search：composer # 文件候选，全量递归当前 cwd（受 ignore 过滤 + 深度上限 8 + DoS 上限 5000）*/
  'file.search': { sessionId: string; showIgnored?: boolean }
  'git.diff': { sessionId: string; path: string }
  'file.write.create': { sessionId: string; path: string; content: string }
  'file.write.rename': { sessionId: string; oldPath: string; newPath: string }
  'file.write.delete': { sessionId: string; path: string }
  'git.status': { sessionId: string }
  'git.stage': { sessionId: string; filePaths?: string[] }
  'git.unstage': { sessionId: string; filePaths?: string[] }
  'git.commit': { sessionId: string; message?: string }
  'git.checkout': { sessionId: string; name: string }
  'git.createBranch': { sessionId: string; name: string }
  'workspace.listRecent': Record<string, never>
  'workspace.record': { cwd: string }
}

// ClientMessage 由 ClientMessageMap 直接派生：每个 type 字面量映射到
// { type: K; id?: string; payload: ClientMessageMap[K] }。此前是一份 ~70 行手写
// discriminated union，与 ClientMessageMap 逐条重复——加新 type 要改两处且易漂移。
// 映射派生后 ClientMessageMap 成为唯一真值源；消费侧的 Extract<ClientMessage, { type: 'X' }>
// 收窄与 switch narrowing 行为完全一致。
export type ClientMessage = {
  [K in keyof ClientMessageMap]: { type: K; id?: string; payload: ClientMessageMap[K] }
}[keyof ClientMessageMap]

// ── Runtime → Client message types ──────────────────────────────

/**
 * config.defaults 广播的来源标签（仅 broadcast 携带，reply 不带）。
 * 收紧为联合类型：新增来源时编译器强制在此登记，避免 runtime 散落未约束的字面量。
 */
export type DefaultModelSource =
  | 'provider-updated' // setProvider 后 fallback 修正了默认模型
  | 'provider-deleted' // deleteProvider 后 fallback 修正了默认模型
  | 'default-set'      // config.setDefaultModel 主动设置
  | 'model-switch'     // model.switch 时持久化全局默认模型

export type ServerMessageType =
  | 'session.created' | 'session.deleted' | 'config.sessions' | 'session.history' | 'session.fullHistory'
  | 'session.compacting' | 'session.compacted' | 'session.renamed'
  | 'session.subagents' | 'session.subagentHistory'
  | 'session.workflows' | 'session.agentCallHistory' | 'session.agentCallFilePath'
  | 'session.workflowUpdate' | 'session.workflowActionDone' | 'session.subagentActionDone'
  | 'subagent.stream_delta'
  | 'message.message_start' | 'message.text_delta' | 'message.thinking_delta'
  | 'message.thinking_start' | 'message.thinking_end'
  | 'message.tool_call_start' | 'message.tool_call_end'
  | 'message.complete' | 'message.error' | 'message.status'
  | 'context.update'
  | 'config.providers' | 'config.providerUpdated' | 'config.discoveredModels' | 'config.defaults'
  | 'config.scannedSkills' | 'config.skillUpdated' | 'config.skillDeleted'
  | 'config.scannedAgents' | 'config.agentUpdated' | 'config.agentDeleted'
  | 'config.skills' | 'config.agents'
  | 'config.skillDirs' | 'config.agentDirs'
  | 'config.systemPrompt'
  | 'model.list' | 'model.switched'
  | 'session.thinkingLevelSet'
  | 'session.state_changed'
  | 'pong' | 'error'
  | 'extension.ui_request' | 'extension.ui_timeout' | 'extension.error'
  | 'extension.discovered' | 'extension.installCancelled'
  | 'extension.recommended'
  | 'extension.pendingRequests'
  | 'message.tool_call_update' | 'config.extensions'
  | 'session.commands'
  | 'session.exited'
  | 'app.info'
  | 'config.plugins' | 'plugin:crashed' | 'plugin:notification'
  | 'plugin:statusChange' | 'plugin:permissionRequest'
  | 'plugin:statusBarUpdate' | 'plugin:messageDecoration' | 'plugin:config'
  | 'plugin:statusSetUpdate'
  | 'plugin:uiRequest'
  | 'extension:widget' | 'extension:widgetGui' | 'extension:status' | 'extension:notify'
  | 'message.compactionSummary'
  | 'extension:setEditorText'
  | 'message.compactionSummary' | 'message.branchSummary'
  | 'message.auto_retry_start' | 'message.auto_retry_end' | 'message.queue_update'
  | 'message.stream_error'
  | 'message.stream_warn'
  | 'send.rejected'
  | 'message.file_changes'
  | 'message.changeSetInvalidated'
  | 'message.customStart'
  | 'file.read:result'
  | 'file.tree:result' | 'file.tree.expand:result' | 'file.search:result'
  | 'git.diff:result'
  | 'file.write.create:result' | 'file.write.rename:result' | 'file.write.delete:result'
  | 'git.status:result'
  | 'workspace.recentList'

/**
 * # ServerMessageMap —— Runtime → Client payload 类型映射
 *
 * 与 ClientMessageMap 对称：每个 ServerMessageType 对应的 payload 类型。
 * 消费侧（renderer events.onGlobalType / events.on）handler 内 payload 自动收窄，
 * 不再需要 `as ProviderInfo[]` 等断言。
 *
 * 收录原则：
 * - **已消费 + 已契约化**的类型 → 精确 payload（domain 订阅 + sendInitialState 推送的 7 条）。
 * - **未消费 / 协议待定**的类型 → `Record<string, unknown>`（占位，待对应 wave 实装时收紧：
 *   message.* 进 W05-W07，plugin:* / extension:* widget 等属后续 wave）。
 *
 * 收紧某条目时，runtime 构造点会同步得契约校验（若 payload 字段对不上，tsc 报错——这是 D5 的预期收益）。
 */
export interface ServerMessageMapBase {
  // ── sendInitialState 推送 / domain 订阅（精确）──
  'config.providers': { providers: ProviderInfo[] }
  'config.skills': { skills: SkillInfo[] }
  'config.agents': { agents: AgentInfo[] }
  /** discovery.json 加载路径广播（ADR-0020 §1，目录级管道配置） */
  'config.skillDirs': { dirs: SkillDirConfig[] }
  'config.agentDirs': { dirs: SkillDirConfig[] }
  'config.defaults': {
    defaultModel: string
    /** 默认模型变更来源，仅 broadcast 携带（reply 不带）。reply/broadcast 共用此类型，故 source 为 optional。 */
    source?: DefaultModelSource
  }
  'config.extensions': { extensions: ExtensionInfo[]; upgradeResult?: { upgraded: boolean; from: string; to: string } }
  /** extension.recommended reply：推荐扩展列表（含已安装状态） */
  'extension.recommended': { recommended: Array<RecommendedExtension & { installed: boolean }> }
  'config.plugins': { plugins: PluginInfo[] }
  'model.list': { models: ModelInfo[] }
  'config.sessions': { groups: SessionGroup[] }
  /** config.systemPrompt：reply + broadcast + 初始推送三用。corrupted=true 表示磁盘配置损坏已回退默认（SR5）。 */
  'config.systemPrompt': { config: SystemPromptConfig; corrupted?: boolean }

  // ── 协议级 reply / push（精确）──
  'pong': Record<string, never>
  'error': { code: string; message: string; sessionId?: string; details?: Record<string, unknown> }
  // 流式异步推送失败（server-push 通道，区别于请求级 error envelope；见错误契约文档）
  'message.error': { sessionId: string; message: string }
  // message.stream_error：流式真错误（pi 异常 / 流终止）。前端收到后 finalizeSession 收口。
  // content 为人类可读原因（前端 chat-message-effects 读 readString(payload,'content')）。
  'message.stream_error': { sessionId: string; content: string; kind?: string }
  // message.stream_warn：pi 静默卡死 WARN（120s 无活动，提示性，不中断流）。
  // 与 stream_error 物理隔离——前端仅追加提示文案，不调 finalizeSession，session 保持 streaming 态。
  // B1（PR#86 review）：原先 WARN 复用 stream_error{kind:'silent'}，前端无条件收口破坏「不中断」设计。
  'message.stream_warn': { sessionId: string; content: string }
  // send.rejected：runtime 预检拦截（busy 时发送），防御性反馈通道（D-006）。
  // 语义：操作拒绝，区别于 message.error（流终止）。不进对话流，不翻流式态。
  // useChat 收到后回滚 pendingSend + toast。
  'send.rejected': { sessionId: string; reason: 'busy'; message: string }
  // session.exited：pi 进程异常退出（区别于 message.error 的「单次消息失败」）。
  // 前端 routeInbound 收到后标记 session 为 dead 态 + 插入 error 消息 + toast。
  // reason: 人类可读的错误原因（含 stderr 尾部截断），供诊断面板展开显示。
  // code: pi 进程退出码（null 表示进程被信号杀死无退出码）。
  'session.exited': { sessionId: string; code: number | null; reason: string }
  // 扩展 UI 推送通道（EventAdapter 翻译 pi setWidget/setStatus，runtime 固定形状生产）
  'extension:widget': { sessionId: string; widgetKey: string; lines: string[] }
  // 结构化 widget（GuiComponent 经 NUL marker 编码透传，event-adapter 检测 marker 解码）
  'extension:widgetGui': { sessionId: string; widgetKey: string; gui: unknown }
  'extension:status': { sessionId: string; statusKey: string; text: string; textRaw?: string }
  // extension notify（pi fire-and-forget 通知，前端渲染为 toast）
  'extension:notify': { sessionId: string; message: string; level: 'info' | 'warn' | 'error' }
  // extension.ui_request：交互对话框请求（select/confirm/input/editor + ask-user 富交互）。
  // ask-user 扩展字段（askUser/askUserQuestions/allowCancel）仅在 method='select' + askUser=true 时存在。
  // askUserQuestions 用 unknown[] 保持 shared 包依赖最小化（与 extension:widgetGui 的 gui:unknown 先例一致），
  // 前端消费时用类型守卫收窄为 AskUserQuestion[]。
  'extension.ui_request': {
    sessionId: string
    requestId: string
    method: ExtensionInteractMethod
    title?: string
    message?: string
    options?: string[]
    default?: string
    level?: 'info' | 'warn' | 'error'
    prefill?: string
    // ask-user 富交互扩展（仅 method='select' + askUser=true 时存在）
    askUser?: boolean
    askUserQuestions?: unknown[]
    allowCancel?: boolean
  }
  // session 通道推送（runtime session-service / index.ts 生产，W04 收紧）
  'session.compacting': { sessionId: string }
  'session.compacted': { sessionId: string; status: 'compacted'; error?: string }
  // session.commands：pi 扩展命令列表（fetchAndBroadcastCommands 广播）
  'session.commands': { sessionId: string; commands: Array<{ name: string; description?: string; source: string }> }
  // session.subagents：当前 session 派生的 subagent 列表（runtime 从主 session JSONL 提取）
  'session.subagents': { sessionId: string; subagents: SubagentRecord[] }
  // session.subagentHistory：subagent 对话流消息（runtime 直读 subagent JSONL，复用 convertPiHistory）
  'session.subagentHistory': { sessionId: string; subagentId: string; messages: import('./message').Message[] }
  // session.workflows：当前 session 派生的 workflow 列表（runtime 从主 session JSONL 的 workflow-state-link 提取）
  'session.workflows': { sessionId: string; workflows: WorkflowRunRecord[] }
  // session.agentCallHistory：workflow 内 agent call 的对话流消息（runtime 按 trace[].sessionId 查找 JSONL）
  'session.agentCallHistory': { sessionId: string; agentCallSessionId: string; messages: import('./message').Message[] }
  // session.agentCallFilePath：agent call 对话流 JSONL 绝对路径（PanelHeader overlay 文件名展示用，找不到为空串）
  'session.agentCallFilePath': { sessionId: string; agentCallSessionId: string; filePath: string }
  // session.workflowUpdate：workflow 状态变化增量信号（event-interpreter 推送，发起/结束时刻）。
  // 前端收到后调 loadWorkflows RPC 拉取完整列表。与 session.workflows（RPC reply 全量列表）区分。
  'session.workflowUpdate': { sessionId: string; update: { runId: string; status: string; reason?: string } }
  // session.workflowActionDone：workflow 操作完成确认（session.workflowAction RPC reply）
  'session.workflowActionDone': { sessionId: string; action: 'pause' | 'resume' | 'abort'; runId: string }
  // session.subagentActionDone：subagent 操作完成确认（session.subagentAction RPC reply）
  'session.subagentActionDone': { sessionId: string; action: 'cancel'; subagentId: string }
  // subagent.stream_delta：running subagent 的逐字 streaming（路径 A-1）。
  // pi 扩展层合并 text_delta 后经 ctx.ui.setWidget("subagent-stream-<recordId>", lines) 转发，
  // runtime EventAdapter 捕获后转为此 WS 帧。lines 是累积全文（split('\n')），undefined = 终态清除。
  'subagent.stream_delta': { sessionId: string; recordId: string; lines: string[] | undefined }
  // app.info：runtime 启动时推送应用 + pi 版本号（全局通道，无 sessionId）。
  // publicSessionId：公共 session 的真实 id（pi 生成 UUID，启动期创建后填）。
  // 前端 landing 态用此 id 从 commandStore 取命令（pi extension slash 命令）。
  'app.info': { appVersion: string; piVersion: string; publicSessionId?: string }
  // context.update：上下文用量（index.ts onContextUpdate 推；cacheHit/modelId 无来源，D9 保留 UI 占位）
  'context.update': { sessionId: string; usagePercent: number; inputTokens: number; contextLimit: number }
  // message.compactionSummary：上下文压缩摘要（compact 执行后推送，进对话流作 SystemNotice）。
  // runtime message-dispatcher.compact() 从 pi CompactionResult 提取 summary/tokensBefore 广播。
  // 前端 chat-message-effects 把它渲染成 system 消息（SystemNotice.vue「上下文已压缩」）。
  'message.compactionSummary': { sessionId: string; summary?: string; tokensBefore?: number; timestamp?: number }
  // session.state_changed：session 级状态变更（model.switch 成功后推送，含新 modelId + 按新 contextWindow
  // 重算的用量 + 当前 thinkingLevel）。前端据 modelId/thinkingLevel 同步 Composer 工具条，据 usage 三字段
  // 刷新 ContextCapacityPopover。thinkingLevel optional（未设置时省略）。
  'session.state_changed': {
    sessionId: string
    modelId: string
    thinkingLevel?: string
    usagePercent: number
    inputTokens: number
    contextLimit: number
  }
  // FileChanges 通道（ADR-0024 D5 重构：git 作为唯一真值源）。baseline diff 机制——
  // message_start 采集 git status 快照，write/edit/bash 结束后 diff vs baseline 推 accumulating，
  // agent_end 推 ready。isFullSet 恒 true（每次 diff 都是全量结果，前端全集替换不增量合并）。
  // partially-reviewed/resolved/superseded 审查态由前端驱动，不经 runtime 推送。
  'message.file_changes': {
    sessionId: string
    messageId: string
    fileChanges: FileChange[]
    changeSetStatus: ChangeSetStatus
    isFullSet: boolean
  }
  // changeSet 失效广播（ADR-0024 D5 重构）：git.commit 成功后工作区 diff 已重置，
  // 旧的 changeSet 卡片成为过期数据。runtime 广播此帧通知前端把该 session 的 changeSet 推 superseded。
  'message.changeSetInvalidated': {
    sessionId: string
    /** 失效原因：'committed'（git commit 后工作区重置） */
    reason: 'committed'
  }
  // git.status:result：git.status 请求的同步 reply（Wave 1a git domain 经 pending.resolve 消费）。
  // git.stage/unstage/commit 的 ack 复用既有 'message.status'（payload {sessionId, status}），非新增。
  'git.status:result': GitStatusResult
  /** file.tree:result：文件树首加载 reply，顶层+一级子 FileNode[] */
  'file.tree:result': { sessionId: string; tree: FileNode[] }
  /** file.tree.expand:result：展开目录 reply，单层子 FileNode[] */
  'file.tree.expand:result': { sessionId: string; children: FileNode[] }
  /** file.search:result：composer # 文件候选 reply，全量递归 FileNode[]（受 ignore + 深度 8 + DoS 上限 5000）*/
  'file.search:result': { sessionId: string; files: FileNode[] }
  /** git.diff:result：文件 diff reply（patch + binary 标志） */
  'git.diff:result': { sessionId: string; patch: string; binary: boolean }
  /** file.write.*.result：文件操作骨架 reply（D-018 实现延后，AC-14.4 结构化「待实现」） */
  'file.write.create:result': { sessionId: string; path: string; implemented: false }
  'file.write.rename:result': { sessionId: string; newPath: string; implemented: false }
  'file.write.delete:result': { sessionId: string; path: string; implemented: false }
  'workspace.recentList': { records: RecentWorkspaceRecord[] }

  // ── RPC reply（W1 方案C 补全：精确 payload，对齐 runtime handler 的 reply 调用字面量）──
  // session.created：session.create / session.fork 的成功 reply。
  // session 是 SessionSummary（session-message-handler.ts:36/56 reply { session }）。
  'session.created': { session: SessionSummary }
  // session.deleted：session.delete reply（session-message-handler.ts:72 reply { sessionId: delSid }）。
  'session.deleted': { sessionId: string }
  // session.renamed：session.rename reply（session-message-handler.ts:162 reply { sessionId, name }）。
  'session.renamed': { sessionId: string; name: string }
  // session.history：session.history / session.switch 的成功 reply（session-message-handler.ts:83/96/111）。
  // session optional——switch 路径带 SessionSummary（已 restore 的 session），getHistory 路径不带。
  // historyTruncated：历史超上限截断标志（前端据此提示「历史已截断」）。
  'session.history': {
    sessionId: string
    session?: SessionSummary
    messages: Message[]
    historyTruncated: boolean
  }
  // session.fullHistory：session.getFullHistory reply（session-message-handler.ts:115 reply { sessionId, messages }，全量无截断）。
  'session.fullHistory': { sessionId: string; messages: Message[] }
  // model.switched：model.switch reply（settings-message-handler.ts:134 reply { sessionId, provider, modelId }）。
  'model.switched': { sessionId: string; provider: string; modelId: string }
  // message.status：send/abort/steer/follow_up + git stage/unstage/commit/checkout/createBranch 的 ack reply。
  // status 是动作结果字面量（sent/rejected/steered/queued/aborted/staged/unstaged/committed/switched/branch_created），
  // CL10 决策不收窄死字面量，统一 string（ack 型 domain register<void> 不读 status 值）。
  // 见 session-message-handler.ts:175/180/186/198/211 + git-message-handler.ts:65/74/87/96/105。
  'message.status': { sessionId: string; status: string }
  // extension.discovered：installDir/installGit 的成功 reply（extension-message-handler.ts:162/176 reply { tempDir, candidates }）。
  // candidates 是发现的扩展候选列表（runtime ExtensionInfo[]，与 extension.ts ExtensionDiscoveredPayload 同构）。
  'extension.discovered': { tempDir: string; candidates: ExtensionInfo[] }
  // extension.installCancelled：cancelInstall reply（extension-message-handler.ts:205 reply {}）。
  'extension.installCancelled': Record<string, never>
  // extension.pendingRequests：getPendingRequests reply（extension-message-handler.ts:249 reply { sessionId, requests }）。
  // requests 元素是 runtime PendingUIRequest（runtime 专有类型，未下沉 shared），
  // 用 unknown[] 保持 shared 依赖最小化（与 extension.ui_request 的 askUserQuestions:unknown[] 先例一致）。
  'extension.pendingRequests': { sessionId: string; requests: unknown[] }
  // file.read:result：file.read reply（file-message-handler.ts:86 reply { content, truncated, path }，runtime 不发 sessionId）。
  // sessionId optional 对齐前端 file.ts:47 register（无 sessionId）+ rpc-type-pairing.test U1（带 sessionId 样本）。
  'file.read:result': { sessionId?: string; content: string; truncated: boolean; path: string }
  // config.scannedSkills：scanSkills reply（settings-message-handler.ts:69 reply { skills, success: true }）。
  'config.scannedSkills': { skills: SkillInfo[]; success: boolean }
  // config.scannedAgents：scanAgents reply（settings-message-handler.ts:99 reply { agents, success: true }）。
  'config.scannedAgents': { agents: AgentInfo[]; success: boolean }
  // config.discoveredModels：discoverModels reply（settings-message-handler.ts:178/180）。
  // 成功 { models, success: true }；失败 { models: [], success: false, error }（D10 降级响应，非 error envelope）。
  // models 元素形状对齐前端 config.ts:49 DiscoveredModelsResult（id + 可选 name/contextWindow）。
  'config.discoveredModels': {
    models: Array<{ id: string; name?: string; contextWindow?: number }>
    success: boolean
    error?: string
  }
  // config.providerUpdated：setProvider/deleteProvider reply（settings-message-handler.ts:37/51/65）。
  // 三种 shape：setProvider 成功 { saved: true }；deleteProvider { providerId, deleted: true }；
  // setProvider 首启用 fallback { providerId }（统一并集，字段均 optional 除共性外）。
  'config.providerUpdated': { providerId?: string; saved?: boolean; deleted?: boolean }
  // config.skillUpdated：setSkill reply（settings-message-handler.ts:86 reply { skill, success: true }）。
  'config.skillUpdated': { skill: SkillInfo; success: boolean }
  // config.skillDeleted：deleteSkill reply（settings-message-handler.ts:93 reply { skillId, success: true }）。
  'config.skillDeleted': { skillId: string; success: boolean }
  // config.agentUpdated：setAgent reply（settings-message-handler.ts:115 reply { agent, success: true }）。
  'config.agentUpdated': { agent: AgentInfo; success: boolean }
  // config.agentDeleted：deleteAgent reply（settings-message-handler.ts:122 reply { agentId, success: true }）。
  'config.agentDeleted': { agentId: string; success: boolean }

  // ── 消息流控制（W11+ 审查补充类型）──
  'message.auto_retry_start': { sessionId: string; attempt: number; maxAttempts?: number; delayMs?: number; errorMessage?: string }
  'message.auto_retry_end': { sessionId: string; success: boolean; attempt: number; finalError?: string }
  'message.queue_update': { sessionId: string; steering?: string[]; followUp?: string[] }
  // pi CustomMessage 注入（扩展经 pi.sendMessage 向对话流注入结构化通知，如 subagent-bg-notify）。
  // event-adapter 把 pi message_start{role:'custom', customType, content, details} 翻译为此帧。
  // 前端 customStart effect 建 role:'system' 消息（保留 customType/details），按 customType 渲染。
  'message.customStart': {
    sessionId: string
    customType: string
    content?: string
    details?: Record<string, unknown>
    display?: boolean
  }
}

/**
 * Runtime → Client payload 类型映射（与 ClientMessageMap 对称）。
 *
 * 精确条目见 ServerMessageMapBase（已消费 + 已契约化的 type）；其余未消费 / 协议待定的
 * type 走 `Record<string, unknown>` 占位，待对应 wave 实装时收紧：
 * message.* 进 W05-W07，plugin:* / extension:* widget 等属后续 wave。
 *
 * 收紧某条目时，runtime 构造点会同步得契约校验（若 payload 字段对不上，tsc 报错——D5 的预期收益）。
 */
export type ServerMessageMap = ServerMessageMapBase & {
  [K in Exclude<ServerMessageType, keyof ServerMessageMapBase>]: Record<string, unknown>
}

/**
 * Runtime → Client 消息。泛型化后 payload 按 type 收窄（见 ServerMessageMap）。
 *
 * 构造侧（runtime server.ts 的 send/reply/broadcast）仍可传 `ServerMessage`（默认 T=ServerMessageType，
 * payload 为联合）——存储/传输层不感知具体 type。消费侧 onGlobalType<T>/on<T> 收窄后才解构 payload。
 */
export interface ServerMessage<T extends ServerMessageType = ServerMessageType> {
  type: T
  id?: string
  payload: ServerMessageMap[T]
}

/**
 * # ReplyPayloadMap —— RPC request → reply payload 一级映射（方案C 精简版）。
 *
 * key = RPC 型 ClientMessageType（runtime 有成功 reply 的请求）。
 * value：
 * - **payload 消费型**：引用 `ServerMessageMap[<reply type>]`，domain 读取 reply 字段；
 * - **ack 型**：`void`，domain `register<void>` 不读 reply payload（状态变更由独立订阅通道推回）。
 *
 * 不含 fire-and-forget 型（extension.ui_response 无成功 reply）、不含订阅/通知型（ping 等）。
 * command<K>()（renderer api/request.ts）用此 map 推导返回类型：`Promise<ReplyPayloadMap[K]>`。
 *
 * 运行时漂移防御（RequestReplyMap 双向校验）在后续 wave，此处仅一级映射。
 */
export interface ReplyPayloadMap {
  // ── payload 消费型（value 引用 ServerMessageMap[<reply type>]）──
  'config.discoverModels': ServerMessageMap['config.discoveredModels']
  'config.getProviders': ServerMessageMap['config.providers']
  'config.scanAgents': ServerMessageMap['config.scannedAgents']
  'config.scanSkills': ServerMessageMap['config.scannedSkills']
  // 系统提示词配置（W2，FR-4/FR-5）：get/setSystemPrompt reply config.systemPrompt
  //   形状 `{ config, corrupted? }`。
  'config.getSystemPrompt': ServerMessageMap['config.systemPrompt']
  'config.setSystemPrompt': ServerMessageMap['config.systemPrompt']
  'extension.getPendingRequests': ServerMessageMap['extension.pendingRequests']
  'extension.installDir': ServerMessageMap['extension.discovered']
  'extension.installGit': ServerMessageMap['extension.discovered']
  'extension.recommended': ServerMessageMap['extension.recommended']
  'file.read': ServerMessageMap['file.read:result']
  'file.search': ServerMessageMap['file.search:result']
  'file.tree': ServerMessageMap['file.tree:result']
  'file.tree.expand': ServerMessageMap['file.tree.expand:result']
  'git.diff': ServerMessageMap['git.diff:result']
  'git.status': ServerMessageMap['git.status:result']
  'session.create': ServerMessageMap['session.created']
  'session.fork': ServerMessageMap['session.created']
  'session.getAgentCallFilePath': ServerMessageMap['session.agentCallFilePath']
  'session.getAgentCallHistory': ServerMessageMap['session.agentCallHistory']
  'session.getCommands': ServerMessageMap['session.commands']
  'session.getContext': ServerMessageMap['context.update']
  'session.getFullHistory': ServerMessageMap['session.fullHistory']
  'session.getSubagentHistory': ServerMessageMap['session.subagentHistory']
  'session.getSubagents': ServerMessageMap['session.subagents']
  'session.getWorkflows': ServerMessageMap['session.workflows']
  'session.history': ServerMessageMap['session.history']
  'config.sessions': ServerMessageMap['config.sessions']
  'workspace.listRecent': ServerMessageMap['workspace.recentList']
  'workspace.record': ServerMessageMap['workspace.recentList']

  // ── ack 型（value = void，domain register<void> 不读 reply payload）──
  'config.deleteAgent': void      // reply config.agentDeleted
  'config.deleteProvider': void   // reply config.providerUpdated
  'config.deleteSkill': void      // reply config.skillDeleted
  'config.setAgent': void         // reply config.agentUpdated
  'config.setAgentDirs': void     // reply config.agentDirs
  'config.setDefaultModel': void  // reply config.defaults
  'config.setProvider': void      // reply config.providerUpdated
  'config.setSkill': void         // reply config.skillUpdated
  'config.setSkillDirs': void     // reply config.skillDirs
  'extension.cancelInstall': void // reply extension.installCancelled
  'extension.finishInstall': void // reply config.extensions
  'extension.install': void       // reply config.extensions
  'extension.list': void          // reply config.extensions
  'extension.setAutoUpgrade': void // reply config.extensions
  'extension.toggle': void        // reply config.extensions
  'extension.uninstall': void     // reply config.extensions
  'extension.upgrade': void       // reply config.extensions
  'git.checkout': void            // reply message.status
  'git.commit': void              // reply message.status
  'git.createBranch': void        // reply message.status
  'git.stage': void               // reply message.status
  'git.unstage': void             // reply message.status
  'message.abort': void           // reply message.status
  'message.follow_up': void       // reply message.status
  'message.send': void            // reply message.status
  'message.steer': void           // reply message.status
  'model.switch': void            // reply model.switched（前端 model.ts register<void> 不读 payload）
  'session.compact': void         // reply session.compacted
  'session.delete': void          // reply session.deleted
  'session.rename': void          // reply session.renamed
  'session.setThinkingLevel': void // reply session.thinkingLevelSet
  'session.subagentAction': void  // reply session.subagentActionDone
  'session.switch': void          // reply session.history（前端不读 payload）
  'session.workflowAction': void  // reply session.workflowActionDone
}

/**
 * # 错误契约（D10/P0-B）
 *
 * 「告诉客户端操作失败」有三种语义通道，**不可混用**：
 *
 * 1. **请求级失败 → 统一 `error` envelope**（install / uninstall / toggle / file.read /
 *    steer / followUp 等同步请求的失败回复）。客户端只需一处 catch：
 *    `{ type:'error', id, payload:{ code, message, sessionId?, details? } }`。
 *    扩展信息（hint / path 等）进 `details`，不再为每种失败造独立 *Error 子类型。
 *
 * 2. **流式异步推送失败 → `message.error`**（message-dispatcher 在 streaming 过程中广播，
 *    非「请求回复」而是「server-push 通道」）。payload: `{ sessionId, message }`。
 *
 * 3. **部分成功的降级响应 → 内联 `success:false`**
 *    （config.discoveredModels 成功/失败共用同 type 用 `success` 字段区分）。**不是错误**，
 *    是带错误信息的成功响应——保留各自 type，不并入 error envelope。
 *
 * 此前 6 种碎片化形状（extension.installError / file.read:error / ...）已统一：
 * `extension.installError` 和 `file.read:error` type 已删除（客户端 0 消费者时合并）。
 *
 * 领域 DTO（ExtensionInfo / GitStatusResult / PluginInfo / StatusBarItem …）已下沉到
 * extension.ts / git.ts / plugin.ts，本文件顶部 import 引用，ServerMessageMapBase 照常引用。
 */
