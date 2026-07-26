/**
 * 智谱 GLM Coding Plan 额度 fetcher。
 *
 * API: GET https://bigmodel.cn/api/monitor/usage/quota/limit
 * Auth: authorization header（无 Bearer 前缀）+ org/project headers
 * 窗口：仅 5h（week/month = ∞）
 */

import type { NormalizedQuotaRow, ProviderQuotaFetcher } from './types.js'
import { INFINITE_WIN } from './types.js'

const FETCH_TIMEOUT_MS = 5000
const SEC_PER_DAY = 86400
const SEC_PER_HOUR = 3600
const SEC_PER_MIN = 60
const MS_PER_SEC = 1000

interface ZhipuLimit {
  type: string
  percentage?: number
  currentValue?: number
  nextResetTime?: string
}

interface ZhipuApiData {
  level?: string
  limits?: ZhipuLimit[]
}

interface ZhipuApiResponse {
  success?: boolean
  data?: ZhipuApiData
}

/** 把 ZAI 的 resetTime（如 "4h11m"/"3d20h"）转成剩余秒 */
function parseResetSec(label: string): number {
  const dM = label.match(/(\d+)d/)
  const hM = label.match(/(\d+)h/)
  const mM = label.match(/(\d+)m/)
  let sec = 0
  if (dM) sec += Number(dM[1]) * SEC_PER_DAY
  if (hM) sec += Number(hM[1]) * SEC_PER_HOUR
  if (mM) sec += Number(mM[1]) * SEC_PER_MIN
  return sec
}

/** 从 nextResetTime（epoch ms 字符串）计算剩余秒 */
function resetSecFromEpoch(epochMsStr: string): number | null {
  const epochMs = Number(epochMsStr)
  if (!epochMs || Number.isNaN(epochMs)) return null
  const remSec = Math.floor(epochMs / MS_PER_SEC) - Math.floor(Date.now() / MS_PER_SEC)
  return remSec > 0 ? remSec : null
}

export const zhipuFetcher: ProviderQuotaFetcher = {
  id: 'zhipu',
  authType: 'api-key',

  async fetchQuota(credential: string): Promise<NormalizedQuotaRow | null> {
    if (!credential) return null

    try {
      // 仅需 Authorization header 即可查询 Coding Plan 额度（参考 glm-quota-line 开源实现 +
      // quotio issue #75）。无需 org/project header——额度归属由 API key 本身绑定。
      const resp = await fetch('https://bigmodel.cn/api/monitor/usage/quota/limit', {
        headers: {
          accept: 'application/json, text/plain, */*',
          authorization: credential,
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!resp.ok) return null

      const json = (await resp.json()) as ZhipuApiResponse
      if (!json?.success || !json.data) return null

      const { data } = json
      const label = data.level ? `Z.ai-${data.level}` : 'Z.ai'

      let tokensPct = 0
      let resetSec: number | null = null

      for (const lim of data.limits ?? []) {
        if (lim.type === 'TOKENS_LIMIT') {
          tokensPct = lim.percentage ?? 0
          if (lim.nextResetTime) {
            resetSec = resetSecFromEpoch(lim.nextResetTime)
            if (resetSec === null) resetSec = parseResetSec(lim.nextResetTime)
          }
        }
      }

      return {
        label,
        wins: [
          { pct: tokensPct, resetSec },
          INFINITE_WIN,
          INFINITE_WIN,
        ],
      }
    } catch {
      return null
    }
  },
}
