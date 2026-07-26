/**
 * compat 字段元数据 SSOT。按 api 类型分组。
 *
 * compat 字段形状由 model 的 `api` 类型决定（pi 的判别联合）。本文件把字段定义和
 * pi models.md 的填写指引编码进来，供 CompatEditor 渲染 + i18n key 自动派生。
 *
 * - field: compat 字段名（对应 pi 的 schema）
 * - labelKey: i18n key（settings.compat.<api>.<key>.label）
 * - hintKey: i18n key（settings.compat.<api>.<key>.hint）—— pi 文档摘录的填写指引
 * - type: 'switch' | 'select' | 'text'（多数 boolean 用 switch，thinkingFormat 用 select）
 * - options: type=select 时的选项（如 thinkingFormat 的 10 个枚举值）
 * - group: 'essential'（关键字段，始终露出）| 'advanced'（高级，默认折叠）
 *
 * 严格按 pi models.md 的字段语义，不要自己发明。
 */

export type CompatFieldType = 'switch' | 'select' | 'text'
export type CompatFieldGroup = 'essential' | 'advanced'

export interface CompatFieldOption {
  /** pi schema 的枚举值，如 'deepseek' */
  value: string
  /** i18n key 后缀，完整 key = settings.compat.thinkingFormat.options.<suffix> */
  labelKeySuffix: string
}

export interface CompatFieldMeta {
  field: string
  labelKey: string
  hintKey: string
  type: CompatFieldType
  group: CompatFieldGroup
  /** type=select 时的选项；select 字段必须提供。 */
  options?: CompatFieldOption[]
  /**
 * 选项 label 的 i18n key 前缀。默认 'settings.compat.thinkingFormat.options'；
 * maxTokensField / cacheControlFormat 等字段用自己的 options 命名空间。
 */
  optionsKeyPrefix?: string
}

