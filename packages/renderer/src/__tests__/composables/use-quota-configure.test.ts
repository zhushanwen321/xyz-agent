/**
 * useQuotaConfigure composable 单测（PR #187 A2-4 reason 透传 + B-3 凭证能力声明）。
 *
 * 覆盖：
 * - loadCached：缓存层透传 reason → 整体呈失败态（testStatus='error' + testFailReason），
 *  旧缓存保留在 quotaData（「查看上次成功数据」数据源）；无 reason → success 态
 * - testQuery：refresh 失败态（data=null + reason）→ testFailReason 透传 +
 *  lastFetchAt 更新为最近一次成功时间（旧值不丢）；成功态 testFailReason 复位
 * - reset：testFailReason 清空
 * - authKinds：fetcherId 优先、fallback 自动匹配 preset（B-3）
 *
 * mock 策略：vi.mock('@/api/domains/quota') 替换 RPC 层（composable 直连 domain，
 * 对齐 provider-edit-body-phase-b.test.ts）；pinia 提供 useQuotaStore。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/use-quota-configure.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import type { NormalizedQuotaRow, ProviderInfo, QuotaPreset } from '@xyz-agent/shared'
import { QUOTA_PRESETS, matchQuotaPreset } from '@xyz-agent/shared'

vi.mock('@/api/domains/quota', () => ({
  getCached: vi.fn(),
  fetchQuota: vi.fn(),
  refreshQuota: vi.fn(),
  configure: vi.fn(async () => ({ ok: true })),
}))

import * as quotaApi from '@/api/domains/quota'
import { useQuotaConfigure } from '@/composables/features/model/useQuotaConfigure'
import { useToast } from '@/composables/useToast'

const mockRow: NormalizedQuotaRow = {
  label: 'Kimi Coding Plan',
  wins: [
    { pct: 24, used: 1204, limit: 5000, unit: 'requests', resetSec: 9005 },
    { pct: 41, resetSec: null },
    { pct: null, resetSec: null },
  ],
}

/** kimi-coding 命中的 preset（auth=['api-key','oauth']，B-3 双能力） */
const KIMI_PRESET: QuotaPreset | undefined = QUOTA_PRESETS.find((p) => p.fetcher === 'kimi-coding')

/** opencode-go 命中的 preset（auth=['cookie'] + requiresWorkspace，D1-1 资源维度） */
const OPENCODE_PRESET: QuotaPreset | undefined = QUOTA_PRESETS.find((p) => p.fetcher === 'opencode-go')

/** 已配置 workspace 的 opencode provider（quota.workspace 明文回显） */
function opencodeProvider(): ProviderInfo {
  return {
    id: 'my-opencode',
    name: 'My opencode',
    api: 'openai-completions',
    apiKeySet: false,
    status: 'connected',
    enabled: true,
    quota: { enabled: false, fetcher: 'opencode-go', workspace: 'https://opencode.ai/workspace/wrk_saved/go' },
    models: [],
  }
}

/** 已启用额度查询的 kimi provider */
function kimiProvider(): ProviderInfo {
  return {
    id: 'kimi-coding',
    name: 'Kimi Coding',
    api: 'openai-completions',
    baseUrl: 'https://api.kimi.com/v1',
    apiKeySet: true,
    status: 'connected',
    enabled: true,
    quota: { enabled: true },
    models: [],
  }
}

/** 从模块级 toast 单例读当前 toast 文案（error 路径用户可见反馈） */
function toastMessages(): string[] {
  return useToast().toasts.value.map((t) => t.message)
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.mocked(quotaApi.configure).mockResolvedValue({ ok: true })
  useToast().toasts.value = []
})

afterEach(() => {
  useToast().toasts.value = []
})

