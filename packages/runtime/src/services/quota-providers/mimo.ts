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
import { INFINITE_WIN, isRecord, statusToReason } from './types.js'
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

/**
 * JSON 边界轻量 shape guard：只校验决策分支依赖的字段类型（code 判定、
 * data.monthUsage.percent 解构）。字段缺失是合法业务态（→ no-subscription），
 * 字段类型漂移归 parse（防 `"401"` 等字符串 code 绕过 `!== 0` 判定产出错数据）。
 */
function isMimoResponse(v: unknown): v is MimoApiResponse {
  if (!isRecord(v)) return false
  const o = v
  if (typeof o.code !== 'number') return false
  if (o.data === undefined) return true
  if (!isRecord(o.data)) return false
  const d = o.data
  if (d.monthUsage !== undefined && (typeof d.monthUsage !== 'object' || d.monthUsage === null)) return false
  return true
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
      if (!isMimoResponse(data)) return { ok: false, reason: 'parse' }
      // code 非 0 = 响应可解析但无订阅数据。刻意保持 no-subscription 不细分为 unauthorized：
      // 平台无公开业务码文档（旧 extensions/shared 实现同样统一处理），cookie 失效也可能是非 0
      // code，fetcher 层无证据可区分——恢复指引由 UI 文案对 cookie 类 provider 同时提示
      // 「检查 Cookie 或订阅状态」兜底（cookie 失效返回 HTTP 401 的场景已由 statusToReason 覆盖）
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
