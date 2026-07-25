/**
 * useQuotaConfigure —— ProviderEditModal「Coding Plan 额度查询」Section 业务编排。
 *
 * 封装 quota.configure / quota.getCached / quota.fetch RPC 调用，
 * 管理 4 种 UI 状态（未启用 / API Key 类已配置 / Cookie 类已配置 / 查询失败）。
 *
 * 设计文档：docs/page-design/v3/coding-plan-quota/design.md §2.2.5
 * HANDOFF：.xyz-harness/coding-plan-quota/HANDOFF.md §5 Wave 3
 */
import { ref, computed, watch, type Ref } from 'vue'
import type { NormalizedQuotaRow, QuotaPreset, ProviderInfo } from '@xyz-agent/shared'
import * as quotaApi from '@/api/domains/quota'

/** 测试查询状态 */
export type QuotaTestStatus = 'idle' | 'loading' | 'success' | 'error'

/** composable 返回类型 */
export interface UseQuotaConfigureReturn {
  /** 是否启用额度查询（Switch 双向绑定） */
  enabled: Ref<boolean>
  /** cookie 输入值（cookie 类 provider 专用） */
  cookieInput: Ref<string>
  /** 测试查询状态 */
  testStatus: Ref<QuotaTestStatus>
  /** 测试查询错误信息（testStatus='error' 时有值） */
  testError: Ref<string>
  /** 最近一次成功查询的额度数据 */
  quotaData: Ref<NormalizedQuotaRow | null>
  /** 最后查询时间戳（ms） */
  lastFetchAt: Ref<number | null>
  /** 当前 preset 是否为 cookie 类认证 */
  isCookieAuth: Ref<boolean>
  /** 是否正在保存配置 */
  configuring: Ref<boolean>
  /** 保存配置错误 */
  configureError: Ref<string>

  /** 切换启用状态 */
  toggleEnabled: () => Promise<void>
  /** 保存 cookie 并启用 */
  saveCookie: () => Promise<void>
  /** 测试查询（触发 quota.fetch） */
  testQuery: () => Promise<void>
  /** 重置状态（provider 切换时调用） */
  reset: () => void
}

/**
 * @param preset - 当前匹配的 QuotaPreset（matchQuotaPreset 命中）
 * @param providerRef - 当前编辑的 ProviderInfo ref（读取 apiKeySet / quota 等）
 */
export function useQuotaConfigure(
  preset: Ref<QuotaPreset | undefined>,
  providerRef: Ref<ProviderInfo | null>,
): UseQuotaConfigureReturn {
  const enabled = ref(false)
  const cookieInput = ref('')
  const testStatus = ref<QuotaTestStatus>('idle')
  const testError = ref('')
  const quotaData = ref<NormalizedQuotaRow | null>(null)
  const lastFetchAt = ref<number | null>(null)
  const configuring = ref(false)
  const configureError = ref('')

  const isCookieAuth = computed(() => preset.value?.auth === 'cookie')

  // ── 初始化：从 provider.quota 读取已保存的配置 ──
  function syncFromProvider(): void {
    const p = providerRef.value
    if (!p?.quota) {
      enabled.value = false
      cookieInput.value = ''
      testStatus.value = 'idle'
      testError.value = ''
      quotaData.value = null
      lastFetchAt.value = null
      return
    }
    enabled.value = p.quota.enabled
    // cookie 明文不入前端，只标记是否已配置
    cookieInput.value = p.quota.cookieSet ? '••••••••' : ''
    // 如果已启用，尝试读缓存
    if (p.quota.enabled) {
      loadCached()
    }
  }

  /** 读缓存（quota.getCached，不发 HTTP 请求） */
  async function loadCached(): Promise<void> {
    const p = providerRef.value
    if (!p) return
    try {
      const result = await quotaApi.getCached(p.id)
      if (result.data) {
        quotaData.value = result.data
        lastFetchAt.value = result.lastFetchAt
        // 有缓存视为之前成功过
        if (testStatus.value === 'idle') {
          testStatus.value = 'success'
        }
      }
    } catch (e) {
      // getCached 失败静默（缓存可能不存在）
      console.debug('[quota] getCached failed:', e instanceof Error ? e.message : e)
    }
  }

  // provider 变化时同步状态
  watch(providerRef, syncFromProvider, { immediate: true })
  // preset 变化时重置（切换到不匹配的 provider 时清空）
  watch(preset, (newPreset) => {
    if (!newPreset) {
      reset()
    }
  })

  /** 切换启用状态（api-key 类直接调 configure；cookie 类需先填 cookie） */
  async function toggleEnabled(): Promise<void> {
    const p = providerRef.value
    const pr = preset.value
    if (!p || !pr) return

    const newEnabled = !enabled.value

    // cookie 类关闭时直接调 configure
    // cookie 类开启时需要先有 cookie 输入
    if (pr.auth === 'cookie' && newEnabled && !cookieInput.value.trim()) {
      configureError.value = '请先输入 Cookie'
      return
    }

    configuring.value = true
    configureError.value = ''

    try {
      const result = await quotaApi.configure(p.id, newEnabled)
      if (result.ok) {
        enabled.value = newEnabled
        if (newEnabled) {
          // 开启后自动测试一次
          await testQuery()
        }
      } else {
        configureError.value = result.error || '配置失败'
      }
    } catch (e) {
      configureError.value = e instanceof Error ? e.message : '配置失败'
    } finally {
      configuring.value = false
    }
  }

  /** 保存 cookie 并启用（cookie 类 provider） */
  async function saveCookie(): Promise<void> {
    const p = providerRef.value
    if (!p) return

    const cookie = cookieInput.value.trim()
    if (!cookie) {
      configureError.value = '请输入 Cookie'
      return
    }

    configuring.value = true
    configureError.value = ''

    try {
      const result = await quotaApi.configure(p.id, true, cookie)
      if (result.ok) {
        enabled.value = true
        // 保存后自动测试
        await testQuery()
      } else {
        configureError.value = result.error || 'Cookie 保存失败'
      }
    } catch (e) {
      configureError.value = e instanceof Error ? e.message : 'Cookie 保存失败'
    } finally {
      configuring.value = false
    }
  }

  /** 测试查询（触发 quota.refresh，绕过 throttle） */
  async function testQuery(): Promise<void> {
    const p = providerRef.value
    if (!p) return

    testStatus.value = 'loading'
    testError.value = ''

    try {
      // 用 refresh 绕过 10s throttle，确保测试查询每次都发真实请求（设计 §2.2.5）
      const result = await quotaApi.refreshQuota(p.id)
      if (result.data) {
        quotaData.value = result.data
        lastFetchAt.value = result.lastFetchAt
        testStatus.value = 'success'
      } else {
        // refresh 返回 null data = 凭证缺失或查询失败
        testStatus.value = 'error'
        testError.value = '查询失败，请检查凭证是否有效'
      }
    } catch (e) {
      testStatus.value = 'error'
      testError.value = e instanceof Error ? e.message : '查询失败'
    }
  }

  /** 重置全部状态 */
  function reset(): void {
    enabled.value = false
    cookieInput.value = ''
    testStatus.value = 'idle'
    testError.value = ''
    quotaData.value = null
    lastFetchAt.value = null
    configuring.value = false
    configureError.value = ''
  }

  return {
    enabled,
    cookieInput,
    testStatus,
    testError,
    quotaData,
    lastFetchAt,
    isCookieAuth,
    configuring,
    configureError,
    toggleEnabled,
    saveCookie,
    testQuery,
    reset,
  }
}