describe('useQuotaConfigure loadCached（A2-4 缓存层 reason 透传）', () => {
  it('缓存携带 reason=unauthorized → 失败态（testStatus=error + testFailReason），旧数据保留 quotaData', async () => {
    vi.mocked(quotaApi.getCached).mockResolvedValue({ data: mockRow, lastFetchAt: 1000, reason: 'unauthorized' })
    const providerRef = ref<ProviderInfo | null>(kimiProvider())

    const { testStatus, testFailReason, quotaData, lastFetchAt } = useQuotaConfigure(
      ref(KIMI_PRESET),
      providerRef,
    )
    // watch immediate → syncFromProvider → enabled → loadCached（异步）
    await vi.waitFor(() => { expect(testStatus.value).toBe('error') })

    expect(testFailReason.value).toBe('unauthorized')
    // 旧缓存保留（「查看上次成功数据」展开可见的数据源）
    expect(quotaData.value).toEqual(mockRow)
    expect(lastFetchAt.value).toBe(1000)
  })

  it('缓存无 reason → success 态 + testFailReason=null', async () => {
    vi.mocked(quotaApi.getCached).mockResolvedValue({ data: mockRow, lastFetchAt: 1000 })
    const providerRef = ref<ProviderInfo | null>(kimiProvider())

    const { testStatus, testFailReason } = useQuotaConfigure(ref(KIMI_PRESET), providerRef)
    await vi.waitFor(() => { expect(testStatus.value).toBe('success') })

    expect(testFailReason.value).toBeNull()
  })

  it('provider 无 quota 配置 → idle 态 + testFailReason=null（不调 getCached）', async () => {
    const provider = kimiProvider()
    delete provider.quota
    const providerRef = ref<ProviderInfo | null>(provider)

    const { testStatus, testFailReason } = useQuotaConfigure(ref(KIMI_PRESET), providerRef)
    await Promise.resolve()

    expect(testStatus.value).toBe('idle')
    expect(testFailReason.value).toBeNull()
    expect(quotaApi.getCached).not.toHaveBeenCalled()
  })
})

describe('useQuotaConfigure testQuery（A2-4 失败态 reason 透传）', () => {
  it('refresh 失败（data=null + reason=network）→ testFailReason=network + lastFetchAt 更新为最近成功时间', async () => {
    vi.mocked(quotaApi.getCached).mockResolvedValue({ data: mockRow, lastFetchAt: 1000 })
    vi.mocked(quotaApi.refreshQuota).mockResolvedValue({ data: null, lastFetchAt: 5000, reason: 'network' })
    const providerRef = ref<ProviderInfo | null>(kimiProvider())

    const { testQuery, testStatus, testFailReason, testError, quotaData, lastFetchAt } = useQuotaConfigure(
      ref(KIMI_PRESET),
      providerRef,
    )
    await vi.waitFor(() => { expect(testStatus.value).toBe('success') })

    await testQuery()

    // 失败态：reason 透传（恢复指引文案按 reason 渲染）+ 旧缓存保留 + lastFetchAt=最近成功
    expect(testStatus.value).toBe('error')
    expect(testFailReason.value).toBe('network')
    expect(quotaData.value).toEqual(mockRow)
    expect(lastFetchAt.value).toBe(5000)
    expect(quotaApi.refreshQuota).toHaveBeenCalledWith('kimi-coding')
    // 回退文案走 i18n（BL round1 S3：原硬编码中文串在 en-US locale 也会透出）
    expect(testError.value).toBe('查询失败，请检查凭证')
  })

  it('refresh 成功 → testFailReason 复位为 null（上次失败痕迹不残留）', async () => {
    // 先制造失败缓存态，再成功查询验证复位
    vi.mocked(quotaApi.getCached).mockResolvedValue({ data: mockRow, lastFetchAt: 1000, reason: 'unauthorized' })
    vi.mocked(quotaApi.refreshQuota).mockResolvedValue({ data: mockRow, lastFetchAt: 2000 })
    const providerRef = ref<ProviderInfo | null>(kimiProvider())

    const { testQuery, testStatus, testFailReason } = useQuotaConfigure(ref(KIMI_PRESET), providerRef)
    await vi.waitFor(() => { expect(testStatus.value).toBe('error') })

    await testQuery()

    expect(testStatus.value).toBe('success')
    expect(testFailReason.value).toBeNull()
  })

  it('refresh 抛错（transport 断连）→ error 态 + testFailReason=null（非 reason 型）', async () => {
    vi.mocked(quotaApi.refreshQuota).mockRejectedValue(new Error('transport unavailable'))
    const providerRef = ref<ProviderInfo | null>(kimiProvider())

    const { testQuery, testStatus, testFailReason, testError } = useQuotaConfigure(ref(KIMI_PRESET), providerRef)
    await testQuery()

    expect(testStatus.value).toBe('error')
    expect(testFailReason.value).toBeNull()
    expect(testError.value).toContain('transport unavailable')
  })
})

