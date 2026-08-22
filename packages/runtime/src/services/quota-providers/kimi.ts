/**
 * Kimi Coding Plan 额度 fetcher。
 *
 * API: GET https://api.kimi.com/coding/v1/usages
 * Auth: Bearer <API_KEY>
 * 窗口：5h + week（month = ∞）
 */

import type { ProviderQuotaFetcher, QuotaAuthKind, QuotaFetchOutcome, QuotaWindow } from './types.js'
import { INFINITE_WIN, statusToReason } from './types.js'
import { logger } from '../../infra/logger.js'

const FETCH_TIMEOUT_MS = 5000
const PERCENT_SCALE = 100
const MS_PER_SEC = 1000

interface KimiLimitDetail {
  limit?: number
  remaining?: number
  resetTime?: string
}

interface KimiLimit {
  detail?: KimiLimitDetail
}

interface KimiUsage {
  limit?: number
  used?: number
  resetTime?: string
}

interface KimiApiResponse {
  limits?: KimiLimit[]
  usage?: KimiUsage
}

/** ISO 时间戳 → 剩余秒 */
function isoResetRemaining(iso: string): number {
  const ms = new Date(iso).getTime() - Date.now()
  return Math.max(0, Math.floor(ms / MS_PER_SEC))
}

/** 5h 滚动窗口（A2-3：limit/remaining 已从 API 拿到，绝对量不再折算 pct 后丢弃） */
function buildWin5h(data: KimiApiResponse): QuotaWindow {
  const winDetail = data?.limits?.[0]?.detail
  const winLimit = Number(winDetail?.limit ?? 0)
  const winRemaining = Number(winDetail?.remaining ?? 0)
  return winLimit > 0
    ? {
      pct: Math.round(((winLimit - winRemaining) / winLimit) * PERCENT_SCALE),
      used: winLimit - winRemaining,
      limit: winLimit,
      unit: 'requests' as const,
      resetSec: winDetail?.resetTime ? isoResetRemaining(winDetail.resetTime) : null,
    }
    : INFINITE_WIN
}

/** 每日/周窗口（usage 字段，绝对量直出） */
function buildWinWk(data: KimiApiResponse): QuotaWindow {
  const dailyLimit = Number(data?.usage?.limit ?? 0)
  const dailyUsed = Number(data?.usage?.used ?? 0)
  return dailyLimit > 0
    ? {
      pct: Math.round((dailyUsed / dailyLimit) * PERCENT_SCALE),
      used: dailyUsed,
      limit: dailyLimit,
      unit: 'requests' as const,
      resetSec: data?.usage?.resetTime ? isoResetRemaining(data.usage.resetTime) : null,
    }
    : INFINITE_WIN
}

export const kimiFetcher: ProviderQuotaFetcher = {
  id: 'kimi-coding',
  // usages API 与 oauth 同域同 Bearer（pi 侧 kimi oauth 的 toAuth 即 Bearer access），
  // 故声明双形态，优先 api-key（§3.4）
  auth: ['api-key', 'oauth'],

  async fetchQuota(credential: string, _kind: QuotaAuthKind): Promise<QuotaFetchOutcome> {
    if (!credential) return { ok: false, reason: 'unauthorized' }

    try {
      const resp = await fetch('https://api.kimi.com/coding/v1/usages', {
        headers: {
          authorization: `Bearer ${credential}`,
          'content-type': 'application/json',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!resp.ok) return { ok: false, reason: statusToReason(resp.status) }

      let data: KimiApiResponse
      try {
        data = (await resp.json()) as KimiApiResponse
      } catch {
        return { ok: false, reason: 'parse' }
      }
      // limits 与 usage 均缺失 = 响应可解析但无订阅数据
      if (!data?.limits?.length && !data?.usage) return { ok: false, reason: 'no-subscription' }

      return {
        ok: true,
        data: {
          label: 'Kimi Coding',
          wins: [buildWin5h(data), buildWinWk(data), INFINITE_WIN],
        },
      }
    } catch (err) {
      // fetch 网络异常 / 超时 → network（架构约定 #4 落盘，禁止静默 catch）
      const msg = err instanceof Error ? err.message : String(err)
      logger.debug('[quota:kimi] fetch failed', { error: msg })
      return { ok: false, reason: 'network' }
    }
  },
}
