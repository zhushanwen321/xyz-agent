// Client → Runtime message types

import type { ProviderInfo, SkillInfo, AgentInfo, ModelInfo } from './provider'
import type { SessionGroup } from './session'
import type { FileChange, ChangeSetStatus } from './message'

// ── ClientMessageType（保持向后兼容）──────────────────────────

export type ClientMessageType =
  | 'session.create' | 'session.delete' | 'session.list' | 'session.switch' | 'session.history'
  | 'session.compact' | 'session.rename'
  | 'message.send' | 'message.abort' | 'message.steer' | 'message.follow_up'
  | 'config.getProviders' | 'config.setProvider' | 'config.deleteProvider' | 'config.setToolPermissions'
  | 'config.discoverModels'
  | 'config.scanSkills' | 'config.setSkill' | 'config.deleteSkill'
  | 'config.scanAgents' | 'config.setAgent' | 'config.deleteAgent'
  | 'model.list' | 'model.switch' | 'session.setThinkingLevel'
  | 'tool.approve' | 'tool.deny' | 'tool.always_allow'
  | 'extension.ui_response' | 'extension.toggle' | 'extension.list'
  | 'extension.install' | 'extension.uninstall'
  | 'extension.installDir' | 'extension.installGit' | 'extension.finishInstall' | 'extension.cancelInstall'
  | 'ping'
  | 'session.tree-data' | 'session.tree-navigate' | 'session.tree-fork' | 'session.tree-clone' | 'session.tree-capability'
  | 'plugin.list' | 'plugin.toggle'
  | 'plugin.install' | 'plugin.uninstall'
  | 'plugin.approvePermissions' | 'plugin.revokePermissions'
  | 'plugin.executeCommand'
  | 'plugin.config.get' | 'plugin.config.set'
  | 'plugin.uiResponse'
  | 'file.read'

// ── Payload 类型定义 ────────────────────────────────────────────

/** config.setProvider 除 providerId 外的透传字段，与 IConfigService.setProvider 参数对齐 */
export interface SetProviderData {
  name?: string
  type?: string
  apiKey?: string
  baseUrl?: string
  models?: Array<string | { id: string; name?: string; contextWindow?: number; thinkingLevelMap?: Record<string, string | null> }>
  enabled?: boolean
}

// ── ClientMessage discriminated union ───────────────────────────

/** 每个 type 对应的 payload 类型映射 */
export interface ClientMessageMap {
  'ping': Record<string, never>
  'session.create': { cwd?: string; label?: string }
  'session.delete': { sessionId: string }
  'session.list': Record<string, never>
  'session.switch': { sessionId: string }
  'session.history': { sessionId: string }
  'session.compact': { sessionId: string }
  'session.rename': { sessionId: string; name: string }
  'message.send': { sessionId: string; content: string; subagent?: { agent: string; task: string } }
  'message.abort': { sessionId: string }
  'message.steer': { sessionId: string; content: string }
  'message.follow_up': { sessionId: string; content: string }
  'session.tree-data': { sessionId: string }
  'session.tree-navigate': { sessionId: string; targetEntryId: string }
  'session.tree-fork': { sessionId: string; entryId: string }
  'session.tree-clone': { sessionId: string }
  'session.tree-capability': { sessionId: string }
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
  'file.read': { path: string }
}

