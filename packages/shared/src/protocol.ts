// Client → Runtime message types

import type { ProviderInfo, SkillInfo, AgentInfo, ModelInfo, SkillDirConfig } from './provider'
import type { SessionGroup } from './session'
import type { FileChange, ChangeSetStatus } from './message'
import type { FileNode } from './file-tree'
// 领域 DTO 已下沉到各自领域文件（E2 架构候选）：protocol.ts 仅保留 type→payload 映射 SSOT，
// 领域形状（ExtensionInfo / GitStatusResult / PluginInfo …）按领域就近归属。
import type { ExtensionInfo, RecommendedExtension } from './extension'
import type { GitStatusResult } from './git'
import type { PluginInfo } from './plugin'
import type { RecentWorkspaceRecord } from './workspace'

// ── ClientMessageType（保持向后兼容）──────────────────────────

export type ClientMessageType =
  | 'session.create' | 'session.delete' | 'session.list' | 'session.switch' | 'session.history' | 'session.getCommands' | 'session.getContext'
  | 'session.compact' | 'session.rename'
  | 'message.send' | 'message.abort' | 'message.steer' | 'message.follow_up'
  | 'config.getProviders' | 'config.setProvider' | 'config.deleteProvider' | 'config.setToolPermissions'
  | 'config.discoverModels'
  | 'config.scanSkills' | 'config.setSkill' | 'config.deleteSkill'
  | 'config.scanAgents' | 'config.setAgent' | 'config.deleteAgent'
  | 'config.setSkillDirs' | 'config.setAgentDirs'
  | 'model.list' | 'model.switch' | 'session.setThinkingLevel'
  | 'tool.approve' | 'tool.deny' | 'tool.always_allow'
  | 'extension.ui_response' | 'extension.toggle' | 'extension.list'
  | 'extension.install' | 'extension.uninstall'
  | 'extension.installDir' | 'extension.installGit' | 'extension.finishInstall' | 'extension.cancelInstall'
  | 'extension.recommended'
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
  | 'workspace.listRecent'

// ── Payload 类型定义 ────────────────────────────────────────────

/** config.setProvider 除 providerId 外的透传字段，与 IConfigService.setProvider 参数对齐 */
export interface SetProviderData {
  name?: string
  type?: string
  apiKey?: string
  baseUrl?: string
  models?: Array<string | { id: string; name?: string; contextWindow?: number; input?: Array<'text' | 'image'>; thinkingLevelMap?: Record<string, string | null> }>
  enabled?: boolean
}

// ── ClientMessage discriminated union ───────────────────────────

