export type {
  ClientMessageType, ClientMessage, ClientMessageMap,
  SetProviderData,
  ServerMessageType, ServerMessage, ServerMessageMap, ServerMessageMapBase, ServerMessageUnion,
  ReplyPayloadMap,
  BatchDeleteResult,
  SystemPromptConfig,
  CommandSourceInfo,
  WorktreeErrorCode, WorktreeUnknownErrorCode, WorktreeEnvelopeCode,
  TerminalConfig, TerminalErrorCode, TerminalUnknownErrorCode, TerminalEnvelopeCode,
  SkillCacheScope, SkillCacheInvalidatedPayload,
  SessionTraceHeaderPayload, SessionTraceMalformedLine, SessionTraceSessionEndPayload,
  SessionViewSnapshot,
} from './protocol'
export { isMessage, isSessionSummary, isSubagentRecord } from './protocol'
export type {
  MessageRole, MessageStatus, ToolCallStatus,
  ToolCall, ThinkingBlock, ContentBlockType, ContentBlock, Usage, Message,
  FileChangeStatus, FileChange, ChangeSetStatus, ReviewDecision,
  CompactionSummary, BranchSummary, SteerFollowUpMode,
  BgNotifyRecord, BgNotifyDetails,
  SubagentDirectiveData,
} from './message'
export { parseBgNotifyDetails, COMPLETE_NOTIFY_CUSTOM_TYPES, SUBAGENT_DIRECTIVE_CUSTOM_TYPE, parseSubagentDirective } from './message'
// w21 pi-entry：pi session entry wire 类型（runtime 实时重构 ↔ core reducer ↔ protocol payload 三方共用）
export type {
  PiEntry, PiEntryBase, PiMessageEntry, PiMessageBody,
  PiCustomEntry, PiLabelEntry, PiCompactionEntry, PiBranchSummaryEntry, PiCustomMessageEntry,
  PiToolCallEntryForm,
} from './pi-entry'
export type { Segment } from './segments'
export { segmentsToText, textToSegments, segmentsToPrompt, normalizeContent } from './segments'
export type { SegmentsMetadataFile, SegmentsMetadataEntry } from './message-metadata'
export type {
  SessionStatus, SessionSummary, SessionGroup,
} from './session'
export type {
  ProviderStatus, ProviderInfo, BuiltinProviderTemplate, BuiltinOAuthConfig, ModelInfo,
  SkillInfo, AgentInfo,
  ScanSourceType, ScannedSkillInfo, ScannedAgentInfo,
  DiscoveryConfig, DiscoveryConfigV1, SkillDirConfig,
  ProviderId, ModelId,
} from './provider'
// v1→v2 discovery.json 迁移纯函数（discovery-migrate.ts）
export { migrateDiscoveryV1ToV2 } from './discovery-migrate'
export type { ToolPermission, ThemeMode, ThemePreset } from './settings'
export type {
  PanelLeaf, WindowState,
} from './panel'
// LLM 重试配置域（类型 + D8 合法域常量 + 校验纯函数，renderer 表单与 runtime 写入侧共用）
export type { LlmRetryConfig, LlmRetryProviderConfig } from './llm-retry'
export { LLM_RETRY_DOMAIN, validateLlmRetryConfig } from './llm-retry'
export * from './extension'
export * from './git'
export * from './plugin'
export { BASE_PORT, DEV_PORT_OFFSET, MAX_PORT, ENV_WHITELIST_PREFIXES, AMBIENT_ENV_NAMES, SUBAGENT_TOOL_NAMES, WORKFLOW_TOOL_NAMES, SUBAGENT_RECORD_CUSTOM_TYPE, WORKFLOW_RECORD_CUSTOM_TYPE, PROVIDER_API_TYPES, KNOWN_PI_API_TYPES, SYSTEM_PROMPT_MAX_LENGTH, PRESET_SKILL_DIRS, PRESET_AGENT_DIRS, PRESET_EXTENSION_DIRS, IMAGE_LIMITS, MAX_WS_PAYLOAD_BYTES, PLUGIN_NOTIFY_LIMITS, UI_TOAST_LIMITS } from './constants'
export type { ProviderApiType } from './constants'
// 出站 env 契约 SSOT + 子进程 env 构建器（纯常量/纯函数无 node 依赖，renderer barrel 安全）。
// main 进程 safe-env 薄封装与 runtime infra/spawn-env.ts 门面均经此消费。
export type { BuildOutboundChildEnvOptions, SpawnEnvForwardEntry } from './spawn-env-contract'
export {
  SPAWN_ENV_OUTBOUND_DENY_LIST,
  SPAWN_ENV_FORWARD_REFERENCE,
  composeChildEnvBase,
  buildOutboundChildEnv,
} from './spawn-env-contract'
export { DEFAULT_PI_SYSTEM_PROMPT, DEFAULT_PI_SYSTEM_PROMPT_VERSION } from './pi-default-prompt'
// 推荐扩展列表 SSOT（runtime 读取，前端经 extension.recommended WS 拉取）
// 带类型断言：空 JSON [] 会被 TS 推断为 never[]，断言为 RecommendedExtension[] 保证未来追加条目时类型正确
import recommendedExtensionsRaw from './recommended-extensions.json'
import type { RecommendedExtension } from './extension'
const recommendedExtensions = recommendedExtensionsRaw as RecommendedExtension[]
export { recommendedExtensions }
// 强制安装扩展列表 SSOT（runtime boot 时自动安装+升级）
// 带类型断言：JSON import 默认推断为宽泛类型，断言为 MandatoryExtension[] 保证 tier 字段拼写错误编译期可捕获
import mandatoryExtensionsRaw from './mandatory-extensions.json'
import type { MandatoryExtension } from './extension'
const mandatoryExtensions = mandatoryExtensionsRaw as MandatoryExtension[]
export { mandatoryExtensions }
// 注意：paths.ts（getDataDir/getPiAgentDir）刻意不在此 barrel 导出。
// 它们依赖 node:os / node:path，而本 barrel 被 renderer（浏览器）整包 import。
// Node-only 消费方（main/runtime）从子路径 import：'@xyz-agent/shared/paths'
export * from './file-tree'
export type { RecentWorkspaceRecord } from './workspace'
export type { Project, ProjectStoreState } from './project'
export type { SubagentRecord, SubagentStatus, ClosedDisplayStatus } from './subagent'
// 虚拟 session ID 工厂（subagent 三段式 / agent call 两段式）——跨层协议级 key 约定 SSOT
export {
  SUBAGENT_PREFIX,
  subagentVirtualId,
  isSubagentVirtualId,
  extractSubagentId,
  extractMainSessionId,
  AGENTCALL_PREFIX,
  agentCallVirtualId,
  isAgentCallVirtualId,
  extractAgentCallSessionId,
} from './virtual-session-id'
// subagent.stream_delta 帧父 session 解析（idle-refresh 桥接纯函数，双通道形态归一）
export { resolveSubagentParentSessionId } from './subagent-frame'
// Coding Plan 额度查询类型
export type {
  QuotaWindow,
  QuotaWins,
  NormalizedQuotaRow,
  ProviderQuotaFetcher,
  QuotaAuthKind,
  QuotaFetchFailureReason,
  QuotaFetchOutcome,
  QuotaFetcherConfig,
  QuotaWorkspaceNormalizeResult,
} from './quota-types'
export { normalizeQuotaWorkspaceUrl } from './quota-types'
export type { QuotaPreset } from './quota-presets'
export { QUOTA_PRESETS, matchQuotaPreset } from './quota-presets'
// normalizeSubagentStatus 已下沉至 runtime（packages/runtime/src/services/session/subagent-status.ts，
// 单消费者归位）；shared 仅保留 renderer 消费的 deriveClosedDisplay 展示派生。
export { deriveClosedDisplay } from './subagent'
export type {
  WorkflowRunStatus,
  WorkflowDoneReason,
  WorkflowAgentCall,
  WorkflowRunRecord,
} from './workflow'
// pi-preset 用具名导出（S-SH-3）：避免 export * 导致的命名冲突与 tree-shaking 不友好。
// 所有 type / const / 运行时守卫均显式列出，新增导出时同步在此登记。
export type {
  ToolMode,
  ExtensionMode,
  ThinkingLevel,
  PiLaunchPreset,
  PresetUsageEntry,
  PiPresetsFile,
  PresetExportPayload,
} from './pi-preset'
export {
  BUILTIN_TOOLS,
  BUILTIN_PRESET_IDS,
  DEFAULT_PRESETS,
  PI_THINKING_LEVELS,
  isPiLaunchPreset,
} from './pi-preset'
export type { LatestReleaseInfo, ReleaseAsset, UpdateStage, UpdateState, IProxyConfig, UpdateSettings, UpdateErrorPayload, ProxyTestResult, LaunchResultStatus, LaunchResult, UpdateCheckResult, UpdateInstallResult } from './update'
export { LAUNCH_RESULT_STATUSES, UPDATE_STALE_RELEASE } from './update'
// 用量统计类型（W1 数据层）
export type { UsageMetrics, UsageRow, UsageStatsResult } from './usage-stats'
// 迁移功能（从其他 agent 迁移配置）类型
export type {
  ProviderSource,
  AgentSource,
  SourceDetectResult,
  ProviderPreviewItem,
  ProviderPreviewOrphanItem,
  ProviderImportPreview,
  ProviderImportedItem,
  ProviderImportResult,
} from './migration'
// 系统提示音默认映射 SSOT（main + renderer 共享，纯数据/类型无 node 依赖）
export type { SoundPlatform, SoundKind } from './sound-defaults'
export { DEFAULT_SUCCESS_PLATFORM, DEFAULT_ERROR_PLATFORM, getDefaultSound } from './sound-defaults'
