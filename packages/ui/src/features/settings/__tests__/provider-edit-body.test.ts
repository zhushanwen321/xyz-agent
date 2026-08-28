/**
 * ProviderEditBody 组件级单测（ui 包 · PR #187 Gate-1.6 增量覆盖）。
 *
 * 覆盖验收标准（B-1 凭证区条件化 + B-2 模型区混合列表 + save payload）：
 * ① oauth 型 catalog provider：已登录状态区（relogin / logout 按钮、logout 点击上抛），
 *    隐藏 API key 输入；未登录态渲染登录入口
 * ② api_key 型：渲染 API key 输入，不渲染 OAuth 状态区
 * ③ 形态切换确认弹窗：oauth→api_key 与 api_key→oauth 双向（确认执行切换、取消不动凭证）；
 *    oauth→api_key 空 key 保存被守卫阻断
 * ④ 混合模型列表（catalog）：builtin 条目只读 + Built-in 徽章；override 条目可编辑/可删 +
 *    Custom 徽章；手动添加入口开放
 * ⑤ save payload：models 只含 override 条目（builtin id 不回传）+ authMethod 字段
 * ⑥ 添加模型表单 reasoning 思考开关（D4「GLM 思考等级被钳 off」事故修复面）：
 *    aria-label 可定位 + aria-checked 随点击翻转 + 翻转结果透传进 save payload
 *
 * 与 renderer 端 provider-edit-body-phase-b.test.ts 的差异（mock 层全部换 injection stub）：
 *  - USE_QUOTA_CONFIGURE_KEY provide 最小 stub 工厂（对齐 injection-keys.ts 的
 *    QuotaConfigureState 契约逐字段），零 renderer import（ui 包铁律）
 *  - SETTINGS_TOAST_KEY provide vi.fn stub（save 成功 toast 断言）
 *  - provideSettingsTransport / providePlatform（@xyz-agent/core 模块级单例注入，
 *    useProviderEdit 的 setProvider/discoverModels 经 transport spy 断言）
 *  - vue-i18n 经 vitest.setup mock（t() 返回 key）→ 全部文案断言用 i18n key / data-testid
 *
 * 测试模式：Dialog teleport 到 body，mount attachTo: document.body 后用
 * document.body.querySelector 查询（对齐 OAuthDialog.test.ts 模式）。
 * ModelListSection 不 stub（真实渲染）：B-2 徽章行 + 混合列表联动由本测试连带覆盖。
 *
 * 运行：cd packages/ui && npx vitest run src/features/settings/__tests__/provider-edit-body.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import type { Ref } from 'vue'
import type {
  ProviderInfo,
  ProviderId,
  SetProviderData,
  QuotaPreset,
  QuotaAuthKind,
  QuotaFetchFailureReason,
  NormalizedQuotaRow,
} from '@xyz-agent/shared'
import {
  providePlatform,
  provideSettingsTransport,
  __resetPlatformForTesting,
  __resetSettingsStoreForTesting,
  __resetSettingsTransportForTesting,
  type SettingsTransport,
} from '@xyz-agent/core'
import ProviderEditBody from '../provider/ProviderEditBody.vue'
import {
  SETTINGS_TOAST_KEY,
  USE_QUOTA_CONFIGURE_KEY,
  type SettingsToast,
  type QuotaConfigureState,
  type QuotaTestStatus,
} from '../injection-keys'

// ── fixture ──

/** oauth 型 catalog provider（凭证区显示 OAuth 状态；混合列表 builtin×2 + override×1） */
const OAUTH_P: ProviderInfo = {
  id: 'kimi-coding' as ProviderId,
  name: 'Kimi Coding',
  api: 'openai-completions',
  apiKeySet: true,
  authMethod: 'oauth',
  status: 'connected',
  kind: 'catalog',
  models: [
    { id: 'kimi-k2', name: 'Kimi K2', source: 'builtin' },
    { id: 'kimi-k2-thinking', name: 'Kimi K2 Thinking', source: 'builtin' },
    { id: 'my-kimi-alias', name: 'My Kimi Alias', source: 'override' },
  ],
}

