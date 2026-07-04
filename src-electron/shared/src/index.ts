export type {
  ClientMessageType, ClientMessage, ClientMessageMap,
  SetProviderData,
  ServerMessageType, ServerMessage, ServerMessageMap, ServerMessageMapBase,
} from './protocol'
export type {
  MessageRole, MessageStatus, ToolCallStatus,
  ToolCall, ThinkingBlock, ContentBlockType, ContentBlock, Usage, Message,
  FileChangeStatus, FileChange, ChangeSetStatus, ReviewDecision,
  BashExecution, CompactionSummary, BranchSummary,
} from './message'
export type {
  SessionStatus, SessionSummary, SessionGroup,
} from './session'
export type {
  ProviderStatus, ProviderInfo, ModelInfo,
  SkillInfo, AgentInfo,
  ScanSourceType, ScannedSkillInfo, ScannedAgentInfo,
  DiscoveryConfig, SkillDirConfig,
} from './provider'
export type { ToolPermission, ThemeMode, ThemePreset } from './settings'
export type {
  PanelLeaf, SplitNode, PanelTree, WindowState,
} from './panel'
export * from './extension'
export * from './git'
export * from './plugin'
export { BASE_PORT, DEV_PORT_OFFSET, MAX_PORT, ENV_WHITELIST_PREFIXES } from './constants'
// 推荐扩展列表 SSOT（runtime 读取，前端经 extension.recommended WS 拉取）
import recommendedExtensions from './recommended-extensions.json'
export { recommendedExtensions }
// 注意：paths.ts（getDataDir/getPiAgentDir）刻意不在此 barrel 导出。
// 它们依赖 node:os / node:path，而本 barrel 被 renderer（浏览器）整包 import。
// Node-only 消费方（main/runtime）从子路径 import：'@xyz-agent/shared/paths'
export * from './file-tree'
export * from './ignore-parser'
export * from './git-status-parser'
export type { RecentWorkspaceRecord } from './workspace'