export type ClientMessage =
  | { type: 'ping'; id?: string; payload: Record<string, never> }
  | { type: 'session.create'; id?: string; payload: ClientMessageMap['session.create'] }
  | { type: 'session.delete'; id?: string; payload: ClientMessageMap['session.delete'] }
  | { type: 'session.list'; id?: string; payload: Record<string, never> }
  | { type: 'session.switch'; id?: string; payload: ClientMessageMap['session.switch'] }
  | { type: 'session.history'; id?: string; payload: ClientMessageMap['session.history'] }
  | { type: 'session.compact'; id?: string; payload: ClientMessageMap['session.compact'] }
  | { type: 'session.rename'; id?: string; payload: ClientMessageMap['session.rename'] }
  | { type: 'message.send'; id?: string; payload: ClientMessageMap['message.send'] }
  | { type: 'message.abort'; id?: string; payload: ClientMessageMap['message.abort'] }
  | { type: 'message.steer'; id?: string; payload: ClientMessageMap['message.steer'] }
  | { type: 'message.follow_up'; id?: string; payload: ClientMessageMap['message.follow_up'] }
  | { type: 'session.tree-data'; id?: string; payload: ClientMessageMap['session.tree-data'] }
  | { type: 'session.tree-navigate'; id?: string; payload: ClientMessageMap['session.tree-navigate'] }
  | { type: 'session.tree-fork'; id?: string; payload: ClientMessageMap['session.tree-fork'] }
  | { type: 'session.tree-clone'; id?: string; payload: ClientMessageMap['session.tree-clone'] }
  | { type: 'session.tree-capability'; id?: string; payload: ClientMessageMap['session.tree-capability'] }
  | { type: 'config.getProviders'; id?: string; payload: Record<string, never> }
  | { type: 'config.setProvider'; id?: string; payload: ClientMessageMap['config.setProvider'] }
  | { type: 'config.deleteProvider'; id?: string; payload: ClientMessageMap['config.deleteProvider'] }
  | { type: 'config.setToolPermissions'; id?: string; payload: ClientMessageMap['config.setToolPermissions'] }
  | { type: 'config.discoverModels'; id?: string; payload: ClientMessageMap['config.discoverModels'] }
  | { type: 'config.scanSkills'; id?: string; payload: ClientMessageMap['config.scanSkills'] }
  | { type: 'config.setSkill'; id?: string; payload: ClientMessageMap['config.setSkill'] }
  | { type: 'config.deleteSkill'; id?: string; payload: ClientMessageMap['config.deleteSkill'] }
  | { type: 'config.scanAgents'; id?: string; payload: ClientMessageMap['config.scanAgents'] }
  | { type: 'config.setAgent'; id?: string; payload: ClientMessageMap['config.setAgent'] }
  | { type: 'config.deleteAgent'; id?: string; payload: ClientMessageMap['config.deleteAgent'] }
  | { type: 'model.list'; id?: string; payload: Record<string, never> }
  | { type: 'model.switch'; id?: string; payload: ClientMessageMap['model.switch'] }
  | { type: 'session.setThinkingLevel'; id?: string; payload: ClientMessageMap['session.setThinkingLevel'] }
  | { type: 'tool.approve'; id?: string; payload: ClientMessageMap['tool.approve'] }
  | { type: 'tool.deny'; id?: string; payload: ClientMessageMap['tool.deny'] }
  | { type: 'tool.always_allow'; id?: string; payload: ClientMessageMap['tool.always_allow'] }
  | { type: 'extension.ui_response'; id?: string; payload: ClientMessageMap['extension.ui_response'] }
  | { type: 'extension.toggle'; id?: string; payload: ClientMessageMap['extension.toggle'] }
  | { type: 'extension.list'; id?: string; payload: ClientMessageMap['extension.list'] }
  | { type: 'extension.install'; id?: string; payload: ClientMessageMap['extension.install'] }
  | { type: 'extension.uninstall'; id?: string; payload: ClientMessageMap['extension.uninstall'] }
  | { type: 'extension.installDir'; id?: string; payload: ClientMessageMap['extension.installDir'] }
  | { type: 'extension.installGit'; id?: string; payload: ClientMessageMap['extension.installGit'] }
  | { type: 'extension.finishInstall'; id?: string; payload: ClientMessageMap['extension.finishInstall'] }
  | { type: 'extension.cancelInstall'; id?: string; payload: ClientMessageMap['extension.cancelInstall'] }
  | { type: 'plugin.list'; id?: string; payload: Record<string, never> }
  | { type: 'plugin.toggle'; id?: string; payload: ClientMessageMap['plugin.toggle'] }
  | { type: 'plugin.install'; id?: string; payload: ClientMessageMap['plugin.install'] }
  | { type: 'plugin.uninstall'; id?: string; payload: ClientMessageMap['plugin.uninstall'] }
  | { type: 'plugin.approvePermissions'; id?: string; payload: ClientMessageMap['plugin.approvePermissions'] }
  | { type: 'plugin.revokePermissions'; id?: string; payload: ClientMessageMap['plugin.revokePermissions'] }
  | { type: 'plugin.executeCommand'; id?: string; payload: ClientMessageMap['plugin.executeCommand'] }
  | { type: 'plugin.config.get'; id?: string; payload: ClientMessageMap['plugin.config.get'] }
  | { type: 'plugin.config.set'; id?: string; payload: ClientMessageMap['plugin.config.set'] }
  | { type: 'plugin.uiResponse'; id?: string; payload: ClientMessageMap['plugin.uiResponse'] }
  | { type: 'file.read'; id?: string; payload: ClientMessageMap['file.read'] }