/** api_key 型 catalog provider（凭证区维持 API Key 输入；builtin×1 + override×1） */
const APIKEY_P: ProviderInfo = {
  id: 'zai-coding-cn' as ProviderId,
  name: 'Z.AI Coding CN',
  api: 'openai-completions',
  apiKeySet: true,
  authMethod: 'api_key',
  status: 'connected',
  kind: 'catalog',
  models: [
    { id: 'glm-5.3', name: 'GLM 5.3', source: 'builtin' },
    { id: 'my-glm-alias', name: 'My GLM Alias', source: 'override' },
  ],
}

/** custom provider（非 catalog：模型区走单一可编辑列表，无 builtin 只读区） */
const CUSTOM_P: ProviderInfo = {
  id: 'my-openai' as ProviderId,
  name: 'My OpenAI',
  api: 'openai-completions',
  apiKeySet: false,
  status: 'connected',
  kind: 'custom',
  models: [{ id: 'gpt-4o', name: 'GPT-4o' }],
}

// ── injection stub（零 renderer import：契约对齐 injection-keys.ts）──

/** QuotaConfigureState 最小 stub：字段逐一对齐接口（ProviderEditBody 解构后全量透传给 CodingPlanSection） */
function makeQuotaState(): QuotaConfigureState {
  return {
    fetcherId: ref<string | undefined>(undefined),
    fetcherOptions: [],
    enabled: ref(false),
    cookieInput: ref(''),
    apiKeyInput: ref(''),
    apiKeyConfigured: ref(false),
    testStatus: ref<QuotaTestStatus>('idle'),
    testError: ref(''),
    quotaData: ref<NormalizedQuotaRow | null>(null),
    lastFetchAt: ref<number | null>(null),
    isCookieAuth: ref(false),
    authKinds: ref<readonly QuotaAuthKind[]>([]),
    testFailReason: ref<QuotaFetchFailureReason | null>(null),
    helpUrl: ref<string | undefined>(undefined),
    helpText: ref<string | undefined>(undefined),
    configuring: ref(false),
    configureError: ref(''),
    toggleEnabled: async () => {},
    selectFetcher: async () => {},
    saveCookie: async () => {},
    saveApiKey: async () => {},
    testQuery: async () => {},
    reset: () => {},
  }
}

/** USE_QUOTA_CONFIGURE_KEY stub 工厂（vi.fn 包装供「注入被真实消费」断言） */
const quotaFactoryStub = vi.fn((_preset: Ref<QuotaPreset | undefined>, _providerRef: Ref<ProviderInfo | null>) => makeQuotaState())

const toastInfoSpy = vi.fn()
const toastStub: SettingsToast = {
  error: vi.fn(),
  info: toastInfoSpy,
  warning: vi.fn(),
}

// ── transport / platform stub（core 模块级单例注入）──

const setProviderSpy = vi.fn(async (_id: string, _data: SetProviderData) => undefined)
const discoverModelsSpy = vi.fn(async () => ({ success: true, models: [] }))

function makeTransport(): SettingsTransport {
  const noop = (): void => {}
  return {
    listProviders: vi.fn(async () => ({ providers: [] })),
    listModels: vi.fn(async () => []),
    setScopedModels: vi.fn(async () => [] as string[]),
    setProvider: setProviderSpy,
    discoverModels: discoverModelsSpy,
    setSkillDirs: vi.fn(async () => undefined),
    setAgentDirs: vi.fn(async () => undefined),
    setExtensionDirs: vi.fn(async () => undefined),
    onProviders: () => noop,
    onModels: () => noop,
    onSkills: () => noop,
    onAgents: () => noop,
    onExtensions: () => noop,
    onSkillDirs: () => noop,
    onAgentDirs: () => noop,
    onExtensionDirs: () => noop,
    onDefaults: () => noop,
    onSystemPrompt: () => noop,
    onTerminalConfig: () => noop,
  }
}