// openai-completions 的 19 个字段（按 essential/advanced 分组）
export const OPENAI_COMPAT_FIELDS: CompatFieldMeta[] = [
  // essential（3 个，reasoning 模型必配）
  {
    field: 'thinkingFormat',
    labelKey: 'settings.compat.thinkingFormat.label',
    hintKey: 'settings.compat.thinkingFormat.hint',
    type: 'select',
    group: 'essential',
    optionsKeyPrefix: 'settings.compat.thinkingFormat.options',
    options: [
      { value: 'openai', labelKeySuffix: 'openai' },
      { value: 'openrouter', labelKeySuffix: 'openrouter' },
      { value: 'deepseek', labelKeySuffix: 'deepseek' },
      { value: 'together', labelKeySuffix: 'together' },
      { value: 'zai', labelKeySuffix: 'zai' },
      { value: 'qwen', labelKeySuffix: 'qwen' },
      { value: 'qwen-chat-template', labelKeySuffix: 'qwenChatTemplate' },
      { value: 'chat-template', labelKeySuffix: 'chatTemplate' },
      { value: 'ant-ling', labelKeySuffix: 'antLing' },
      { value: 'string-thinking', labelKeySuffix: 'stringThinking' },
    ],
  },
  {
    field: 'supportsDeveloperRole',
    labelKey: 'settings.compat.openai.supportsDeveloperRole.label',
    hintKey: 'settings.compat.openai.supportsDeveloperRole.hint',
    type: 'switch',
    group: 'essential',
  },
  {
    field: 'supportsReasoningEffort',
    labelKey: 'settings.compat.openai.supportsReasoningEffort.label',
    hintKey: 'settings.compat.openai.supportsReasoningEffort.hint',
    type: 'switch',
    group: 'essential',
  },
  // advanced（16 个）
  {
    field: 'maxTokensField',
    labelKey: 'settings.compat.openai.maxTokensField.label',
    hintKey: 'settings.compat.openai.maxTokensField.hint',
    type: 'select',
    group: 'advanced',
    optionsKeyPrefix: 'settings.compat.openai.maxTokensField.options',
    options: [
      { value: 'max_completion_tokens', labelKeySuffix: 'maxCompletionTokens' },
      { value: 'max_tokens', labelKeySuffix: 'maxTokens' },
    ],
  },
  {
    field: 'supportsUsageInStreaming',
    labelKey: 'settings.compat.openai.supportsUsageInStreaming.label',
    hintKey: 'settings.compat.openai.supportsUsageInStreaming.hint',
    type: 'switch',
    group: 'advanced',
  },
  {
    field: 'supportsStore',
    labelKey: 'settings.compat.openai.supportsStore.label',
    hintKey: 'settings.compat.openai.supportsStore.hint',
    type: 'switch',
    group: 'advanced',
  },
  {
    field: 'requiresToolResultName',
    labelKey: 'settings.compat.openai.requiresToolResultName.label',
    hintKey: 'settings.compat.openai.requiresToolResultName.hint',
    type: 'switch',
    group: 'advanced',
  },
  {
    field: 'requiresAssistantAfterToolResult',
    labelKey: 'settings.compat.openai.requiresAssistantAfterToolResult.label',
    hintKey: 'settings.compat.openai.requiresAssistantAfterToolResult.hint',
    type: 'switch',
    group: 'advanced',
  },
  {
    field: 'requiresThinkingAsText',
    labelKey: 'settings.compat.openai.requiresThinkingAsText.label',
    hintKey: 'settings.compat.openai.requiresThinkingAsText.hint',
    type: 'switch',
    group: 'advanced',
  },
  {
    field: 'requiresReasoningContentOnAssistantMessages',
    labelKey: 'settings.compat.openai.requiresReasoningContentOnAssistantMessages.label',
    hintKey: 'settings.compat.openai.requiresReasoningContentOnAssistantMessages.hint',
    type: 'switch',
    group: 'advanced',
  },
  {
    field: 'supportsStrictMode',
    labelKey: 'settings.compat.openai.supportsStrictMode.label',
    hintKey: 'settings.compat.openai.supportsStrictMode.hint',
    type: 'switch',
    group: 'advanced',
  },
  {
    field: 'cacheControlFormat',
    labelKey: 'settings.compat.openai.cacheControlFormat.label',
    hintKey: 'settings.compat.openai.cacheControlFormat.hint',
    type: 'select',
    group: 'advanced',
    optionsKeyPrefix: 'settings.compat.openai.cacheControlFormat.options',
    options: [
      { value: 'anthropic', labelKeySuffix: 'anthropic' },
    ],
  },
  {
    field: 'supportsLongCacheRetention',
    labelKey: 'settings.compat.openai.supportsLongCacheRetention.label',
    hintKey: 'settings.compat.openai.supportsLongCacheRetention.hint',
    type: 'switch',
    group: 'advanced',
  },
  {
    field: 'sendSessionAffinityHeaders',
    labelKey: 'settings.compat.openai.sendSessionAffinityHeaders.label',
    hintKey: 'settings.compat.openai.sendSessionAffinityHeaders.hint',
    type: 'switch',
    group: 'advanced',
  },
  {
    field: 'zaiToolStream',
    labelKey: 'settings.compat.openai.zaiToolStream.label',
    hintKey: 'settings.compat.openai.zaiToolStream.hint',
    type: 'switch',
    group: 'advanced',
  },
  // 这两个是 object 类型，UI 暂用 text 显示「高级配置」提示，不细做（用户手改 json）
  {
    field: 'openRouterRouting',
    labelKey: 'settings.compat.openai.openRouterRouting.label',
    hintKey: 'settings.compat.openai.openRouterRouting.hint',
    type: 'text',
    group: 'advanced',
  },
  {
    field: 'vercelGatewayRouting',
    labelKey: 'settings.compat.openai.vercelGatewayRouting.label',
    hintKey: 'settings.compat.openai.vercelGatewayRouting.hint',
    type: 'text',
    group: 'advanced',
  },
  {
    field: 'chatTemplateKwargs',
    labelKey: 'settings.compat.openai.chatTemplateKwargs.label',
    hintKey: 'settings.compat.openai.chatTemplateKwargs.hint',
    type: 'text',
    group: 'advanced',
  },
]