// ── 辅助类型 ────────────────────────────────────────────────────

/** 根据 type 提取对应的 payload 类型 */
export type ExtractPayload<T extends ClientMessageType> = T extends keyof ClientMessageMap ? ClientMessageMap[T] : never

/** 构造特定 type 的 ClientMessage */
export type SpecificClientMessage<T extends ClientMessageType> = Extract<ClientMessage, { type: T }>

// ── Runtime → Client message types ──────────────────────────────

export type ServerMessageType =
  | 'session.created' | 'session.deleted' | 'session.list' | 'session.history'
  | 'session.compacting' | 'session.compacted' | 'session.renamed'
  | 'message.message_start' | 'message.text_delta' | 'message.thinking_delta'
  | 'message.thinking_start' | 'message.thinking_end'
  | 'message.tool_call_start' | 'message.tool_call_end' | 'message.tool_call_pending'
  | 'message.complete' | 'message.error' | 'message.status'
  | 'context.update'
  | 'config.providers' | 'config.providerUpdated' | 'config.discoveredModels' | 'config.defaults'
  | 'config.scannedSkills' | 'config.skillUpdated' | 'config.skillDeleted'
  | 'config.scannedAgents' | 'config.agentUpdated' | 'config.agentDeleted'
  | 'config.skills' | 'config.agents'
  | 'model.list' | 'model.switched'
  | 'session.thinkingLevelSet'
  | 'pong' | 'error'
  | 'extension.ui_request' | 'extension.ui_timeout' | 'extension.error'
  | 'extension.discovered' | 'extension.installCancelled'
  | 'message.tool_call_update' | 'config.extensions'
  | 'session.commands'
  | 'session.tree-data' | 'session.tree-navigate-result' | 'session.tree-fork-result' | 'session.tree-clone-result' | 'session.tree-capability'
  | 'config.plugins' | 'plugin:crashed' | 'plugin:notification'
  | 'plugin:statusChange' | 'plugin:permissionRequest'
  | 'plugin:statusBarUpdate' | 'plugin:messageDecoration' | 'plugin:config'
  | 'plugin:statusSetUpdate'
  | 'plugin:uiRequest'
  | 'extension:widget' | 'extension:status'
  | 'extension:setEditorText'
  | 'message.bashExecution' | 'message.compactionSummary' | 'message.branchSummary'
  | 'message.auto_retry_start' | 'message.auto_retry_end' | 'message.queue_update'
  | 'message.stream_error'
  | 'message.file_changes'
  | 'file.read:result'

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
  'config.defaults': { defaultModel: string }
  'config.extensions': { extensions: ExtensionInfo[] }
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
  // session.commands：pi 扩展命令列表（fetchAndBroadcastCommands 广播）
  'session.commands': { sessionId: string; commands: Array<{ name: string; description?: string; source: string }> }
  // context.update：上下文用量（index.ts onContextUpdate 推；cacheHit/modelId 无来源，D9 保留 UI 占位）
  'context.update': { sessionId: string; usagePercent: number; inputTokens: number; contextLimit: number }
  // FileChanges 通道（ADR-0024 D7）：runtime event-adapter 从 write/edit 工具提取 + git 对账。
  // accumulating（isFullSet=false，每条 tool_end 增量）+ ready（isFullSet=true，agent_end git 对账全集）。
  // partially-reviewed/resolved/superseded 审查态由前端驱动，不经 runtime 推送。
  'message.file_changes': {
    sessionId: string
    messageId: string
    fileChanges: FileChange[]
    changeSetStatus: ChangeSetStatus
    isFullSet: boolean
  }
}

/**
 * Runtime → Client payload 类型映射（与 ClientMessageMap 对称）。
 *
 * 精确条目见 ServerMessageMapBase（已消费 + 已契约化的 type）；其余未消费 / 协议待定的
 * type 走 `Record<string, unknown>` 占位，待对应 wave 实装时收紧：
 * message.* 进 W05-W07，plugin:* / extension:* widget 等属后续 wave，tree-* 不做。
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

/** 根据 type 提取对应的 server payload 类型 */
export type ExtractServerPayload<T extends ServerMessageType> = ServerMessageMap[T]