function inMemoryStorage() {
  const map = new Map<string, string>()
  return {
    get: async (k: string) => map.get(k) ?? null,
    set: async (k: string, v: string) => { map.set(k, v) },
    remove: async (k: string) => { map.delete(k) },
  }
}

let wrapper: VueWrapper | null = null

beforeEach(() => {
  __resetPlatformForTesting()
  __resetSettingsStoreForTesting()
  __resetSettingsTransportForTesting()
  providePlatform({
    kind: 'mock',
    storage: inMemoryStorage(),
    webSocket: { create: () => ({ readyState: 0, send: () => {}, close: () => {}, onopen: null, onclose: null, onmessage: null, onerror: null }) },
    ipc: null,
  })
  provideSettingsTransport(makeTransport())
  setProviderSpy.mockClear()
  discoverModelsSpy.mockClear()
  quotaFactoryStub.mockClear()
  toastInfoSpy.mockClear()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

/** mount ProviderEditBody（provide injection stub；attachTo 供 Dialog teleport 查询） */
function mountBody(provider: ProviderInfo, props: Record<string, unknown> = {}): VueWrapper {
  return mount(ProviderEditBody, {
    props: { provider, oauthPresent: false, oauthSupported: true, ...props },
    attachTo: document.body,
    global: {
      provide: {
        [SETTINGS_TOAST_KEY]: toastStub,
        [USE_QUOTA_CONFIGURE_KEY]: quotaFactoryStub,
      },
    },
  })
}

/** body 内元素点击（portal Dialog 内容触发 Vue @click） */
function clickBody(selector: string): void {
  const el = document.body.querySelector<HTMLElement>(selector)
  if (!el) throw new Error(`body 元素未找到: ${selector}`)
  el.click()
}

/** save payload（setProvider 第 2 参；spy 参数已类型化，无需断言收窄） */
function savePayload(index = 0): SetProviderData {
  expect(setProviderSpy.mock.calls.length).toBeGreaterThan(index)
  return setProviderSpy.mock.calls[index]![1]
}

// ══ 场景 ①：oauth 型凭证区 ═════════════════════════════════════════════════

describe('凭证区条件化：oauth 型 provider', () => {
  it('已登录态：渲染 OAuth 状态区（已登录 + relogin / logout 按钮），隐藏 API key 输入；quota 工厂经注入消费', async () => {
    wrapper = mountBody(OAUTH_P, { oauthPresent: true })
    await flushPromises()

    expect(wrapper.find('[data-testid="provider-credential-oauth"]').exists()).toBe(true)
    const status = wrapper.find('[data-testid="oauth-status-loggedin"]')
    expect(status.exists()).toBe(true)
    // t() 返回 key（vitest.setup mock）→ 断言 i18n key 而非中文文案
    expect(status.text()).toContain('settings.providerEdit.credentialOauthLoggedIn')
    const relogin = wrapper.find('[data-testid="oauth-relogin-btn"]')
    expect(relogin.exists()).toBe(true)
    expect(relogin.text().trim()).toBe('settings.providerEdit.credentialOauthRelogin')
    expect(wrapper.find('[data-testid="oauth-logout-btn"]').exists()).toBe(true)
    // oauth 形态不渲染 apiKey 输入
    expect(wrapper.find('[data-testid="provider-edit-apikey"]').exists()).toBe(false)
    // USE_QUOTA_CONFIGURE_KEY 注入被真实消费（非 noop fallback）
    expect(quotaFactoryStub).toHaveBeenCalledTimes(1)
  })

  it('logout 按钮可点击（B-1 场景 C：config.oauthLogout RPC 已落地）→ 上抛 oauth-logout', async () => {
    wrapper = mountBody(OAUTH_P, { oauthPresent: true })
    await flushPromises()

    const logout = wrapper.find<HTMLButtonElement>('[data-testid="oauth-logout-btn"]')
    expect(logout.exists()).toBe(true)
    expect(logout.element.disabled).toBe(false)
    expect(logout.text().trim()).toBe('settings.providerEdit.credentialOauthLogout')

    await logout.trigger('click')
    expect(wrapper.emitted('oauthLogout')).toBeTruthy()
    expect(wrapper.emitted('oauthLogout')!.length).toBe(1)
  })

  it('未登录态（authMethod=oauth 但无凭据）：显示未登录状态 + 登录按钮（非 relogin）', async () => {
    wrapper = mountBody(OAUTH_P, { oauthPresent: false })
    await flushPromises()

    const status = wrapper.find('[data-testid="oauth-status-not-loggedin"]')
    expect(status.exists()).toBe(true)
    expect(status.text()).toContain('settings.providerEdit.credentialOauthNotLoggedIn')
    const loginBtn = wrapper.find('[data-testid="oauth-relogin-btn"]')
    expect(loginBtn.exists()).toBe(true)
    expect(loginBtn.text().trim()).toBe('settings.providerEdit.credentialOauthLogin')
  })

  it('点 relogin 按钮 → 上抛 oauth-login（OAuth 状态机在父组件，ui 零 renderer import）', async () => {
    wrapper = mountBody(OAUTH_P, { oauthPresent: true })
    await flushPromises()

    await wrapper.find('[data-testid="oauth-relogin-btn"]').trigger('click')
    expect(wrapper.emitted('oauthLogin')).toBeTruthy()
    expect(wrapper.emitted('oauthLogin')!.length).toBe(1)
  })
})

// ══ 场景 ②：api_key 型凭证区 ═══════════════════════════════════════════════

describe('凭证区条件化：api_key 型 provider', () => {
  it('渲染 API key 输入 + 「改用 OAuth」入口，不渲染 OAuth 状态区', async () => {
    wrapper = mountBody(APIKEY_P)
    await flushPromises()

    expect(wrapper.find('[data-testid="provider-credential-apikey"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="provider-edit-apikey"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="auth-switch-to-oauth"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="provider-credential-oauth"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="oauth-status-loggedin"]').exists()).toBe(false)
  })

  it('oauth 能力未知（oauthSupported=false）→ 不渲染「改用 OAuth」入口', async () => {
    wrapper = mountBody(APIKEY_P, { oauthSupported: false })
    await flushPromises()

    expect(wrapper.find('[data-testid="auth-switch-to-oauth"]').exists()).toBe(false)
  })
})

// ══ 场景 ③：形态切换确认弹窗（I9 双凭据互斥）═══════════════════════════════

describe('形态切换：双向确认弹窗', () => {
  it('oauth→api_key：点「改用 API Key」→ 确认弹窗出现；取消 → 弹窗关闭且凭证区不变（取消不动凭证）', async () => {
    wrapper = mountBody(OAUTH_P, { oauthPresent: true })
    await flushPromises()

    await wrapper.find('[data-testid="auth-switch-to-apikey"]').trigger('click')
    await flushPromises()
    const dialog = document.body.querySelector('[data-testid="auth-switch-confirm-dialog"]')
    expect(dialog).toBeTruthy()
    // t() 返回 key → 弹窗标题/描述断言 i18n key
    expect(dialog!.textContent).toContain('settings.providerEdit.switchToApiKeyConfirmTitle')
    expect(dialog!.textContent).toContain('settings.providerEdit.switchToApiKeyConfirmDesc')

    clickBody('[data-testid="auth-switch-cancel-btn"]')
    await flushPromises()
    expect(document.body.querySelector('[data-testid="auth-switch-confirm-dialog"]')).toBeNull()
    // 取消不动凭证：仍 oauth 态（已登录 + 无 apiKey 输入），未触发保存
    expect(wrapper.find('[data-testid="oauth-status-loggedin"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="provider-edit-apikey"]').exists()).toBe(false)
    expect(setProviderSpy).not.toHaveBeenCalled()
  })

  it('确认 oauth→api_key：apiKey 输入 + save-bar 出现；空 key 保存被守卫阻断；填 key 保存 → payload authMethod=api_key + apiKey 覆写', async () => {
    wrapper = mountBody(OAUTH_P, { oauthPresent: true })
    await flushPromises()

    await wrapper.find('[data-testid="auth-switch-to-apikey"]').trigger('click')
    await flushPromises()
    clickBody('[data-testid="auth-switch-confirm-btn"]')
    await flushPromises()

    // 切换后：apiKey 输入出现 + dirty（save-bar）
    expect(wrapper.find('[data-testid="provider-edit-apikey"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="provider-save-bar"]').exists()).toBe(true)

    // 空 key 保存 → 守卫拦截（确认弹窗承诺退出 OAuth，空 key 会残留 OAuth 凭证）
    await wrapper.find('[data-testid="provider-save-btn"]').trigger('click')
    await flushPromises()
    expect(setProviderSpy).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="provider-save-bar"]').text()).toContain('composable.oauthSwitchNeedsKey')

    // 填 key 保存 → payload 正确 + toast 反馈 + 上抛 saved
    await wrapper.find('[data-testid="provider-edit-apikey"]').setValue('sk-new-key')
    await wrapper.find('[data-testid="provider-save-btn"]').trigger('click')
    await flushPromises()
    expect(setProviderSpy).toHaveBeenCalledTimes(1)
    const payload = savePayload()
    expect(payload.authMethod).toBe('api_key')
    expect(payload.apiKey).toBe('sk-new-key')
    expect(toastInfoSpy).toHaveBeenCalledWith('settings.saved')
    expect(wrapper.emitted('saved')).toBeTruthy()
  })

  it('api_key→oauth：确认后上抛 oauth-login，本地凭证形态不变（flow 由父完成后持久化回推）', async () => {
    wrapper = mountBody(APIKEY_P)
    await flushPromises()

    await wrapper.find('[data-testid="auth-switch-to-oauth"]').trigger('click')
    await flushPromises()
    const dialog = document.body.querySelector('[data-testid="auth-switch-confirm-dialog"]')
    expect(dialog).toBeTruthy()
    expect(dialog!.textContent).toContain('settings.providerEdit.switchToOauthConfirmTitle')
    expect(dialog!.textContent).toContain('settings.providerEdit.switchToOauthConfirmDesc')
    clickBody('[data-testid="auth-switch-confirm-btn"]')
    await flushPromises()

    expect(wrapper.emitted('oauthLogin')).toBeTruthy()
    // 本地凭证形态未变（仍 apiKey 输入），且未触发保存
    expect(wrapper.find('[data-testid="provider-edit-apikey"]').exists()).toBe(true)
    expect(setProviderSpy).not.toHaveBeenCalled()
  })
})

// ══ 场景 ④：混合模型列表（catalog）═════════════════════════════════════════

describe('混合模型列表：builtin 只读 + override 可编辑', () => {
  it('builtin 条目只读渲染（Built-in 徽章、无删除按钮）与 override 条目（Custom 徽章、可删）同时显示', async () => {
    wrapper = mountBody(APIKEY_P)
    await flushPromises()

    expect(wrapper.find('[data-testid="provider-models-mixed"]').exists()).toBe(true)
    // builtin 只读区：1 条（glm-5.3）+ 徽章 key 断言（t() 返回 key）
    const builtinSection = wrapper.find('[data-testid="provider-models-builtin"]')
    expect(builtinSection.exists()).toBe(true)
    const builtinRows = builtinSection.findAll('[data-testid="builtin-model-row"]')
    expect(builtinRows.length).toBe(1)
    expect(builtinRows[0].text()).toContain('glm-5.3')
    const builtinBadge = builtinSection.find('[data-testid="model-badge-builtin"]')
    expect(builtinBadge.exists()).toBe(true)
    expect(builtinBadge.text().trim()).toBe('settings.providerEdit.modelSourceBuiltin')

    // 编辑区（ModelListSection 真实渲染）：仅 override 条目 + Custom 徽章 + 可删
    const customBadges = wrapper.findAll('[data-testid="model-badge-custom"]')
    expect(customBadges.length).toBe(1)
    expect(customBadges[0].text().trim()).toBe('settings.providerEdit.modelSourceOverride')
    const removeButtons = wrapper.findAll('button[aria-label="settings.providerEdit.removeModel"]')
    expect(removeButtons.length).toBe(1)
    // 手动添加入口开放
    const addToggle = wrapper.findAll('button').find((b) => b.text().includes('settings.providerEdit.manualAdd'))
    expect(addToggle).toBeTruthy()
  })

  it('oauth 型 catalog：builtin×2 只读展示 + override×1 在编辑区（OAUTH_P fixture 冒烟）', async () => {
    wrapper = mountBody(OAUTH_P, { oauthPresent: true })
    await flushPromises()

    const builtinSection = wrapper.find('[data-testid="provider-models-builtin"]')
    expect(builtinSection.findAll('[data-testid="builtin-model-row"]').length).toBe(2)
    expect(builtinSection.findAll('[data-testid="model-badge-builtin"]').length).toBe(2)
    // 编辑区只含 override 条目（my-kimi-alias）
    expect(wrapper.findAll('[data-testid="model-badge-custom"]').length).toBe(1)
    expect(wrapper.text()).toContain('my-kimi-alias')
    // builtin id 不出现在编辑区删除按钮旁的行（编辑区 1 行 = my-kimi-alias）
    const removeButtons = wrapper.findAll('button[aria-label="settings.providerEdit.removeModel"]')
    expect(removeButtons.length).toBe(1)
  })

  it('custom provider（非 catalog）：单一可编辑模型列表，无 builtin 只读区', async () => {
    wrapper = mountBody(CUSTOM_P)
    await flushPromises()

    // v-else 分支：provider-models-editable + 全量条目可编辑（无 builtin 只读区/徽章）
    expect(wrapper.find('[data-testid="provider-models-editable"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="provider-models-mixed"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="provider-models-builtin"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="model-badge-builtin"]').exists()).toBe(false)
    const removeButtons = wrapper.findAll('button[aria-label="settings.providerEdit.removeModel"]')
    expect(removeButtons.length).toBe(1)
    expect(wrapper.text()).toContain('gpt-4o')
  })

  it('空名添加模型 → 守卫错误显示在 save-bar（addModel 抛错非静默）', async () => {
    wrapper = mountBody(APIKEY_P)
    await flushPromises()

    // actionError 显示位在 save-bar 内（v-if="isDirty"），先改名称制造 dirty
    await wrapper.find('[data-testid="provider-edit-name"]').setValue('Renamed')
    await flushPromises()
    expect(wrapper.find('[data-testid="provider-save-bar"]').exists()).toBe(true)

    // 打开手动添加表单 + 直接点添加（空名）
    const addToggle = wrapper.findAll('button').find((b) => b.text().includes('settings.providerEdit.manualAdd'))
    expect(addToggle).toBeTruthy()
    await addToggle!.trigger('click')
    await flushPromises()
    const addBtn = wrapper.findAll('button').find((b) => b.text().trim() === 'settings.providerEdit.addBtn')
    expect(addBtn).toBeTruthy()
    await addBtn!.trigger('click')
    await flushPromises()

    // 错误显示在 save-bar（用户可见反馈，非静默吞）；编辑区行数不变（空名未入库）
    expect(wrapper.find('[data-testid="provider-save-bar"]').text()).toContain('composable.modelNameRequired')
    expect(wrapper.findAll('button[aria-label="settings.providerEdit.removeModel"]').length).toBe(1)
  })
})

// ══ 场景 ⑤：save payload（transport spy）═══════════════════════════════════

describe('save payload：models 只含 override + authMethod 字段', () => {
  it('添加自定义模型后保存 → models 含 override + 新条目、不含 builtin（builtin 不回传）；authMethod=api_key', async () => {
    wrapper = mountBody(APIKEY_P)
    await flushPromises()

    // 打开手动添加表单 + 填名（placeholder = i18n key，t() mock 返回 key）+ 添加
    const addToggle = wrapper.findAll('button').find((b) => b.text().includes('settings.providerEdit.manualAdd'))
    await addToggle!.trigger('click')
    await flushPromises()
    const nameInput = wrapper.find('input[placeholder="settings.providerEdit.modelNamePlaceholder"]')
    expect(nameInput.exists()).toBe(true)
    await nameInput.setValue('glm-5.4-preview')
    const addBtn = wrapper.findAll('button').find((b) => b.text().trim() === 'settings.providerEdit.addBtn')
    await addBtn!.trigger('click')
    await flushPromises()

    // dirty → save-bar → 保存
    expect(wrapper.find('[data-testid="provider-save-bar"]').exists()).toBe(true)
    await wrapper.find('[data-testid="provider-save-btn"]').trigger('click')
    await flushPromises()

    const models = savePayload().models as Array<{ id: string }>
    const ids = models.map((m) => m.id)
    expect(ids).toContain('my-glm-alias') // 既有 override
    expect(ids).toContain('glm-5.4-preview') // 新增
    expect(ids).not.toContain('glm-5.3') // builtin 不回传
    expect(savePayload().authMethod).toBe('api_key')
    expect(toastInfoSpy).toHaveBeenCalledWith('settings.saved')
    expect(wrapper.emitted('saved')).toBeTruthy()
  })

  it('删除唯一 override 条目后保存 → payload models 为空数组（builtin 仍不回传）', async () => {
    wrapper = mountBody(APIKEY_P)
    await flushPromises()

    const removeButtons = wrapper.findAll('button[aria-label="settings.providerEdit.removeModel"]')
    expect(removeButtons.length).toBe(1)
    await removeButtons[0].trigger('click')
    await flushPromises()

    await wrapper.find('[data-testid="provider-save-btn"]').trigger('click')
    await flushPromises()

    const models = savePayload().models as Array<{ id: string }>
    expect(models.map((m) => m.id)).toEqual([])
  })
})

// ══ 附加：dirty 上抛 + 测试连接（编排链路）══════════════════════════════════

describe('编排链路：dirty 上抛与测试连接', () => {
  it('dirty 状态上抛父组件：mount 即 emit(false)，编辑名称后 emit(true) + save-bar 出现', async () => {
    wrapper = mountBody(APIKEY_P)
    await flushPromises()

    const emitted = wrapper.emitted('dirtyChange')
    expect(emitted).toBeTruthy()
    expect(emitted![0]).toEqual([false])

    await wrapper.find('[data-testid="provider-edit-name"]').setValue('Renamed Provider')
    await flushPromises()

    expect(wrapper.emitted('dirtyChange')!.at(-1)).toEqual([true])
    expect(wrapper.find('[data-testid="provider-save-bar"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="provider-save-bar"]').text()).toContain('settings.provider.unsavedBadge')

    // 取消按钮上抛 @cancel（父组件收起展开行）
    await wrapper.find('[data-testid="provider-cancel-btn"]').trigger('click')
    expect(wrapper.emitted('cancel')).toBeTruthy()
  })

  it('测试连接：经 transport.discoverModels 探活，成功态渲染（用户可见反馈）', async () => {
    wrapper = mountBody(APIKEY_P)
    await flushPromises()

    // 两个 secondary 按钮（测试连接 / 自动发现）取第一个
    const testBtn = wrapper.findAll('button').find((b) => b.text().includes('settings.providerEdit.testConnection'))
    expect(testBtn).toBeTruthy()
    await testBtn!.trigger('click')
    await flushPromises()

    expect(discoverModelsSpy).toHaveBeenCalledTimes(1)
    // 成功态用户可见（t(key, {count}) mock 会 append 命名参数值）
    expect(wrapper.text()).toContain('settings.providerEdit.testOk')
  })
})

// ══ 场景 ⑥：添加模型表单 reasoning 思考开关（D4 事故修复面）══════════════════

/**
 * ModelListSection 真实渲染（非 stub）中的 reasoning Switch（reka SwitchRoot →
 * button[role="switch"]）。三视角说明：
 * - 黑盒用户视角（主）：aria-label 可定位（AT accessible name）、aria-checked /
 *   data-state 随点击翻转（用户可见形态）、翻转结果经 addModel 落进 save payload
 *   （用户最终持久化数据，证明开关真实生效而非装饰）。
 * - 构建者白盒（佐证）：aria-checked 是 :model-value="deps.newModel.reasoning" 受控
 *   回流的渲染结果，断言它即等价断言 newModel.reasoning 翻转，未窥组件私有状态。
 * - 观察者形态：switch 的存在与状态变化全部经由 DOM 属性断言，无组件内部 spy。
 */
describe('添加模型表单：reasoning 思考开关（D4）', () => {
  /** i18n mock t() 返回 key 本身 → aria-label 即 key（switch 唯一，可全局定位） */
  const SW_SELECTOR = 'button[role="switch"][aria-label="settings.providerEdit.reasoningLabel"]'

  async function openAddForm(): Promise<void> {
    const addToggle = wrapper!.findAll('button').find((b) => b.text().includes('settings.providerEdit.manualAdd'))
    expect(addToggle).toBeTruthy()
    await addToggle!.trigger('click')
    await flushPromises()
  }

  it('表单渲染 reasoning 开关（accessible name 定位），点击后 aria-checked 翻转且可逆向', async () => {
    wrapper = mountBody(APIKEY_P)
    await flushPromises()
    await openAddForm()

    // (a) 用户可见：开关渲染，出厂显式 boolean（newModel.reasoning 初始 true）
    const sw = wrapper.find(SW_SELECTOR)
    expect(sw.exists()).toBe(true)
    expect(sw.attributes('aria-checked')).toBe('true')
    expect(sw.attributes('data-state')).toBe('checked')

    // (b) 点击翻转：aria-checked 变 false（DOM 可见形态，非仅内部状态）
    await sw.trigger('click')
    await flushPromises()
    expect(wrapper.find(SW_SELECTOR).attributes('aria-checked')).toBe('false')
    expect(wrapper.find(SW_SELECTOR).attributes('data-state')).toBe('unchecked')

    // 逆向再点击翻回 true（用户可显式关/开）
    await wrapper.find(SW_SELECTOR).trigger('click')
    await flushPromises()
    expect(wrapper.find(SW_SELECTOR).attributes('aria-checked')).toBe('true')
  })

  it('关掉 reasoning 后添加模型并保存 → payload 新条目 reasoning=false（开关真实生效）', async () => {
    wrapper = mountBody(APIKEY_P)
    await flushPromises()
    await openAddForm()

    // 关掉开关（出厂 true → false）
    const sw = wrapper.find(SW_SELECTOR)
    expect(sw.attributes('aria-checked')).toBe('true')
    await sw.trigger('click')
    await flushPromises()
    expect(wrapper.find(SW_SELECTOR).attributes('aria-checked')).toBe('false')

    // 填名 + 添加 + 保存（payload 链路对齐场景 ⑤ 既有模式）
    await wrapper.find('input[placeholder="settings.providerEdit.modelNamePlaceholder"]').setValue('glm-5.4-preview')
    const addBtn = wrapper.findAll('button').find((b) => b.text().trim() === 'settings.providerEdit.addBtn')
    await addBtn!.trigger('click')
    await flushPromises()
    await wrapper.find('[data-testid="provider-save-btn"]').trigger('click')
    await flushPromises()

    // D4 契约：reasoning 显式 boolean 落盘（false 不被吞）——缺失会让 pi 把思考档钳回 off
    const models = savePayload().models as Array<{ id: string; reasoning?: boolean }>
    const added = models.find((m) => m.id === 'glm-5.4-preview')
    expect(added).toBeTruthy()
    expect(added!.reasoning).toBe(false)
  })
})
