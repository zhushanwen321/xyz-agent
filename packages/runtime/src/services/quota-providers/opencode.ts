/**
 * opencode.go 额度 fetcher。
 *
 * API: GET https://opencode.ai/workspace/wrk_.../go
 * Auth: Cookie + redirect:manual
 * 窗口：5h + week + month（全部支持）
 *
 * 关键点：SSR HTML 中嵌入数据（非 JSON），用正则解析。
 * HTTP 302 = cookie 过期。
 */

import type { ProviderQuotaFetcher, QuotaAuthKind, QuotaFetchOutcome } from './types.js'
import { statusToReason } from './types.js'
import { logger } from '../../infra/logger.js'

const FETCH_TIMEOUT_MS = 8000
const HTTP_OK = 200
const HTTP_REDIRECT = 302

interface WindowUsage {
  status: string
  usagePercent: number
  resetInSec: number
}

function extractWindow(html: string, name: string): WindowUsage | null {
  const re = new RegExp(`${name}:\\$R\\[\\d+\\]=\\{([^}]+)\\}`)
  const m = html.match(re)
  if (!m?.[1]) return null

  const obj = m[1]
  const statusM = obj.match(/status:"([^"]+)"/)
  const resetM = obj.match(/resetInSec:(\d+)/)
  const pctM = obj.match(/usagePercent:(\d+)/)
  if (!statusM || !resetM || !pctM) return null

  return {
    status: statusM[1],
    resetInSec: Number(resetM[1]),
    usagePercent: Number(pctM[1]),
  }
}

function toWin(u: WindowUsage): { pct: number | null; resetSec: number | null } {
  return {
    pct: u.usagePercent,
    resetSec: u.resetInSec > 0 ? u.resetInSec : null,
  }
}

export const opencodeFetcher: ProviderQuotaFetcher = {
  id: 'opencode-go',
  auth: ['cookie'],

  async fetchQuota(credential: string, _kind: QuotaAuthKind): Promise<QuotaFetchOutcome> {
    if (!credential) return { ok: false, reason: 'unauthorized' }

    try {
      const resp = await fetch(
        'https://opencode.ai/workspace/wrk_01KM5Q3EEQEHZJ3V5PXF5JCR62/go',
        {
          headers: {
            accept: 'text/html',
            cookie: credential,
            'user-agent': 'Mozilla/5.0',
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          redirect: 'manual',
        },
      )
      // 302 重定向 = cookie 过期（原 isCredentialValid 语义归入 unauthorized，A2-1）
      if (resp.status === HTTP_REDIRECT) return { ok: false, reason: 'unauthorized' }
      if (resp.status !== HTTP_OK) return { ok: false, reason: statusToReason(resp.status) }

      let html: string
      try {
        html = await resp.text()
      } catch {
        return { ok: false, reason: 'parse' }
      }

      const rolling = extractWindow(html, 'rollingUsage')
      const weekly = extractWindow(html, 'weeklyUsage')
      const monthly = extractWindow(html, 'monthlyUsage')
      // SSR HTML 中无三窗口数据 = 响应可解析但无订阅数据
      if (!rolling || !weekly || !monthly) return { ok: false, reason: 'no-subscription' }

      return {
        ok: true,
        data: {
          label: 'opencode.go',
          wins: [toWin(rolling), toWin(weekly), toWin(monthly)],
        },
      }
    } catch (err) {
      // fetch 网络异常 / 超时 → network（架构约定 #4 落盘，禁止静默 catch）
      const msg = err instanceof Error ? err.message : String(err)
      logger.debug('[quota:opencode] fetch failed', { error: msg })
      return { ok: false, reason: 'network' }
    }
  },
}
