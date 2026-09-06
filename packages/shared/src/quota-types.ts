/**
 * Coding Plan 额度查询 — 共享类型定义。
 *
 * 设计文档：docs/page-design/archive/v3/coding-plan-quota/design.md
 * HANDOFF：.xyz-harness/coding-plan-quota/HANDOFF.md
 */

/** 单个时间窗口的额度（5h 滚动 / 本周 / 本月三窗口之一）。 */
export interface QuotaWindow {
  /** 已用百分比 0-100。null = 无限/未订阅（前端整行隐藏）。 */
  pct: number | null
  /**
   * 已用绝对量（次数或 token 数）。optional 向后兼容：平台 API 未提供总量字段的
   * fetcher（zhipu/minimax 待实测）维持不输出，旧缓存/旧 fetcher 输出仍合法（D5）。
   */
  used?: number | null
  /** 总量。optional 同 used。 */
  limit?: number | null
  /** 平台计费单位。optional 同 used。 */
  unit?: 'requests' | 'tokens' | 'credits' | null
  /** 剩余秒数。null = 无重置信息（前端显示 --）。 */
  resetSec: number | null
}

/** 三窗口：[5h 滚动, 本周, 本月]。 */
export type QuotaWins = [QuotaWindow, QuotaWindow, QuotaWindow]

/** 归一化额度行（fetcher 统一输出格式）。 */
export interface NormalizedQuotaRow {
  /** Provider 显示名（如 '智谱 GLM Coding Plan'）。 */
  label: string
  /** 三窗口额度数据。 */
  wins: QuotaWins
}

/** fetcher 接受的凭证形态（能力声明数组的元素 / fetchQuota 的 kind 参数）。 */
export type QuotaAuthKind = 'api-key' | 'oauth' | 'cookie'

/**
 * 查询失败原因（可区分——null-only 接口下 401/网络/无订阅三者不可分辨）。
 * not_configured：必填查询配置缺失（timeout-audit-hygiene-batch D1-3）——如 opencode
 * 未配置 workspace。不发任何 HTTP 请求，恢复指引指向「去 Settings 配置」而非检查凭证。
 */
export type QuotaFetchFailureReason = 'unauthorized' | 'network' | 'no-subscription' | 'parse' | 'not_configured'

/**
 * 单次额度查询结果：成功带数据，失败带可区分 reason（不 throw）。
 * unauthorized：HTTP 401/403 或 cookie 过期（原 isCredentialValid 语义）——
 * 凭证可能过期，恢复指引见 D6（发起一次对话触发刷新后重试，runtime 不自行 refresh）。
 */
export type QuotaFetchOutcome =
  | { ok: true; data: NormalizedQuotaRow }
  | { ok: false; reason: QuotaFetchFailureReason }

/**
 * per-provider 只读查询配置（D1-2，timeout-audit-hygiene-batch）：QuotaService 从
 * providers.json 读出后经 fetchQuota 第三参数注入。可选签名——账号维度 fetcher
 * （kimi/mimo/minimax/zhipu）忽略该参数，零改动面。
 */
export interface QuotaFetcherConfig {
  /**
   * 资源维度 fetcher（opencode）的 workspace 归一化地址（经 normalizeQuotaWorkspaceUrl
   * 产出的规范 URL）。缺失 = 未配置，资源维度 fetcher 返回 not_configured（不发请求）。
   */
  workspaceUrl?: string
}

