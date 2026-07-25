/**
 * 小米 MiMo Coding Plan 额度 fetcher。
 *
 * API: GET https://platform.xiaomimimo.com/api/v1/tokenPlan/usage
 * Auth: Cookie header
 * 窗口：仅 month（5h/week = ∞）
 *
 * 关键点：monthUsage.percent 是 0~1 小数，需 ×100 转为百分比。
 */

import type { NormalizedQuotaRow, ProviderQuotaFetcher } from './types.js'
import { INFINITE_WIN } from './types.js'

const FETCH_TIMEOUT_MS = 5000
const PERCENT_SCALE = 100

interface MimoUsageItem {
  name: string
  used: number
  limit: number
  percent: number
}

interface MimoApiResponse {
  code: number
  message: string
  data: {
    monthUsage: { percent: number; items: MimoUsageItem[] }
    usage: { percent: number; items: MimoUsageItem[] }
  }
}

export const mimoFetcher: ProviderQuotaFetcher = {
  id: 'mimo',
  authType: 'cookie',

  async fetchQuota(credential: string): Promise<NormalizedQuotaRow | null> {
    if (!credential) return null

    try {
      const resp = await fetch(
        'https://platform.xiaomimimo.com/api/v1/tokenPlan/usage',
        {
          headers: {
            accept: 'application/json',
            cookie: credential,
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        },
      )
      if (!resp.ok) return null

      const data = (await resp.json()) as MimoApiResponse
      if (data.code !== 0) return null

      // percent 是 0~1 小数，转为 0~100
      const monthPct = (data.data?.monthUsage?.percent ?? 0) * PERCENT_SCALE

      return {
        label: 'MiMo Coding',
        wins: [INFINITE_WIN, INFINITE_WIN, { pct: monthPct, resetSec: null }],
      }
    } catch {
      return null
    }
  },
}
