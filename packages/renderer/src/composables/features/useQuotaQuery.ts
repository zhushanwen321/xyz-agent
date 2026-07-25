/**
 * useQuotaQuery —— coding-plan 额度查询的 hover-enter 触发逻辑。
 *
 * 封装 hover 进入容量 chip 时的查询流程：
 * 1. 先调 getCached 即时填充（避免空白闪烁）
 * 2. 紧接着调 fetch 触发实际 HTTP 查询
 * 3. 返回后响应式刷新
 * 4. 并发保护：pending 期间复用 Promise，不重复触发
 * 5. provider 未配置额度查询 → 跳过
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
  /** 是否正在查询中。 */
  isPending: Ref<boolean>
  /** 触发 hover-enter 查询。幂等：pending 期间重复调用无副作用。 */
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

  /** 是否正在查询中。 */
  const isPending = computed<boolean>(() => {
    const pid = providerIdRef.value
    return pid ? store.isPending(pid) : false
  })

  /**
   * hover-enter 触发查询。
   *
   * 流程：
   * 1. providerId 为空 → 跳过（未配置额度查询）
   * 2. 已在 pending → 跳过（并发保护）
   * 3. 先调 getCached 即时填充（composable 层不需额外处理，store 已有数据则直接响应式更新）
   * 4. 调 fetch 触发查询，成功写入 store
   * 5. 查询完成取消 pending 标记
   *
   * getCached 和 fetch 两条路径的数据都写入同一个 store 分区，
   * 组件层通过 computed 自动响应式刷新。
   */
  async function onHoverEnter(): Promise<void> {
    const pid = providerIdRef.value
    if (!pid) return
    if (!store.markPending(pid)) return // 并发保护：已在查询中

    try {
      // 步骤 1: getCached 即时填充（如果 store 已有数据，这一步是幂等的覆盖）
      // 步骤 2: fetch 触发实际查询
      // 两者顺序执行，但 getCached 是本地读取（几乎瞬时），不阻塞 UI
      const [cachedResult, fetchResult] = await Promise.allSettled([
        quotaApi.getCached(pid),
        quotaApi.fetchQuota(pid),
      ])

      // getCached 的结果：如果成功且 store 尚无数据，先写入（避免 fetch 耗时期间空白）
      if (cachedResult.status === 'fulfilled') {
        const cached = cachedResult.value
        // 只在 store 无数据时用 cached 填充（避免覆盖 fetch 的更新值）
        if (!store.getEntry(pid)) {
          store.setCache(pid, cached.data, cached.lastFetchAt)
        }
      }

      // fetch 的结果：成功则写入最新值（覆盖 cached 或旧值）
      if (fetchResult.status === 'fulfilled') {
        store.setCache(pid, fetchResult.value.data, fetchResult.value.lastFetchAt)
      }
    } finally {
      store.unmarkPending(pid)
    }
  }

  return {
    data,
    lastFetchAt,
    isPending,
    onHoverEnter,
  }
}
