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

/** 查询失败原因（可区分——null-only 接口下 401/网络/无订阅三者不可分辨）。 */
export type QuotaFetchFailureReason = 'unauthorized' | 'network' | 'no-subscription' | 'parse'

/**
 * 单次额度查询结果：成功带数据，失败带可区分 reason（不 throw）。
 * unauthorized：HTTP 401/403 或 cookie 过期（原 isCredentialValid 语义）——
 * 凭证可能过期，恢复指引见 D6（发起一次对话触发刷新后重试，runtime 不自行 refresh）。
 */
export type QuotaFetchOutcome =
  | { ok: true; data: NormalizedQuotaRow }
  | { ok: false; reason: QuotaFetchFailureReason }

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
   * @returns QuotaFetchOutcome。失败不 throw，reason 可区分。
   */
  fetchQuota(credential: string, kind: QuotaAuthKind): Promise<QuotaFetchOutcome>
}
