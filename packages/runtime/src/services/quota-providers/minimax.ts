/**
 * MiniMax Coding Plan 额度 fetcher。
 *
 * API: GET https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains
 * Auth: Bearer <API_KEY>
 * 窗口：5h + week（month = ∞）
 *
 * 关键点：API 返回的是**剩余百分比**，需反转为已用百分比。
 * status=1 表示已订阅，其他值视为无限。
 */

import type { ProviderQuotaFetcher, QuotaAuthKind, QuotaFetchOutcome } from './types.js'
import { INFINITE_WIN, statusToReason } from './types.js'
import { logger } from '../../infra/logger.js'

const FETCH_TIMEOUT_MS = 5000
const PERCENT_SCALE = 100
const MS_PER_SEC = 1000

interface MinimaxBaseResp {
  status_code?: number
}

interface MinimaxModelRemains {
  model_name: string
  current_interval_remaining_percent: number
  current_interval_status: number
  remains_time: number
  current_weekly_remaining_percent: number
  current_weekly_status: number
  weekly_remains_time: number
  [key: string]: unknown
}

interface MinimaxApiResponse {
  base_resp?: MinimaxBaseResp
  model_remains?: MinimaxModelRemains[]
}

/** status 字段语义：1=正常订阅；其他值当无限 */
const isActive = (s: number | undefined): boolean => s === 1

/**
 * 把 API 的"剩余百分比"反转为"已用百分比"，并判断是否无限。
 */
function toWindow(
  remainingPercent: number | undefined,
  status: number | undefined,
  remainsMs: number | undefined,
): { pct: number | null; resetSec: number | null } {
  if (!isActive(status)) return INFINITE_WIN
  const rem = Number(remainingPercent ?? 0)
  const used = Math.max(0, Math.min(PERCENT_SCALE, PERCENT_SCALE - rem))
  const resetSec = remainsMs && remainsMs > 0 ? Math.ceil(remainsMs / MS_PER_SEC) : null
  return { pct: used, resetSec }
}

export const minimaxFetcher: ProviderQuotaFetcher = {
  id: 'minimax',
  auth: ['api-key'],

  async fetchQuota(credential: string, _kind: QuotaAuthKind): Promise<QuotaFetchOutcome> {
    if (!credential) return { ok: false, reason: 'unauthorized' }

    try {
      const resp = await fetch(
        'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains',
        {
          headers: {
            authorization: `Bearer ${credential}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        },
      )
      if (!resp.ok) return { ok: false, reason: statusToReason(resp.status) }

      let data: MinimaxApiResponse
      try {
        data = (await resp.json()) as MinimaxApiResponse
      } catch {
        return { ok: false, reason: 'parse' }
      }
      // base_resp 非 0 / 无模型数据 / 无 general 条目 = 响应可解析但无订阅数据
      if (data?.base_resp?.status_code !== 0) return { ok: false, reason: 'no-subscription' }

      const models = data.model_remains ?? []
      if (models.length === 0) return { ok: false, reason: 'no-subscription' }

      // 只关注 model_name === "general"（文本/LLM 用量）
      const general = models.find((m) => m.model_name === 'general')
      if (!general) return { ok: false, reason: 'no-subscription' }

      const win5h = toWindow(
        general.current_interval_remaining_percent,
        general.current_interval_status,
        general.remains_time,
      )
      const winWk = toWindow(
        general.current_weekly_remaining_percent,
        general.current_weekly_status,
        general.weekly_remains_time,
      )

      // [A2-3] 平台 API 仅提供剩余百分比 + 时间（无总量字段），不编造 used/limit/unit
      // （待验证检查点 4 实测后跟进）
      return {
        ok: true,
        data: {
          label: 'MiniMax Coding',
          wins: [win5h, winWk, INFINITE_WIN],
        },
      }
    } catch (err) {
      // fetch 网络异常 / 超时 → network（架构约定 #4 落盘，禁止静默 catch）
      const msg = err instanceof Error ? err.message : String(err)
      logger.debug('[quota:minimax] fetch failed', { error: msg })
      return { ok: false, reason: 'network' }
    }
  },
}
