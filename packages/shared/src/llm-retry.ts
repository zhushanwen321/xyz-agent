/**
 * LLM 重试配置域（设计 docs/design/llm-retry-settings.md §3.4 类型 + §3.3 D8 数值合法域）。
 * 校验域定在 shared：renderer 表单与 runtime 写入侧共用同一套域常量，杜绝两端漂移。
 */

/** provider 层（单请求级）重试配置；undefined = 采纳 pi 默认语义。 */
export interface LlmRetryProviderConfig {
  /** 未设 = 跟随全局 httpIdleTimeoutMs；禁止 0（0 会原样透传成 0ms 立即超时，见设计 §2.2） */
  timeoutMs?: number
  /** 未设 = 0（不重试） */
  maxRetries?: number
  /** 未设 = 60000；0 = 不限制 */
  maxRetryDelayMs?: number
}

/** agent 层重试配置（pi settings.json `retry` 域）。 */
export interface LlmRetryConfig {
  enabled: boolean
  /** pi 默认 3 */
  maxRetries: number
  /** pi 默认 2000 */
  baseDelayMs: number
  provider?: LlmRetryProviderConfig
}

/** D8 数值合法域（设计 §3.3 D8 表，唯一依据）。 */
export const LLM_RETRY_DOMAIN = {
  maxRetries: { min: 0, max: 20 },
  baseDelayMs: { min: 0, max: 600000 },
  providerTimeoutMs: { min: 1, max: 600000 },
  providerMaxRetries: { min: 0, max: 10 },
  providerMaxRetryDelayMs: { min: 0, max: 3600000, minNonZero: 1000 },
} as const

/** 校验失败 error 信封：含字段名/合法范围/当前值（同 setTerminalConfig 错误信封范式）。 */
export function validateLlmRetryConfig(config: LlmRetryConfig): { ok: true } | { ok: false; error: string } {
  if (typeof config.enabled !== 'boolean') {
    return { ok: false, error: `enabled 类型必须是 boolean: ${String(config.enabled)}` }
  }
  const { maxRetries, baseDelayMs, provider } = config
  if (!Number.isInteger(maxRetries) || maxRetries < LLM_RETRY_DOMAIN.maxRetries.min || maxRetries > LLM_RETRY_DOMAIN.maxRetries.max) {
    return { ok: false, error: `maxRetries 超出范围(整数 0-20): ${String(maxRetries)}` }
  }
  if (!Number.isInteger(baseDelayMs) || baseDelayMs < LLM_RETRY_DOMAIN.baseDelayMs.min || baseDelayMs > LLM_RETRY_DOMAIN.baseDelayMs.max) {
    return { ok: false, error: `baseDelayMs 超出范围(整数 0-600000): ${String(baseDelayMs)}` }
  }
  if (provider !== undefined) {
    // 对象性守卫：null 解构抛 TypeError（写路径校验在 try 外，会以 handler_error 逃逸而非
    // set_retry_config_failed 信封）；string/array 解构静默得 undefined，被当「全未设」丢字段。
    if (provider === null || typeof provider !== 'object' || Array.isArray(provider)) {
      return { ok: false, error: `provider 类型必须是对象或未设: ${String(provider)}` }
    }
    const { timeoutMs, maxRetries: pMaxRetries, maxRetryDelayMs } = provider
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < LLM_RETRY_DOMAIN.providerTimeoutMs.min || timeoutMs > LLM_RETRY_DOMAIN.providerTimeoutMs.max)) {
      return { ok: false, error: `provider.timeoutMs 超出范围(整数 1-600000 或未设，禁止 0): ${String(timeoutMs)}` }
    }
    if (pMaxRetries !== undefined && (!Number.isInteger(pMaxRetries) || pMaxRetries < LLM_RETRY_DOMAIN.providerMaxRetries.min || pMaxRetries > LLM_RETRY_DOMAIN.providerMaxRetries.max)) {
      return { ok: false, error: `provider.maxRetries 超出范围(整数 0-10 或未设): ${String(pMaxRetries)}` }
    }
    if (maxRetryDelayMs !== undefined && (!Number.isInteger(maxRetryDelayMs) || !(maxRetryDelayMs === 0 || (maxRetryDelayMs >= LLM_RETRY_DOMAIN.providerMaxRetryDelayMs.minNonZero && maxRetryDelayMs <= LLM_RETRY_DOMAIN.providerMaxRetryDelayMs.max)))) {
      return { ok: false, error: `provider.maxRetryDelayMs 超出范围(整数 0(不限制) 或 1000-3600000): ${String(maxRetryDelayMs)}` }
    }
  }
  return { ok: true }
}
