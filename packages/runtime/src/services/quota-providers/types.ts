/**
 * Quota provider 类型 — runtime 实现层。
 *
 * re-export shared 类型 + 添加 runtime 专用常量。
 * 设计文档：docs/page-design/archive/v3/coding-plan-quota/design.md
 */

import type { QuotaWindow, QuotaWins, NormalizedQuotaRow, ProviderQuotaFetcher, QuotaAuthKind, QuotaFetchFailureReason, QuotaFetchOutcome } from '@xyz-agent/shared'
import { logger } from '../../infra/logger.js'

/** 无限窗口（未订阅/不支持）。pct=null 前端整行隐藏。 */
export const INFINITE_WIN: QuotaWindow = { pct: null, resetSec: null }

export type { QuotaWindow, QuotaWins, NormalizedQuotaRow, ProviderQuotaFetcher, QuotaAuthKind, QuotaFetchFailureReason, QuotaFetchOutcome }

/** HTTP 401/403：凭证无效/过期（unauthorized 判定）。 */
const HTTP_UNAUTHORIZED = 401
const HTTP_FORBIDDEN = 403

/**
 * HTTP 状态 → 失败 reason 的统一映射（A2-1 错误通道）。
 * - 401/403 → unauthorized（凭证无效/过期，D6 恢复指引场景）
 * - 其余非 2xx（5xx/404/429 等）→ network（基础设施层失败，与 fetch 异常同归——
 *   二者对用户的恢复动作相同：检查网络/稍后重试，不涉及凭证操作）
 */
export function statusToReason(status: number): QuotaFetchFailureReason {
  return status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN ? 'unauthorized' : 'network'
}

/** shape guard 公共前置：v 是非 null 对象（各平台 guard 首行统一用）。 */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/**
 * JSON fetcher 共用骨架：凭证检查 → HTTP 状态归类 → JSON 解析 + shape guard →
 * 网络异常归类（logger.debug 落盘，禁止静默 catch）。doFetch 返回的 Response 由
 * 骨架消费 json()；guard 失败 / 解析失败归 parse。AbortSignal.timeout 由各
 * fetcher 在 doFetch 闭包内自带。
 */
export async function fetchQuotaJson<T>(
  logTag: string,
  doFetch: () => Promise<Response>,
  guard: (v: unknown) => v is T,
): Promise<{ ok: true; data: T } | { ok: false; reason: QuotaFetchFailureReason }> {
  try {
    const resp = await doFetch()
    if (!resp.ok) return { ok: false, reason: statusToReason(resp.status) }

    let data: T
    try {
      data = (await resp.json()) as T
    } catch {
      return { ok: false, reason: 'parse' }
    }
    if (!guard(data)) return { ok: false, reason: 'parse' }
    return { ok: true, data }
  } catch (err) {
    // fetch 网络异常 / 超时 → network（架构约定 #4 落盘，禁止静默 catch）
    const msg = err instanceof Error ? err.message : String(err)
    logger.debug(`[${logTag}] fetch failed`, { error: msg })
    return { ok: false, reason: 'network' }
  }
}
