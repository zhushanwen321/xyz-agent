/**
 * Coding Plan 额度查询 — 共享类型定义。
 *
 * 设计文档：docs/page-design/v3/coding-plan-quota/design.md
 * HANDOFF：.xyz-harness/coding-plan-quota/HANDOFF.md
 */

/** 单个时间窗口的额度（5h 滚动 / 本周 / 本月三窗口之一）。 */
export interface QuotaWindow {
  /** 已用百分比 0-100。null = 无限/未订阅（前端整行隐藏）。 */
  pct: number | null
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

/** Provider 额度查询 fetcher 接口（可插拔，为 Phase 2 plugin 化铺路）。 */
export interface ProviderQuotaFetcher {
  /** fetcher 标识（匹配 QuotaPreset.fetcher）。 */
  readonly id: string
  /** 认证方式：决定 QuotaService 如何获取凭证。 */
  readonly authType: 'api-key' | 'cookie'
  /**
   * 查询额度。
   * @param credential 由 QuotaService 注入：api-key 类传 API key 字符串，cookie 类传 cookie 字符串。
   * @returns 归一化额度行。null = 凭证缺失或查询失败（不 throw）。
   */
  fetchQuota(credential: string): Promise<NormalizedQuotaRow | null>
  /**
   * 可选：凭证有效性判定（如 opencode 的 302 重定向 = 过期）。
   * QuotaService 在 fetchQuota 失败时调用此方法判断是否需要提示用户更新凭证。
   */
  isCredentialValid?(response: unknown): boolean
}
