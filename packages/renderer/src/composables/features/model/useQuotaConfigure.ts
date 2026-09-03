/**
 * useQuotaConfigure —— ProviderEditModal「Coding Plan 额度查询」Section 业务编排。
 *
 * 封装 quota.configure / quota.getCached / quota.fetch RPC 调用，
 * 管理 4 种 UI 状态（未启用 / API Key 类已配置 / Cookie 类已配置 / 查询失败）。
 *
 * 设计文档：docs/page-design/archive/v3/coding-plan-quota/design.md §2.2.5
 * HANDOFF：.xyz-harness/coding-plan-quota/HANDOFF.md §5 Wave 3
 */
import { ref, computed, watch, type Ref } from 'vue'
import type { NormalizedQuotaRow, QuotaPreset, ProviderInfo, QuotaAuthKind, QuotaFetchFailureReason } from '@xyz-agent/shared'
import { QUOTA_PRESETS } from '@xyz-agent/shared'
import type { QuotaConfigureState, QuotaTestStatus } from '@xyz-agent/core'
import * as quotaApi from '@xyz-agent/core/transport/api/domains/quota'
import i18n from '@/i18n'
import { useQuotaStore } from '@/stores/quota'

// i18n.global.t 的类型窄化 cast（对齐 useQuotaQuery 的非 setup composable 模式）：
// 失败文案走 i18n（en-US locale 不再透出硬编码中文）。
const t = i18n.global.t as (key: string) => string

// 状态契约 SSOT 在 core（ui injection-keys 与本 composable 共享，字段语义注释见彼处）
export type { QuotaTestStatus }

/**
 * composable 返回类型 = core 契约（[BL round1 monorepo S] 原 ui injection-keys 逐字段
 * 手工镜像本接口，提升 core 后双侧 import 同一类型消除镜像）。
 */
export type UseQuotaConfigureReturn = QuotaConfigureState

/**
 * @param preset - 当前匹配的 QuotaPreset（matchQuotaPreset 命中）
 * @param providerRef - 当前编辑的 ProviderInfo ref（读取 apiKeySet / quota 等）
 */
