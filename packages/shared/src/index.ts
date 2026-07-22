export type {
  ClientMessageType, ClientMessage, ClientMessageMap,
  SetProviderData,
  ServerMessageType, ServerMessage, ServerMessageMap, ServerMessageMapBase,
  ReplyPayloadMap,
  SystemPromptConfig,
  CommandSourceInfo,
  WorktreeErrorCode, WorktreeUnknownErrorCode, WorktreeEnvelopeCode,
} from './protocol'
export type {
  MessageRole, MessageStatus, ToolCallStatus,
  ToolCall, ThinkingBlock, ContentBlockType, ContentBlock, Usage, Message,
  FileChangeStatus, FileChange, ChangeSetStatus, ReviewDecision,
  CompactionSummary, BranchSummary, SteerFollowUpMode,
  BgNotifyRecord, BgNotifyDetails,
} from './message'
export { parseBgNotifyDetails } from './message'
export type { Segment } from './segments'
export { segmentsToText, textToSegments, segmentsToPrompt, normalizeContent } from './segments'
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
export { BASE_PORT, DEV_PORT_OFFSET, MAX_PORT, ENV_WHITELIST_PREFIXES, SUBAGENT_TOOL_NAMES, HIDDEN_TOOL_NAMES, WORKFLOW_TOOL_NAMES, PROVIDER_API_TYPES, KNOWN_PI_API_TYPES, SYSTEM_PROMPT_MAX_LENGTH } from './constants'
export type { ProviderApiType } from './constants'
export { DEFAULT_PI_SYSTEM_PROMPT, DEFAULT_PI_SYSTEM_PROMPT_VERSION } from './pi-default-prompt'
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
export type { SubagentRecord, SubagentStatus } from './subagent'
export { normalizeSubagentStatus } from './subagent'
export type {
  WorkflowRunStatus,
  WorkflowDoneReason,
  WorkflowAgentCall,
  WorkflowRunRecord,
} from './workflow'
