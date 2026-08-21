/**
 * 小米 MiMo Coding Plan 额度 fetcher。
 *
 * API: GET https://platform.xiaomimimo.com/api/v1/tokenPlan/usage
 * Auth: Cookie header
 * 窗口：仅 month（5h/week = ∞）
 *
 * 关键点：monthUsage.percent 是 0~1 小数，需 ×100 转为百分比。
 */

import type { ProviderQuotaFetcher, QuotaAuthKind, QuotaFetchOutcome } from './types.js'
import { INFINITE_WIN, statusToReason } from './types.js'
import { logger } from '../../infra/logger.js'

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
  auth: ['cookie'],

  async fetchQuota(credential: string, _kind: QuotaAuthKind): Promise<QuotaFetchOutcome> {
    if (!credential) return { ok: false, reason: 'unauthorized' }

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
      if (!resp.ok) return { ok: false, reason: statusToReason(resp.status) }

      let data: MimoApiResponse
      try {
        data = (await resp.json()) as MimoApiResponse
      } catch {
        return { ok: false, reason: 'parse' }
      }
      // code 非 0 = 响应可解析但无订阅数据（含 cookie 失效由平台返回的业务码场景）
      if (data.code !== 0) return { ok: false, reason: 'no-subscription' }

      // percent 是 0~1 小数，转为 0~100
      const monthPct = (data.data?.monthUsage?.percent ?? 0) * PERCENT_SCALE

      // [A2-3] monthUsage.items 含 used/limit 但字段语义未实测核对，本波不编造绝对量
      return {
        ok: true,
        data: {
          label: 'MiMo Coding',
          wins: [INFINITE_WIN, INFINITE_WIN, { pct: monthPct, resetSec: null }],
        },
      }
    } catch (err) {
      // fetch 网络异常 / 超时 → network（架构约定 #4 落盘，禁止静默 catch）
      const msg = err instanceof Error ? err.message : String(err)
      logger.debug('[quota:mimo] fetch failed', { error: msg })
      return { ok: false, reason: 'network' }
    }
  },
}
