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

import type { NormalizedQuotaRow, ProviderQuotaFetcher } from './types.js'

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
  authType: 'cookie',

  async fetchQuota(credential: string): Promise<NormalizedQuotaRow | null> {
    if (!credential) return null

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
      // 302 = cookie 过期
      if (resp.status !== HTTP_OK) return null

      const html = await resp.text()

      const rolling = extractWindow(html, 'rollingUsage')
      const weekly = extractWindow(html, 'weeklyUsage')
      const monthly = extractWindow(html, 'monthlyUsage')
      if (!rolling || !weekly || !monthly) return null

      return {
        label: 'opencode.go',
        wins: [toWin(rolling), toWin(weekly), toWin(monthly)],
      }
    } catch {
      return null
    }
  },

  /** 302 重定向 = cookie 过期 */
  isCredentialValid(response: unknown): boolean {
    if (response instanceof Response) {
      return response.status !== HTTP_REDIRECT
    }
    return true
  },
}