// anthropic-messages 的 7 个字段
export const ANTHROPIC_COMPAT_FIELDS: CompatFieldMeta[] = [
  // essential（1 个）
  {
    field: 'forceAdaptiveThinking',
    labelKey: 'settings.compat.anthropic.forceAdaptiveThinking.label',
    hintKey: 'settings.compat.anthropic.forceAdaptiveThinking.hint',
    type: 'switch',
    group: 'essential',
  },
  // advanced（6 个）
  {
    field: 'supportsTemperature',
    labelKey: 'settings.compat.anthropic.supportsTemperature.label',
    hintKey: 'settings.compat.anthropic.supportsTemperature.hint',
    type: 'switch',
    group: 'advanced',
  },
  {
    field: 'supportsEagerToolInputStreaming',
    labelKey: 'settings.compat.anthropic.supportsEagerToolInputStreaming.label',
    hintKey: 'settings.compat.anthropic.supportsEagerToolInputStreaming.hint',
    type: 'switch',
    group: 'advanced',
  },
  {
    field: 'supportsCacheControlOnTools',
    labelKey: 'settings.compat.anthropic.supportsCacheControlOnTools.label',
    hintKey: 'settings.compat.anthropic.supportsCacheControlOnTools.hint',
    type: 'switch',
    group: 'advanced',
  },
  {
    field: 'supportsLongCacheRetention',
    labelKey: 'settings.compat.anthropic.supportsLongCacheRetention.label',
    hintKey: 'settings.compat.anthropic.supportsLongCacheRetention.hint',
    type: 'switch',
    group: 'advanced',
  },
  {
    field: 'sendSessionAffinityHeaders',
    labelKey: 'settings.compat.anthropic.sendSessionAffinityHeaders.label',
    hintKey: 'settings.compat.anthropic.sendSessionAffinityHeaders.hint',
    type: 'switch',
    group: 'advanced',
  },
  {
    field: 'allowEmptySignature',
    labelKey: 'settings.compat.anthropic.allowEmptySignature.label',
    hintKey: 'settings.compat.anthropic.allowEmptySignature.hint',
    type: 'switch',
    group: 'advanced',
  },
]

// openai-responses 的 3 个字段（全部 advanced）
export const RESPONSES_COMPAT_FIELDS: CompatFieldMeta[] = [
  {
    field: 'supportsDeveloperRole',
    labelKey: 'settings.compat.responses.supportsDeveloperRole.label',
    hintKey: 'settings.compat.responses.supportsDeveloperRole.hint',
    type: 'switch',
    group: 'advanced',
  },
  {
    field: 'sendSessionIdHeader',
    labelKey: 'settings.compat.responses.sendSessionIdHeader.label',
    hintKey: 'settings.compat.responses.sendSessionIdHeader.hint',
    type: 'switch',
    group: 'advanced',
  },
  {
    field: 'supportsLongCacheRetention',
    labelKey: 'settings.compat.responses.supportsLongCacheRetention.label',
    hintKey: 'settings.compat.responses.supportsLongCacheRetention.hint',
    type: 'switch',
    group: 'advanced',
  },
]

/** 根据 api 类型取字段集；默认 openai-completions（最常用，Ollama/vLLM 等）。 */
export function getCompatFields(api?: string): CompatFieldMeta[] {
  if (api === 'anthropic-messages') return ANTHROPIC_COMPAT_FIELDS
  if (api === 'openai-responses') return RESPONSES_COMPAT_FIELDS
  // 默认 openai-completions（最常用，Ollama/vLLM 等）
  return OPENAI_COMPAT_FIELDS
}

// ── 国产模型 compat 预设（一键配置）──
// 数据来源：各模型官方 API 文档 + pi 生产配置交叉验证（2026-07 调研）。
// 国产 API 共性：全部不认 developer 角色 → supportsDeveloperRole: false 是统一默认。

export interface CompatPreset {
  /** 预设 id（i18n key 后缀，完整 key = settings.compat.preset.<id>） */
  id: string
  /** 适用此预设的 api 类型（预设只在该 api 下显示） */
  api: 'openai-completions' | 'anthropic-messages' | 'openai-responses'
  /** 一键填入的 compat 配置（整体替换当前 compat） */
  compat: Record<string, unknown>
}

export const COMPAT_PRESETS: CompatPreset[] = [
  {
    id: 'deepseek',
    api: 'openai-completions',
    compat: {
      thinkingFormat: 'deepseek',
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      requiresReasoningContentOnAssistantMessages: true,
    },
  },
  {
    id: 'glm',
    api: 'openai-completions',
    compat: {
      thinkingFormat: 'zai',
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
  },
  {
    id: 'kimiK2',
    api: 'openai-completions',
    compat: {
      thinkingFormat: 'deepseek',
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
  },
  {
    id: 'kimiK3',
    api: 'openai-completions',
    compat: {
      thinkingFormat: 'openai',
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
    },
  },
  {
    id: 'mimo',
    api: 'openai-completions',
    compat: {
      thinkingFormat: 'qwen-chat-template',
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
  },
  {
    id: 'minimax',
    api: 'anthropic-messages',
    compat: {
      forceAdaptiveThinking: true,
    },
  },
]

/** 按 api 类型过滤预设（预设只在对应 api 下显示） */
export function getPresetsForApi(api?: string): CompatPreset[] {
  if (!api) return []
  return COMPAT_PRESETS.filter(p => p.api === api)
}