/** Provider 额度查询 fetcher 接口（可插拔，为 Phase 2 plugin 化铺路）。 */
export interface ProviderQuotaFetcher {
  /** fetcher 标识（匹配 QuotaPreset.fetcher）。 */
  readonly id: string
  /**
   * 能力声明：该套餐额度 API 接受的凭证形态，按优先级排序。
   * QuotaService 按数组序解析凭证（每形态固定来源链），首个拿到凭证的形态即生效，
   * 并以该形态作为 kind 传给 fetchQuota。
   */
  readonly auth: readonly QuotaAuthKind[]
  /**
   * 查询额度。
   * @param credential 由 QuotaService 注入：api-key/oauth 类传 key/token 字符串，cookie 类传 cookie 字符串。
   * @param kind 凭证形态（= 命中的 auth 数组元素），fetcher 可区分凭证语义
   *   （如个别平台 oauth 与 api key 请求头不同）。
   * @param config per-provider 只读配置（D1-2，可选）：资源维度 fetcher（opencode）从中取
   *   workspaceUrl；账号维度 fetcher 忽略。
   * @returns QuotaFetchOutcome。失败不 throw，reason 可区分。
   */
  fetchQuota(credential: string, kind: QuotaAuthKind, config?: QuotaFetcherConfig): Promise<QuotaFetchOutcome>
}

// ── opencode workspace URL 归一化（P1-1，timeout-audit-hygiene-batch D1-1）──

/** opencode 额度页规范前缀：`<BASE>/workspace/<wrk_id>/go`。 */
const OPENCODE_BASE = 'https://opencode.ai'

/**
 * workspace id 形态：`wrk_` 前缀 + 字母数字（opencode id 均此形态，如
 * `wrk_xxx...`——任何具体 id 都不得硬编码，D1-4）。
 */
const WORKSPACE_ID_RE = /^wrk_[A-Za-z0-9]+$/
/** URL pathname 中的 workspace 段提取（/workspace/wrk_xxx/... 或以 wrk_xxx 结尾）。 */
const WORKSPACE_PATH_RE = /\/workspace\/(wrk_[A-Za-z0-9]+)(?:\/|$)/

/** workspace 地址归一化结果：ok=true 带规范 URL；ok=false 带面向用户的报错文案。 */
export type QuotaWorkspaceNormalizeResult =
  | { ok: true; url: string }
  | { ok: false; error: string }

/**
 * opencode workspace 输入归一化（P1-1）：完整 URL 与裸 `wrk_` id 两种输入均可解析为
 * 规范额度页 URL `<OPENCODE_BASE>/workspace/<id>/go`。
 *
 * 归一化产物是规范 URL 而非裸 id（D1-2 config 字段名 workspaceUrl 名副其实）：
 * URL 中的尾路径差异（/go、/usage 等）统一收敛为 /go 额度页。
 *
 * hostname 必须是 opencode.ai（fetchQuota 携带用户 cookie 请求该 URL——放行任意域
 * 等于把 cookie 泄露给第三方域，域名校验是安全必要而非格式洁癖）。
 *
 * @param input 用户输入（完整 URL 或裸 wrk_ id；空串/空白由调用方按「清除/未填」语义处理，
 *   本函数对空输入返回 error）
 */
export function normalizeQuotaWorkspaceUrl(input: string): QuotaWorkspaceNormalizeResult {
  const trimmed = input.trim()
  if (!trimmed) {
    return { ok: false, error: 'workspace url is empty' }
  }

  // 形态 1：裸 wrk_ id → 直接拼规范 URL
  if (WORKSPACE_ID_RE.test(trimmed)) {
    return { ok: true, url: `${OPENCODE_BASE}/workspace/${trimmed}/go` }
  }

  // 形态 2：完整 URL → 校验域 + 提取 workspace id + 重构规范 URL
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return {
      ok: false,
      error: `invalid workspace url: not a URL or wrk_ id. Expected like ${OPENCODE_BASE}/workspace/wrk_xxx/go or a bare wrk_ id`,
    }
  }

  if (parsed.hostname !== 'opencode.ai') {
    return {
      ok: false,
      error: `invalid workspace url: expected host opencode.ai, got "${parsed.hostname}" (your cookie is only sent to opencode.ai)`,
    }
  }

  const id = parsed.pathname.match(WORKSPACE_PATH_RE)?.[1]
  if (!id) {
    return {
      ok: false,
      error: `invalid workspace url: no wrk_ id found in path "${parsed.pathname}". Expected like ${OPENCODE_BASE}/workspace/wrk_xxx/go`,
    }
  }

  return { ok: true, url: `${OPENCODE_BASE}/workspace/${id}/go` }
}