/** 每个 type 对应的 payload 类型映射 */
export interface ClientMessageMap {
  'ping': Record<string, never>
  // hidden:true 创建隐藏 session（公共 session），不进 sidebar 列表，仅供内部使用。
  'session.create': { cwd?: string; label?: string; hidden?: boolean }
  'session.delete': { sessionId: string }
  'session.list': Record<string, never>
  'session.switch': { sessionId: string }
  'session.history': { sessionId: string }
  'session.getCommands': { sessionId: string }
  'session.getContext': { sessionId: string }
  'session.compact': { sessionId: string; customInstructions?: string }
  'session.rename': { sessionId: string; name: string }
  'message.send': { sessionId: string; content: string; subagent?: { agent: string; task: string } }
  'message.abort': { sessionId: string }
  'message.steer': { sessionId: string; content: string }
  'message.follow_up': { sessionId: string; content: string }
  'config.getProviders': Record<string, never>
  'config.setProvider': { providerId: string } & SetProviderData
  'config.deleteProvider': { providerId: string }
  'config.setToolPermissions': { permissions: Record<string, string> }
  'config.discoverModels': { baseUrl: string; apiKey?: string; providerType?: string; providerId?: string }
  'config.scanSkills': { sources: string[] }
  'config.setSkill': { skill: SkillInfo }
  'config.deleteSkill': { skillId: string }
  'config.scanAgents': { sources: string[] }
  'config.setAgent': { agent: AgentInfo }
  'config.deleteAgent': { agentId: string }
  /** 目录级管道写入（ADR-0020 §5）：dirs 为有序数组，靠前覆盖靠后。写 discovery.json。 */
  'config.setSkillDirs': { dirs: string[] }
  'config.setAgentDirs': { dirs: string[] }
  'model.list': Record<string, never>
  'model.switch': { sessionId: string; provider: string; modelId: string }
  'session.setThinkingLevel': { sessionId: string; level: string }
  'tool.approve': { sessionId: string; toolCallId?: string }
  'tool.deny': { sessionId: string; toolCallId?: string; reason?: string }
  'tool.always_allow': { sessionId: string; toolName?: string }
  'extension.ui_response': { sessionId: string; requestId: string; result: boolean | string | null }
  'extension.toggle': { name: string; enabled: boolean }
  'extension.list': Record<string, never>
  'extension.install': { source: string }
  'extension.uninstall': { name: string }
  'extension.installDir': { path: string }
  'extension.installGit': { url: string }
  'extension.finishInstall': { tempDir: string; selected: string[] }
  'extension.cancelInstall': { tempDir: string }
  'extension.recommended': Record<string, never>
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

export type ServerMessageType =
  | 'session.created' | 'session.deleted' | 'session.list' | 'session.history'
  | 'session.compacting' | 'session.compacted' | 'session.renamed'
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
  | 'model.list' | 'model.switched'
  | 'session.thinkingLevelSet'
  | 'session.state_changed'
  | 'pong' | 'error'
  | 'extension.ui_request' | 'extension.ui_timeout' | 'extension.error'
  | 'extension.discovered' | 'extension.installCancelled'
  | 'extension.recommended'
  | 'message.tool_call_update' | 'config.extensions'
  | 'session.commands'
  | 'app.info'
  | 'config.plugins' | 'plugin:crashed' | 'plugin:notification'
  | 'plugin:statusChange' | 'plugin:permissionRequest'
  | 'plugin:statusBarUpdate' | 'plugin:messageDecoration' | 'plugin:config'
  | 'plugin:statusSetUpdate'
  | 'plugin:uiRequest'
  | 'extension:widget' | 'extension:status'
  | 'message.compactionSummary'
  | 'extension:setEditorText'
  | 'message.bashExecution' | 'message.compactionSummary' | 'message.branchSummary'
  | 'message.auto_retry_start' | 'message.auto_retry_end' | 'message.queue_update'
  | 'message.stream_error'
  | 'message.file_changes'
  | 'message.changeSetInvalidated'
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
  'config.defaults': { defaultModel: string }
  'config.extensions': { extensions: ExtensionInfo[] }
  /** extension.recommended reply：推荐扩展列表（含已安装状态） */
  'extension.recommended': { recommended: Array<RecommendedExtension & { installed: boolean }> }
  'config.plugins': { plugins: PluginInfo[] }
  'model.list': { models: ModelInfo[] }
  'session.list': { groups: SessionGroup[] }

  // ── 协议级 reply / push（精确）──
  'pong': Record<string, never>
  'error': { code: string; message: string; sessionId?: string; details?: Record<string, unknown> }
  // 流式异步推送失败（server-push 通道，区别于请求级 error envelope；见错误契约文档）
  'message.error': { sessionId: string; message: string }
  // 扩展 UI 推送通道（EventAdapter 翻译 pi setWidget/setStatus，runtime 固定形状生产）
  'extension:widget': { sessionId: string; widgetKey: string; lines: string[] }
  'extension:status': { sessionId: string; statusKey: string; text: string }
  // session 通道推送（runtime session-service / index.ts 生产，W04 收紧）
  'session.compacting': { sessionId: string }
  'session.compacted': { sessionId: string; status: 'compacted'; error?: string }
  // session.commands：pi 扩展命令列表（fetchAndBroadcastCommands 广播）
  'session.commands': { sessionId: string; commands: Array<{ name: string; description?: string; source: string }> }
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

  // ── 消息流控制（W11+ 审查补充类型）──
  'message.auto_retry_start': { sessionId: string; attempt: number; maxAttempts?: number; delayMs?: number; errorMessage?: string }
  'message.auto_retry_end': { sessionId: string; success: boolean; attempt: number; finalError?: string }
  'message.queue_update': { sessionId: string; steering?: string[]; followUp?: string[] }
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