describe('useQuotaConfigure reset（provider 切换清空失败痕迹）', () => {
  it('失败态后 reset → testStatus=idle + testFailReason=null + quotaData 清空', async () => {
    vi.mocked(quotaApi.getCached).mockResolvedValue({ data: mockRow, lastFetchAt: 1000, reason: 'unauthorized' })
    const providerRef = ref<ProviderInfo | null>(kimiProvider())

    const { reset, testStatus, testFailReason, quotaData } = useQuotaConfigure(ref(KIMI_PRESET), providerRef)
    await vi.waitFor(() => { expect(testStatus.value).toBe('error') })

    reset()

    expect(testStatus.value).toBe('idle')
    expect(testFailReason.value).toBeNull()
    expect(quotaData.value).toBeNull()
  })
})

describe('useQuotaConfigure workspace（D1-1 资源维度 fetcher 配置）', () => {
  it('opencode preset → needsWorkspace=true；kimi → false（账号维度隐藏输入框）', async () => {
    const { needsWorkspace } = useQuotaConfigure(ref(OPENCODE_PRESET), ref<ProviderInfo | null>(opencodeProvider()))
    await Promise.resolve()
    expect(needsWorkspace.value).toBe(true)

    const kimi = useQuotaConfigure(ref(KIMI_PRESET), ref<ProviderInfo | null>(kimiProvider()))
    await Promise.resolve()
    expect(kimi.needsWorkspace.value).toBe(false)
  })

  it('syncFromProvider：已保存 workspace 明文回显 + workspaceConfigured=true', async () => {
    const { workspaceInput, workspaceConfigured } = useQuotaConfigure(
      ref(OPENCODE_PRESET),
      ref<ProviderInfo | null>(opencodeProvider()),
    )
    await Promise.resolve()
    expect(workspaceInput.value).toBe('https://opencode.ai/workspace/wrk_saved/go')
    expect(workspaceConfigured.value).toBe(true)
  })

  it('saveWorkspace：裸 wrk_ id → 归一化 URL 走 configure 持久化（P1-1 两形态）', async () => {
    const providerRef = ref<ProviderInfo | null>(opencodeProvider())
    const { workspaceInput, saveWorkspace, workspaceConfigured } = useQuotaConfigure(ref(OPENCODE_PRESET), providerRef)
    await Promise.resolve()

    workspaceInput.value = 'wrk_newid77'
    await saveWorkspace()

    expect(quotaApi.configure).toHaveBeenCalledWith(
      'my-opencode', false, undefined, 'opencode-go', undefined,
      'https://opencode.ai/workspace/wrk_newid77/go',
    )
    expect(workspaceConfigured.value).toBe(true)
  })

  it('saveWorkspace：非法输入（他域 URL）→ 本地报错不发 RPC（configureError 落 i18n 文案）', async () => {
    const providerRef = ref<ProviderInfo | null>(opencodeProvider())
    const { workspaceInput, saveWorkspace, configureError } = useQuotaConfigure(ref(OPENCODE_PRESET), providerRef)
    await Promise.resolve()

    workspaceInput.value = 'https://evil.example.com/workspace/wrk_x/go'
    await saveWorkspace()

    expect(quotaApi.configure).not.toHaveBeenCalled()
    expect(configureError.value).toBe('Workspace 地址无效：请粘贴 opencode.ai 的 workspace 页 URL（形如 https://opencode.ai/workspace/wrk_xxx/go）或裸 wrk_ id')
  })

  it('saveWorkspace：空输入且未配置 → 提示先输入，不发 RPC', async () => {
    const provider = opencodeProvider()
    provider.quota = { enabled: false, fetcher: 'opencode-go' } // 未配置 workspace
    const { workspaceInput, saveWorkspace, configureError, workspaceConfigured } = useQuotaConfigure(
      ref(OPENCODE_PRESET),
      ref<ProviderInfo | null>(provider),
    )
    await Promise.resolve()
    expect(workspaceConfigured.value).toBe(false)

    workspaceInput.value = '  '
    await saveWorkspace()

    expect(configureError.value).toBe('请先输入 Workspace 地址')
    expect(quotaApi.configure).not.toHaveBeenCalled()
  })

  it('saveWorkspace：已配置时空串 = 清除（configure 收到空 workspace）', async () => {
    const { workspaceInput, saveWorkspace, configureError } = useQuotaConfigure(
      ref(OPENCODE_PRESET),
      ref<ProviderInfo | null>(opencodeProvider()),
    )
    await Promise.resolve()

    workspaceInput.value = ''
    await saveWorkspace()

    expect(configureError.value).toBe('')
    expect(quotaApi.configure).toHaveBeenCalledWith(
      'my-opencode', false, undefined, 'opencode-go', undefined, '',
    )
  })

  it('saveWorkspace：启用状态下保存成功 → 自动测试查询（与 saveCookie 同模式）', async () => {
    vi.mocked(quotaApi.refreshQuota).mockResolvedValue({ data: mockRow, lastFetchAt: 2000 })
    const provider = opencodeProvider()
    provider.quota = { ...provider.quota!, enabled: true }
    const providerRef = ref<ProviderInfo | null>(provider)
    const { workspaceInput, saveWorkspace, testStatus } = useQuotaConfigure(ref(OPENCODE_PRESET), providerRef)
    await Promise.resolve()

    workspaceInput.value = 'https://opencode.ai/workspace/wrk_new/go'
    await saveWorkspace()

    expect(testStatus.value).toBe('success')
    expect(quotaApi.refreshQuota).toHaveBeenCalledWith('my-opencode')
  })
})

