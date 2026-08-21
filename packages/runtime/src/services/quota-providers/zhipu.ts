/**
 * 智谱 GLM Coding Plan 额度 fetcher。
 *
 * API: GET https://bigmodel.cn/api/monitor/usage/quota/limit
 * Auth: authorization header（无 Bearer 前缀）+ org/project headers
 * 窗口：仅 5h（week/month = ∞）
 */

import type { ProviderQuotaFetcher, QuotaAuthKind, QuotaFetchOutcome } from './types.js'
import { INFINITE_WIN, statusToReason } from './types.js'

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
  // 智谱额度 API 为裸 authorization 头（无 Bearer 前缀），oauth 通道暂不声明（§3.4）
  auth: ['api-key'],

  async fetchQuota(credential: string, _kind: QuotaAuthKind): Promise<QuotaFetchOutcome> {
    if (!credential) return { ok: false, reason: 'unauthorized' }

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
      if (!resp.ok) return { ok: false, reason: statusToReason(resp.status) }

      let json: ZhipuApiResponse
      try {
        json = (await resp.json()) as ZhipuApiResponse
      } catch {
        return { ok: false, reason: 'parse' }
      }
      if (!json?.success || !json.data) return { ok: false, reason: 'no-subscription' }

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

      // [A2-3] 平台 API 仅提供 percentage+currentValue（5h 窗口），总量字段未实测可得，
      // 不编造 used/limit/unit（待验证检查点 4，Phase A2 前置实测后跟进）
      return {
        ok: true,
        data: {
          label,
          wins: [
            { pct: tokensPct, resetSec },
            INFINITE_WIN,
            INFINITE_WIN,
          ],
        },
      }
    } catch {
      // fetch 网络异常 / 超时（AbortSignal.timeout）→ network
      return { ok: false, reason: 'network' }
    }
  },
}
