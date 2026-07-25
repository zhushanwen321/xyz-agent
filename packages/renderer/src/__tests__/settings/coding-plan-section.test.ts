/**
 * CodingPlanSection 组件 + useQuotaConfigure composable 单测。
 *
 * 4 种 UI 状态：
 * 1) 未启用（Switch off，帮助文案）
 * 2) API Key 类已配置（Switch on，复用上方 apiKey，测试查询按钮 + 内联额度预览）
 * 3) Cookie 类已配置（Switch on，cookie textarea + 帮助链接）
 * 4) 查询失败（错误提示 + 更新凭证按钮）
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi）。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/settings/coding-plan-section.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref, nextTick } from 'vue'
import CodingPlanSection from '@/components/settings/CodingPlanSection.vue'
import { useQuotaConfigure } from '@/composables/features/useQuotaConfigure'
import type { NormalizedQuotaRow, QuotaPreset, ProviderInfo } from '@xyz-agent/shared'

// ── Mock quota API ──
vi.mock('@/api/domains/quota', () => ({
  fetchQuota: vi.fn(),
  refreshQuota: vi.fn(),
  getCached: vi.fn(),
  configure: vi.fn(),
}))

import * as quotaApi from '@/api/domains/quota'

// ── Fixtures ──

const zhipuPreset: QuotaPreset = {
  fetcher: 'zhipu',
  label: '智谱 GLM Coding Plan',
  auth: 'api-key',
  match: { baseUrlPattern: 'bigmodel.cn', namePattern: 'zhipu|glm|zai' },
  helpUrl: 'https://bigmodel.cn/usercenter/glm-coding/usage',
  helpText: '在 bigmodel.cn 控制台获取',
}

const mimoPreset: QuotaPreset = {
  fetcher: 'mimo',
  label: '小米 MiMo Coding Plan',
  auth: 'cookie',
  match: { baseUrlPattern: 'xiaomimimo.com', namePattern: 'mimo' },
  helpUrl: 'https://platform.xiaomimimo.com/',
  helpText: '登录后从 DevTools 复制 cookie',
}

function makeProvider(overrides: Partial<ProviderInfo> = {}): ProviderInfo {
  return {
    id: 'test-provider',
    name: '智谱 GLM',
    baseUrl: 'https://bigmodel.cn/api',
    apiKeySet: true,
    status: 'connected',
    models: [],
    ...overrides,
  }
}

const mockQuotaRow: NormalizedQuotaRow = {
  label: '智谱 GLM Coding Plan',
  wins: [
    { pct: 68, resetSec: 4980 },
    { pct: 42, resetSec: 298800 },
    { pct: null, resetSec: null },
  ],
}

// ── CodingPlanSection 渲染测试 ──

describe('CodingPlanSection', () => {
  it('状态 1：未启用时显示 Switch off 和帮助文案', () => {
    const wrapper = mount(CodingPlanSection, {
      props: {
        enabled: false,
        cookieInput: '',
        testStatus: 'idle',
        testErrorMsg: '',
        quotaRow: null,
        lastFetchAt: null,
        isCookieAuth: false,
        configuring: false,
        configureErrorMsg: '',
        apiKeySet: true,
        cookieSet: false,
        helpUrl: 'https://bigmodel.cn/usercenter/glm-coding/usage',
        helpText: '在 bigmodel.cn 控制台获取',
      },
    })

    // Section 存在
    expect(wrapper.find('[data-testid="coding-plan-section"]').exists()).toBe(true)
    // Switch off（reka-ui data-state=unchecked）
    const switchEl = wrapper.find('[data-testid="quota-enabled-switch"]')
    expect(switchEl.exists()).toBe(true)
    // 启用额度查询文案
    expect(wrapper.text()).toContain('启用额度查询')
    // 不显示测试按钮（未启用不展示操作按钮）
    expect(wrapper.find('[data-testid="quota-test-btn"]').exists()).toBe(false)
    // 不显示额度结果
    expect(wrapper.find('[data-testid="quota-result"]').exists()).toBe(false)
  })

  it('状态 2：API Key 类已配置 — Switch on + 测试查询按钮 + 额度预览', () => {
    const wrapper = mount(CodingPlanSection, {
      props: {
        enabled: true,
        cookieInput: '',
        testStatus: 'success',
        testErrorMsg: '',
        quotaRow: mockQuotaRow,
        lastFetchAt: Date.now() - 120_000,
        isCookieAuth: false,
        configuring: false,
        configureErrorMsg: '',
        apiKeySet: true,
        cookieSet: false,
      },
    })

    // Switch 存在
    expect(wrapper.find('[data-testid="quota-enabled-switch"]').exists()).toBe(true)
    // API Key 已配置
    expect(wrapper.text()).toContain('API Key 已配置')
    // 测试查询按钮
    expect(wrapper.find('[data-testid="quota-test-btn"]').exists()).toBe(true)
    // 额度预览
    const result = wrapper.find('[data-testid="quota-result"]')
    expect(result.exists()).toBe(true)
    expect(result.text()).toContain('68%')
    expect(result.text()).toContain('42%')
    expect(result.text()).toContain('∞')
    // 查询成功提示
    expect(result.text()).toContain('查询成功')
  })

  it('状态 3：Cookie 类已配置 — Switch on + textarea + 帮助链接', () => {
    const wrapper = mount(CodingPlanSection, {
      props: {
        enabled: true,
        cookieInput: 'sessionid=abc123',
        testStatus: 'success',
        testErrorMsg: '',
        quotaRow: mockQuotaRow,
        lastFetchAt: Date.now(),
        isCookieAuth: true,
        configuring: false,
        configureErrorMsg: '',
        apiKeySet: false,
        cookieSet: true,
        helpUrl: 'https://platform.xiaomimimo.com/',
        helpText: '登录后从 DevTools 复制 cookie',
      },
    })

    // Cookie textarea 存在
    const textarea = wrapper.find('[data-testid="quota-cookie-input"]')
    expect(textarea.exists()).toBe(true)
    // Cookie 已配置标记
    expect(wrapper.text()).toContain('已配置')
    // 帮助链接
    expect(wrapper.find('a[href="https://platform.xiaomimimo.com/"]').exists()).toBe(true)
    // 保存 Cookie 按钮
    expect(wrapper.find('[data-testid="quota-save-cookie-btn"]').exists()).toBe(true)
    // 测试查询按钮（启用态）
    expect(wrapper.find('[data-testid="quota-test-btn"]').exists()).toBe(true)
  })

  it('状态 4：查询失败 — 错误提示 + 更新凭证按钮（cookie 类）', () => {
    const wrapper = mount(CodingPlanSection, {
      props: {
        enabled: true,
        cookieInput: 'session=expired',
        testStatus: 'error',
        testErrorMsg: 'HTTP 302（cookie 过期）',
        quotaRow: null,
        lastFetchAt: null,
        isCookieAuth: true,
        configuring: false,
        configureErrorMsg: '',
        apiKeySet: false,
        cookieSet: true,
        helpUrl: 'https://opencode.ai/',
        helpText: '登录后复制 cookie',
      },
    })

    // 错误提示
    const errorEl = wrapper.find('[data-testid="quota-error"]')
    expect(errorEl.exists()).toBe(true)
    expect(errorEl.text()).toContain('HTTP 302')
    // 更新 Cookie 按钮
    expect(wrapper.find('[data-testid="quota-update-cookie-btn"]').exists()).toBe(true)
    // 不显示额度结果
    expect(wrapper.find('[data-testid="quota-result"]').exists()).toBe(false)
  })

  it('配置错误时显示错误信息', () => {
    const wrapper = mount(CodingPlanSection, {
      props: {
        enabled: false,
        cookieInput: '',
        testStatus: 'idle',
        testErrorMsg: '',
        quotaRow: null,
        lastFetchAt: null,
        isCookieAuth: true,
        configuring: false,
        configureErrorMsg: '请先输入 Cookie',
        apiKeySet: false,
        cookieSet: false,
      },
    })

    expect(wrapper.find('[data-testid="quota-configure-error"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('请先输入 Cookie')
  })

  it('事件转发：toggleEnabled / testQuery / saveCookie', async () => {
    const wrapper = mount(CodingPlanSection, {
      props: {
        enabled: true,
        cookieInput: 'valid-cookie',
        testStatus: 'idle',
        testErrorMsg: '',
        quotaRow: null,
        lastFetchAt: null,
        isCookieAuth: true,
        configuring: false,
        configureErrorMsg: '',
        apiKeySet: false,
        cookieSet: true,
      },
    })

    // 点击测试查询按钮
    const testBtn = wrapper.find('[data-testid="quota-test-btn"]')
    await testBtn.trigger('click')
    expect(wrapper.emitted('testQuery')).toHaveLength(1)

    // 点击保存 Cookie 按钮
    const saveBtn = wrapper.find('[data-testid="quota-save-cookie-btn"]')
    await saveBtn.trigger('click')
    expect(wrapper.emitted('saveCookie')).toHaveLength(1)

    // 切换 Switch
    const switchEl = wrapper.find('[data-testid="quota-enabled-switch"]')
    await switchEl.trigger('click')
    expect(wrapper.emitted('toggleEnabled')).toBeTruthy()
  })

  it('无限额度窗口显示 ∞ 符号', () => {
    const wrapper = mount(CodingPlanSection, {
      props: {
        enabled: true,
        cookieInput: '',
        testStatus: 'success',
        testErrorMsg: '',
        quotaRow: mockQuotaRow,
        lastFetchAt: Date.now(),
        isCookieAuth: false,
        configuring: false,
        configureErrorMsg: '',
        apiKeySet: true,
        cookieSet: false,
      },
    })

    // 第三个窗口（pct=null）显示 ∞
    const result = wrapper.find('[data-testid="quota-result"]')
    expect(result.text()).toContain('∞')
  })
})

// ── useQuotaConfigure composable 测试 ──

describe('useQuotaConfigure', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('provider 有 quota 配置时同步初始状态', async () => {
    const provider = ref<ProviderInfo | null>(makeProvider({
      quota: { fetcher: 'zhipu', enabled: true, cookieSet: false },
    }))
    const preset = ref<QuotaPreset | undefined>(zhipuPreset)

    vi.mocked(quotaApi.getCached).mockResolvedValue({
      data: mockQuotaRow,
      lastFetchAt: Date.now(),
    })

    const quota = useQuotaConfigure(preset, provider)
    await nextTick()

    expect(quota.enabled.value).toBe(true)
    expect(quota.testStatus.value).toBe('success')
    expect(quota.quotaData.value).toEqual(mockQuotaRow)
  })

  it('provider 无 quota 配置时默认关闭', () => {
    const provider = ref<ProviderInfo | null>(makeProvider())
    const preset = ref<QuotaPreset | undefined>(zhipuPreset)

    const quota = useQuotaConfigure(preset, provider)
    expect(quota.enabled.value).toBe(false)
    expect(quota.testStatus.value).toBe('idle')
  })

  it('toggleEnabled 调用 configure RPC', async () => {
    const provider = ref<ProviderInfo | null>(makeProvider())
    const preset = ref<QuotaPreset | undefined>(zhipuPreset)

    vi.mocked(quotaApi.configure).mockResolvedValue({ ok: true })
    vi.mocked(quotaApi.refreshQuota).mockResolvedValue({
      data: mockQuotaRow,
      lastFetchAt: Date.now(),
    })

    const quota = useQuotaConfigure(preset, provider)
    await quota.toggleEnabled()

    expect(quotaApi.configure).toHaveBeenCalledWith('test-provider', true)
    expect(quota.enabled.value).toBe(true)
    // 开启后自动触发 testQuery（经 refreshQuota，绕过 throttle）
    expect(quotaApi.refreshQuota).toHaveBeenCalledWith('test-provider')
  })

  it('toggleEnabled 失败时保留原状态', async () => {
    const provider = ref<ProviderInfo | null>(makeProvider())
    const preset = ref<QuotaPreset | undefined>(zhipuPreset)

    vi.mocked(quotaApi.configure).mockResolvedValue({ ok: false, error: '保存失败' })

    const quota = useQuotaConfigure(preset, provider)
    await quota.toggleEnabled()

    expect(quota.enabled.value).toBe(false)
    expect(quota.configureError.value).toBe('保存失败')
  })

  it('cookie 类 provider 未输入 cookie 时拒绝启用', async () => {
    const provider = ref<ProviderInfo | null>(makeProvider({ baseUrl: 'https://xiaomimimo.com' }))
    const preset = ref<QuotaPreset | undefined>(mimoPreset)

    const quota = useQuotaConfigure(preset, provider)
    await quota.toggleEnabled()

    expect(quota.enabled.value).toBe(false)
    expect(quota.configureError.value).toBe('请先输入 Cookie')
  })

  it('saveCookie 调用 configure 带 cookie 参数', async () => {
    const provider = ref<ProviderInfo | null>(makeProvider({ baseUrl: 'https://xiaomimimo.com' }))
    const preset = ref<QuotaPreset | undefined>(mimoPreset)

    vi.mocked(quotaApi.configure).mockResolvedValue({ ok: true })
    vi.mocked(quotaApi.refreshQuota).mockResolvedValue({
      data: mockQuotaRow,
      lastFetchAt: Date.now(),
    })

    const quota = useQuotaConfigure(preset, provider)
    quota.cookieInput.value = 'sessionid=abc123'
    await quota.saveCookie()

    expect(quotaApi.configure).toHaveBeenCalledWith('test-provider', true, 'sessionid=abc123')
    expect(quota.enabled.value).toBe(true)
  })

  it('testQuery 成功更新 quotaData（经 refreshQuota 绕过 throttle）', async () => {
    const provider = ref<ProviderInfo | null>(makeProvider())
    const preset = ref<QuotaPreset | undefined>(zhipuPreset)

    vi.mocked(quotaApi.refreshQuota).mockResolvedValue({
      data: mockQuotaRow,
      lastFetchAt: Date.now(),
    })

    const quota = useQuotaConfigure(preset, provider)
    await quota.testQuery()

    expect(quota.testStatus.value).toBe('success')
    expect(quota.quotaData.value).toEqual(mockQuotaRow)
    expect(quotaApi.refreshQuota).toHaveBeenCalledWith('test-provider')
  })

  it('testQuery 失败设置 error 状态', async () => {
    const provider = ref<ProviderInfo | null>(makeProvider())
    const preset = ref<QuotaPreset | undefined>(zhipuPreset)

    vi.mocked(quotaApi.refreshQuota).mockResolvedValue({ data: null, lastFetchAt: null })

    const quota = useQuotaConfigure(preset, provider)
    await quota.testQuery()

    expect(quota.testStatus.value).toBe('error')
    expect(quota.testError.value).toBeTruthy()
  })

  it('isCookieAuth 根据 preset.auth 计算', () => {
    const provider = ref<ProviderInfo | null>(makeProvider())
    const presetApiKey = ref<QuotaPreset | undefined>(zhipuPreset)
    const presetCookie = ref<QuotaPreset | undefined>(mimoPreset)

    const q1 = useQuotaConfigure(presetApiKey, provider)
    expect(q1.isCookieAuth.value).toBe(false)

    const q2 = useQuotaConfigure(presetCookie, provider)
    expect(q2.isCookieAuth.value).toBe(true)
  })
})