export function useQuotaConfigure(
  preset: Ref<QuotaPreset | undefined>,
  providerRef: Ref<ProviderInfo | null>,
): UseQuotaConfigureReturn {
  const quotaStore = useQuotaStore()
  const enabled = ref(false)
  const fetcherId = ref<string | undefined>(undefined)
  const cookieInput = ref('')
  const apiKeyInput = ref('')
  const apiKeyConfigured = ref(false)
  const testStatus = ref<QuotaTestStatus>('idle')
  const testError = ref('')
  const quotaData = ref<NormalizedQuotaRow | null>(null)
  const lastFetchAt = ref<number | null>(null)
  const configuring = ref(false)
  const configureError = ref('')

  /** 下拉框选项：QUOTA_PRESETS 映射为 { value, label } */
  const fetcherOptions = QUOTA_PRESETS.map((p) => ({ value: p.fetcher, label: p.label }))

  /**
   * isCookieAuth：基于当前选中的 fetcherId 计算（而非 preset.auth）。
   * 用户手动选了 cookie 类 fetcher（mimo/opencode-go）时显示 cookie 输入区。
   * fetcherId 未选择时 fallback 到 preset.auth。
   * [A2-1] auth 数组化后单值判断改 includes：preset 声明含 cookie 形态即视为 cookie 类
   * （内置 5 preset 中仅 mimo/opencode-go 声明，行为与单值时代一致）。
   */
  const isCookieAuth = computed(() => {
    const fid = fetcherId.value
    if (fid) {
      const opt = QUOTA_PRESETS.find((p) => p.fetcher === fid)
      return opt?.auth.includes('cookie') ?? false
    }
    return preset.value?.auth.includes('cookie') ?? false
  })

  /**
   * 当前选中 fetcher 对应的预设（用于 helpUrl/helpText）。
   * fetcherId 优先，未选时 fallback 到自动匹配的 preset。
   */
  const activePreset = computed<QuotaPreset | undefined>(() => {
    const fid = fetcherId.value
    if (fid) return QUOTA_PRESETS.find((p) => p.fetcher === fid)
    return preset.value
  })

  /** 帮助链接（基于当前选中 fetcher）。 */
  const helpUrl = computed<string | undefined>(() => activePreset.value?.helpUrl)
  /** 帮助文案（基于当前选中 fetcher）。 */
  const helpText = computed<string | undefined>(() => activePreset.value?.helpText)

  /**
   * 当前选中 fetcher 的凭证能力声明（B-3）：fetcherId 优先、fallback 自动匹配 preset。
   * CodingPlanSection 据此渲染凭证态（oauth 就绪/缺失、api-key 回退顺序说明）。
   */
  const authKinds = computed<readonly QuotaAuthKind[]>(() => activePreset.value?.auth ?? [])

  /** 最近一次查询失败原因（A2-4 reason 透传；null = 无失败）。旧缓存保留在 quotaData（「查看上次成功数据」） */
  const testFailReason = ref<QuotaFetchFailureReason | null>(null)

  // ── 初始化：从 provider.quota 读取已保存的配置 ──
  function syncFromProvider(): void {
    const p = providerRef.value
    if (!p?.quota) {
      enabled.value = false
      // fetcherId 默认值：provider.quota.fetcher > 自动匹配的 preset.fetcher > undefined
      fetcherId.value = preset.value?.fetcher
      cookieInput.value = ''
      apiKeyInput.value = ''
      apiKeyConfigured.value = false
      testStatus.value = 'idle'
      testError.value = ''
      testFailReason.value = null
      quotaData.value = null
      lastFetchAt.value = null
      return
    }
    enabled.value = p.quota.enabled
    // fetcherId 初始值：手动指定的 quota.fetcher 优先，未设置时 fallback 到自动匹配值
    fetcherId.value = p.quota.fetcher ?? preset.value?.fetcher
    // cookie 明文不入前端，只标记是否已配置
    cookieInput.value = p.quota.cookieSet ? '••••••••' : ''
    // 专属 API Key 明文不入前端，只标记是否已配置（用于占位符提示）
    apiKeyConfigured.value = p.quota.apiKeySet === true
    apiKeyInput.value = ''
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
        if (testStatus.value === 'idle') {
          // 上次查询失败（缓存层透传 reason）：整体呈失败态，旧数据经「查看上次成功数据」
          // 展开可见（design §3.4 失败态与旧缓存并存的展示语义）
          testStatus.value = result.reason ? 'error' : 'success'
          testFailReason.value = result.reason ?? null
        }
      }
    } catch (e) {
      // getCached 失败静默（缓存可能不存在）
      console.debug('[quota] getCached failed:', e instanceof Error ? e.message : e)
    }
  }

  // provider 变化时同步状态
  watch(providerRef, syncFromProvider, { immediate: true })
  // preset 变化时：若用户未手动指定 fetcherId，跟随自动匹配值更新默认。
  // 不再 reset 全部状态——用户可能已手动选了 fetcher 或填了 cookie。
  watch(preset, (newPreset) => {
    const p = providerRef.value
    const manualFetcher = p?.quota?.fetcher
    if (manualFetcher) {
      // 已手动指定，保留
      fetcherId.value = manualFetcher
    } else {
      fetcherId.value = newPreset?.fetcher
    }
  })

  /** 选择 fetcher 类型（同步本地 fetcherId + 持久化到 quota.fetcher）。 */
  async function selectFetcher(id: string): Promise<void> {
    const p = providerRef.value
    if (!p) return
    // 保存旧值用于失败回滚（参照 toggleEnabled 的乐观更新回滚模式）
    const prevFetcherId = fetcherId.value
    fetcherId.value = id
    configuring.value = true
    configureError.value = ''
    try {
      // 持久化 fetcher（enabled 沿用当前值，未启用过则默认 false）
      const result = await quotaApi.configure(p.id, enabled.value, undefined, id)
      if (!result.ok) {
        // RPC 失败：回滚 fetcherId
        fetcherId.value = prevFetcherId
        configureError.value = result.error || '保存类型失败'
      }
    } catch (e) {
      // 异常：回滚 fetcherId
      fetcherId.value = prevFetcherId
      configureError.value = e instanceof Error ? e.message : '保存类型失败'
    } finally {
      configuring.value = false
    }
  }

  /**
   * 切换启用状态（api-key 类直接调 configure；cookie 类需先填 cookie）。
   * 乐观更新：立即翻转 enabled 让 Switch 视觉响应，RPC 失败再回滚。
   * reka-ui Switch 是受控组件，异步更新 modelValue 会导致点击后视觉回弹。
   */
  async function toggleEnabled(): Promise<void> {
    const p = providerRef.value
    if (!p) return

    const prevEnabled = enabled.value
    const newEnabled = !prevEnabled

    // cookie 类开启时需要先有 cookie 输入（基于当前 fetcherId 判断认证方式）
    if (isCookieAuth.value && newEnabled && !cookieInput.value.trim()) {
      configureError.value = '请先输入 Cookie'
      return
    }

    // 乐观更新：立即翻转，Switch 视觉立即响应
    enabled.value = newEnabled
    configuring.value = true
    configureError.value = ''

    try {
      const result = await quotaApi.configure(p.id, newEnabled, undefined, fetcherId.value)
      if (result.ok) {
        if (newEnabled) {
          // 开启后自动测试一次（不阻塞 configuring 状态太久）
          await testQuery()
        } else {
          // 关闭额度查询：清除缓存（避免 popover 显示过期数据，clearCache 此前无调用方）
          quotaStore.clearCache(p.id)
        }
      } else {
        // RPC 失败：回滚
        enabled.value = prevEnabled
        configureError.value = result.error || '配置失败'
      }
    } catch (e) {
      // 异常：回滚
      enabled.value = prevEnabled
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
      const result = await quotaApi.configure(p.id, true, cookie, fetcherId.value)
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

  /**
   * 保存专属 API Key（api-key 类 provider）。
   * - 非空字符串 = 写入专属 key，后续查询优先用它
   * - 空字符串 = 清除专属 key，fallback 到 provider.apiKey（上方填写的）
   * 明文 key 不入前端状态，仅更新 apiKeyConfigured 标记。
   */
  async function saveApiKey(): Promise<void> {
    const p = providerRef.value
    if (!p) return

    configuring.value = true
    configureError.value = ''

    try {
      const apiKey = apiKeyInput.value.trim()
      const result = await quotaApi.configure(
        p.id,
        enabled.value,
        undefined,
        fetcherId.value,
        apiKey,
      )
      if (result.ok) {
        apiKeyConfigured.value = apiKey.length > 0
        // 清除专属 API Key（apiKey 空串）后，旧缓存可能失效（凭证已变），清除让下次查询重拉
        if (apiKey.length === 0) {
          quotaStore.clearCache(p.id)
        }
        apiKeyInput.value = ''
        // 保存后自动测试（如果已启用）
        if (enabled.value) await testQuery()
      } else {
        configureError.value = result.error || 'API Key 保存失败'
      }
    } catch (e) {
      configureError.value = e instanceof Error ? e.message : 'API Key 保存失败'
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
    testFailReason.value = null

    try {
      // 用 refresh 绕过 10s throttle，确保测试查询每次都发真实请求（设计 §2.2.5）
      const result = await quotaApi.refreshQuota(p.id)
      if (result.data) {
        quotaData.value = result.data
        lastFetchAt.value = result.lastFetchAt
        testStatus.value = 'success'
      } else {
        // 失败态（A2-4）：reason 透传给 UI（恢复指引文案按 reason 渲染）；旧缓存保留在
        // quotaData 不展示（「查看上次成功数据」展开可见）；lastFetchAt = 最近一次成功时间
        testStatus.value = 'error'
        testFailReason.value = result.reason ?? null
        lastFetchAt.value = result.lastFetchAt
        testError.value = t('settings.providerEdit.quotaTestFail')
      }
    } catch (e) {
      testStatus.value = 'error'
      testError.value = e instanceof Error ? e.message : '查询失败'
    }
  }

  /** 重置全部状态 */
  function reset(): void {
    enabled.value = false
    fetcherId.value = undefined
    cookieInput.value = ''
    apiKeyInput.value = ''
    apiKeyConfigured.value = false
    testStatus.value = 'idle'
    testError.value = ''
    testFailReason.value = null
    quotaData.value = null
    lastFetchAt.value = null
    configuring.value = false
    configureError.value = ''
  }

  return {
    fetcherId,
    fetcherOptions,
    enabled,
    cookieInput,
    apiKeyInput,
    apiKeyConfigured,
    testStatus,
    testError,
    testFailReason,
    quotaData,
    lastFetchAt,
    isCookieAuth,
    authKinds,
    helpUrl,
    helpText,
    configuring,
    configureError,
    toggleEnabled,
    selectFetcher,
    saveCookie,
    saveApiKey,
    testQuery,
    reset,
  }
}
