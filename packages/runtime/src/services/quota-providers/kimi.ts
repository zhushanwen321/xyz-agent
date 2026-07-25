/**
 * Kimi Coding Plan 额度 fetcher。
 *
 * API: GET https://api.kimi.com/coding/v1/usages
 * Auth: Bearer <API_KEY>
 * 窗口：5h + week（month = ∞）
 */

import type { NormalizedQuotaRow, ProviderQuotaFetcher } from './types.js'
import { INFINITE_WIN } from './types.js'

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

export const kimiFetcher: ProviderQuotaFetcher = {
  id: 'kimi-coding',
  authType: 'api-key',

  async fetchQuota(credential: string): Promise<NormalizedQuotaRow | null> {
    if (!credential) return null

    try {
      const resp = await fetch('https://api.kimi.com/coding/v1/usages', {
        headers: {
          authorization: `Bearer ${credential}`,
          'content-type': 'application/json',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!resp.ok) return null

      const data = (await resp.json()) as KimiApiResponse

      // 5h 滚动窗口
      const winDetail = data?.limits?.[0]?.detail
      const winLimit = Number(winDetail?.limit ?? 0)
      const winRemaining = Number(winDetail?.remaining ?? 0)
      const win5h = winLimit > 0
        ? {
          pct: Math.round(((winLimit - winRemaining) / winLimit) * PERCENT_SCALE),
          resetSec: winDetail?.resetTime ? isoResetRemaining(winDetail.resetTime) : null,
        }
        : INFINITE_WIN

      // 每日/周窗口（usage 字段）
      const dailyLimit = Number(data?.usage?.limit ?? 0)
      const dailyUsed = Number(data?.usage?.used ?? 0)
      const winWk = dailyLimit > 0
        ? {
          pct: Math.round((dailyUsed / dailyLimit) * PERCENT_SCALE),
          resetSec: data?.usage?.resetTime ? isoResetRemaining(data.usage.resetTime) : null,
        }
        : INFINITE_WIN

      return {
        label: 'Kimi Coding',
        wins: [win5h, winWk, INFINITE_WIN],
      }
    } catch {
      return null
    }
  },
}
