/**
 * useQuotaQuery —— coding-plan 额度查询的 hover-enter 触发逻辑。
 *
 * 封装 hover 进入容量 chip 时的查询流程：
 * 1. 先调 getCached 即时填充（避免空白闪烁）
 * 2. 紧接着调 fetch 触发实际 HTTP 查询
 * 3. 返回后响应式刷新
 * 4. 并发保护：pending 期间复用 Promise，不重复触发
 * 5. provider 未配置额度查询 → 跳过
 * 6. fetchQuota rejected 时写 error 到 store（UI 区分「从未查询」vs「查询失败」）
 *
 * 设计文档：docs/page-design/v3/coding-plan-quota/design.md §2.2.4
 * HANDOFF：.xyz-harness/coding-plan-quota/HANDOFF.md §5 Wave 4
 */
import { computed } from 'vue'
import type { Ref } from 'vue'
import type { NormalizedQuotaRow } from '@xyz-agent/shared'
import { useQuotaStore, type QuotaCacheEntry } from '@/stores/quota'
import * as quotaApi from '@/api/domains/quota'

/** 查询结果（composable 返回给消费方的响应式状态）。 */
export interface UseQuotaQueryResult {
  /** 当前 provider 的额度数据（响应式，store 变更后自动更新）。 */
  data: Ref<NormalizedQuotaRow | null>
  /** 最后一次成功查询的时间戳（Unix ms）。 */
  lastFetchAt: Ref<number | null>
  /** 最后一次查询的错误信息（非空 = 查询失败，UI 显失败提示）。 */
  error: Ref<string | null>
  /** 是否正在查询中。 */
  isPending: Ref<boolean>
  /** 触发 hover-enter 查询（受 10s throttle）。幂等：pending 期间重复调用无副作用。 */
  onHoverEnter: () => Promise<void>
}

/**
 * 创建针对特定 provider 的额度查询控制器。
 *
 * @param providerIdRef - 当前 provider ID 的响应式引用（session 切模型时变化）。
 *   null = 未命中 quota preset，不显示 coding-plan 区。
 * @returns 查询结果和触发方法。
 */
export function useQuotaQuery(providerIdRef: Ref<string | null>): UseQuotaQueryResult {
  const store = useQuotaStore()

  /** 当前 provider 的缓存条目（响应式）。 */
  const entry = computed<QuotaCacheEntry | undefined>(() => {
    const pid = providerIdRef.value
    return pid ? store.getEntry(pid) : undefined
  })

  /** 额度数据。无缓存时返回 null。 */
  const data = computed<NormalizedQuotaRow | null>(() => entry.value?.data ?? null)

  /** 最后查询时间。 */
  const lastFetchAt = computed<number | null>(() => entry.value?.lastFetchAt ?? null)

  /** 最后一次查询错误（null = 无错误或从未查询）。 */
  const error = computed<string | null>(() => entry.value?.error ?? null)

  /** 是否正在查询中。 */
  const isPending = computed<boolean>(() => {
    const pid = providerIdRef.value
    return pid ? store.isPending(pid) : false
  })

  /**
   * hover-enter 触发查询（受 10s throttle）。
   *
   * 流程：
   * 1. providerId 为空 → 跳过（未配置额度查询）
   * 2. 已在 pending → 跳过（并发保护）
   * 3. 先调 getCached 即时填充
   * 4. 调 fetch 触发查询，成功写入 store（清 error），失败写 error
   * 5. 查询完成取消 pending 标记
   */
  async function onHoverEnter(): Promise<void> {
    const pid = providerIdRef.value
    if (!pid) return
    if (!store.markPending(pid)) return // 并发保护：已在查询中

    try {
      const [cachedResult, fetchResult] = await Promise.allSettled([
        quotaApi.getCached(pid),
        quotaApi.fetchQuota(pid),
      ])

      // getCached 的结果：成功且 store 尚无数据时先用 cached 填充（避免 fetch 耗时期间空白）
      if (cachedResult.status === 'fulfilled') {
        const cached = cachedResult.value
        if (!store.getEntry(pid)) {
          store.setCache(pid, cached.data, cached.lastFetchAt)
        }
      }

      // fetch 的结果：成功则写入最新值（覆盖 cached 或旧值，清 error）；失败写 error
      if (fetchResult.status === 'fulfilled') {
        store.setCache(pid, fetchResult.value.data, fetchResult.value.lastFetchAt)
      } else {
        // fetchQuota rejected：保留旧缓存，写 error 让 UI 区分「从未查询」vs「查询失败」
        const msg = fetchResult.reason instanceof Error
          ? fetchResult.reason.message
          : String(fetchResult.reason ?? 'unknown error')
        store.setError(pid, msg)
      }
    } finally {
      store.unmarkPending(pid)
    }
  }

  return {
    data,
    lastFetchAt,
    error,
    isPending,
    onHoverEnter,
  }
}