describe('useQuotaConfigure authKinds（B-3 凭证能力声明）', () => {
  it('未手动选 fetcher → fallback 自动匹配 preset 的 auth（api-key + oauth 双能力）', async () => {
    const providerRef = ref<ProviderInfo | null>(kimiProvider())
    // 契约 gate：fixture 的 baseUrl/name 确实命中 kimi preset（数据自洽前置）
    expect(KIMI_PRESET).toBeDefined()
    expect(matchQuotaPreset(kimiProvider())).toBe(KIMI_PRESET)

    const { authKinds, fetcherId } = useQuotaConfigure(ref(KIMI_PRESET), providerRef)
    await Promise.resolve()

    // quota.fetcher 未设置 → fetcherId 跟随 preset，authKinds 同步
    expect(fetcherId.value).toBe('kimi-coding')
    expect(authKinds.value).toEqual(['api-key', 'oauth'])
  })

  it("手动选 cookie 类 fetcher（mimo）→ authKinds=['cookie'] + isCookieAuth=true", async () => {
    const providerRef = ref<ProviderInfo | null>(kimiProvider())

    const { authKinds, isCookieAuth, selectFetcher, fetcherId } = useQuotaConfigure(ref(KIMI_PRESET), providerRef)
    await selectFetcher('mimo')

    expect(fetcherId.value).toBe('mimo')
    expect(authKinds.value).toEqual(['cookie'])
    expect(isCookieAuth.value).toBe(true)
    // selectFetcher 持久化 payload 携带 fetcher
    expect(quotaApi.configure).toHaveBeenCalledWith('kimi-coding', true, undefined, 'mimo')
  })
})