/** 构造特定 type 的 ServerMessage */
export type SpecificServerMessage<T extends ServerMessageType> = ServerMessage<T>

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
 * 3. **部分成功的降级响应 → 内联 `success:false`**（tree 的 tree 部分可用 + 返回降级空数组；
 *    config.discoveredModels 成功/失败共用同 type 用 `success` 字段区分）。**不是错误**，
 *    是带错误信息的成功响应——保留各自 type，不并入 error envelope。
 *
 * 此前 6 种碎片化形状（extension.installError / file.read:error / ...）已统一：
 * `extension.installError` 和 `file.read:error` type 已删除（客户端 0 消费者时合并）。
 */

// ── Extension payload interfaces ────────────────────────────────

/** Interactive extension UI methods that produce extension.ui_request WS events */
export type ExtensionUIMethod = 'confirm' | 'select' | 'input' | 'notify' | 'editor'

export interface ExtensionUIRequestPayload {
  sessionId: string
  requestId: string
  method: ExtensionUIMethod
  title?: string
  message?: string
  options?: string[]
  default?: string
  level?: 'info' | 'warn' | 'error'
  /** Origin of the request — determines which WS channel the response is sent to */
  source?: 'extension' | 'plugin'
}

export interface ExtensionUIResponsePayload {
  sessionId: string
  requestId: string
  result: boolean | string | null
}

export interface ExtensionErrorPayload {
  sessionId: string
  extensionName: string
  error: string
  errorEvent?: string
}

export interface ToolCallUpdatePayload {
  sessionId: string
  toolCallId: string
  progress?: number
  detail?: string | Record<string, unknown>
}

export interface ExtensionInfo {
  name: string
  /** Filesystem directory basename (may differ from npm package name for scoped packages) */
  dirName: string
  version: string
  description: string
  path: string
  enabled: boolean
  source: 'built-in' | 'user-installed'
}

// ── Extension install flow payload interfaces ──────────────────

export interface ExtensionDiscoveredPayload {
  tempDir: string
  candidates: ExtensionInfo[]
}

// 注：ExtensionInstallErrorPayload 已删除（D10/P0-B）——install 失败现在走统一 error envelope，
// hint 进 details.hint。见上方「错误契约」文档注释。

// ── Plugin payload interfaces ───────────────────────────────────

export interface PluginInfo {
  pluginId: string
  version: string
  displayName: string
  description: string
  status: 'discovered' | 'loaded' | 'active' | 'inactive' | 'crashed'
  trustLevel: 'trusted' | 'sandbox'
  enabled: boolean
}

export interface PluginCrashedPayload {
  pluginId: string
  workerId: string
  error: string
}

export interface PluginNotificationPayload {
  pluginId: string
  level: 'info' | 'warning' | 'error'
  message: string
}

// ── Plugin Server → Client payload interfaces ────────────────────

export interface PluginStatusChangePayload {
  pluginId: string
  oldStatus: string
  newStatus: string
}

export interface PluginPermissionRequestPayload {
  pluginId: string
  permissions: string[]
}

export interface StatusBarItem {
  id: string
  pluginId: string
  text: string
  tooltip?: string
  commandId?: string
  priority: number
  scope: 'per-session' | 'global'
  sessionId?: string
}

export interface PluginStatusBarUpdatePayload {
  items: StatusBarItem[]
}

export interface StatusSetUpdatePayload {
  sessionId: string
  key: string
  text: string
}

export interface MessageDecoration {
  type: string
  pluginId: string
  label: string
  color?: string
  commandId?: string
}

export interface PluginMessageDecorationPayload {
  sessionId: string
  messageId: string
  decorations: MessageDecoration[]
}

export interface PluginConfigPayload {
  pluginId: string
  config: Record<string, unknown>
}

// ── StopReason / SendMode helpers ─────────────────────────────

/** Possible reasons a stream completed */
export type StopReason = 'complete' | 'aborted' | 'error' | 'length' | 'tool_use'

/** UI-facing send mode values */
export type UISendMode = 'send' | 'steer' | 'queue'

/** Protocol-level send mode values (queue → follow-up) */
export type ProtocolSendMode = 'send' | 'steer' | 'follow-up'

/** UI send mode → protocol send mode mapping */
export function toProtocolSendMode(mode: UISendMode): ProtocolSendMode {
  return mode === 'queue' ? 'follow-up' : mode
}
