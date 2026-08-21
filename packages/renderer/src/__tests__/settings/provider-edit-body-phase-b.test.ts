/**
 * ProviderEditBody Phase B 测试（B-1 凭证区条件化 + B-2 模型区混合列表）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/beforeEach/afterEach/vi，禁 node:test）。
 * 运行命令：cd packages/renderer && npx vitest run src/__tests__/settings/provider-edit-body-phase-b.test.ts
 *
 * 三视角：
 *  - 观察者（首屏冒烟）：oauth / api_key 型 provider 凭证区形态、混合列表徽章渲染 gate
 *  - 使用者（黑盒）：形态切换确认弹窗（确认/取消路径）、添加/删除模型 → save payload
 *  - 构建者（白盒）：save payload 断言（authMethod/models 只含 override）经 transport spy
 *
 * mock 策略：
 *  - vue-i18n 全局 mock（vitest-i18n-setup.ts，t() 从 zh-CN 取值）
 *  - provideSettingsTransport 注入 spy transport（save 路径断言）
 *  - USE_QUOTA_CONFIGURE_KEY provide 真实 useQuotaConfigure（'@/api/domains/quota' mock）
 *  - Dialog（形态切换确认）teleport 到 body：attachTo + document.body 查询（对齐 provider-builtin-ui 模式）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ProviderInfo, SetProviderData } from '@xyz-agent/shared'
import {
  providePlatform,
  provideSettingsTransport,
  __resetPlatformForTesting,
  __resetSettingsStoreForTesting,
  __resetSettingsTransportForTesting,
  type SettingsTransport,
} from '@xyz-agent/core'
import {
  ProviderEditBody,
  SETTINGS_TOAST_KEY,
  USE_QUOTA_CONFIGURE_KEY,
} from '@xyz-agent/ui/features/settings'
import { useQuotaConfigure } from '@/composables/features/model/useQuotaConfigure'
import { useToast } from '@/composables/useToast'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// useQuotaConfigure 直连 quota domain（原实现如此，非绕门面场景），mock 其 RPC 面
vi.mock('@/api/domains/quota', () => ({
  getCached: vi.fn(async () => ({ data: null, lastFetchAt: null })),
  fetchQuota: vi.fn(async () => ({ data: null, lastFetchAt: null })),
  refreshQuota: vi.fn(async () => ({ data: null, lastFetchAt: null })),
  configure: vi.fn(async () => ({ ok: true })),
}))

// ── fixture ──

/** oauth 型 catalog provider（凭证区应显示 OAuth 状态；模型混合列表 builtin×2 + override×1） */
const OAUTH_P: ProviderInfo = {
  id: 'kimi-coding',
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

/** api_key 型 catalog provider（凭证区维持 API Key 输入） */
const APIKEY_P: ProviderInfo = {
  id: 'zai-coding-cn',
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

// ── transport stub（save 路径 spy）──

const setProviderSpy = vi.fn(async () => undefined)

function makeTransport(): SettingsTransport {
  const noop = (): void => {}
  return {
    listProviders: vi.fn(async () => []),
    listModels: vi.fn(async () => []),
    setProvider: setProviderSpy,
    discoverModels: vi.fn(async () => ({ success: true, models: [] })),
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

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
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
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

/** mount ProviderEditBody（注入 quota 工厂 + toast；attachTo 供 Dialog teleport 查询） */
function mountBody(provider: ProviderInfo, props: Record<string, unknown> = {}): ReturnType<typeof mount> {
  return mount(ProviderEditBody, {
    props: { provider, oauthPresent: false, oauthSupported: true, ...props },
    attachTo: document.body,
    global: {
      provide: {
        [SETTINGS_TOAST_KEY]: useToast(),
        [USE_QUOTA_CONFIGURE_KEY]: useQuotaConfigure,
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

/** 保存 payload（setProvider 第 2 参） */
function savePayload(index = 0): SetProviderData {
  expect(setProviderSpy.mock.calls.length).toBeGreaterThan(index)
  return setProviderSpy.mock.calls[index]![1] as SetProviderData
}

// ══ B-1 凭证区条件化 ═══════════════════════════════════════════════════════

describe('B-1 凭证区：oauth 型 provider 显示 OAuth 状态区', () => {
  it('已登录态：渲染「已登录（OAuth）」+ 重新登录/退出登录按钮，不渲染 apiKey 输入（首屏冒烟）', async () => {
    wrapper = mountBody(OAUTH_P, { oauthPresent: true })
    await flushPromises()

    expect(wrapper.find('[data-testid="provider-credential-oauth"]').exists()).toBe(true)
    const status = wrapper.find('[data-testid="oauth-status-loggedin"]')
    expect(status.exists()).toBe(true)
    expect(status.text()).toContain('已登录（OAuth）')
    const relogin = wrapper.find('[data-testid="oauth-relogin-btn"]')
    expect(relogin.exists()).toBe(true)
    expect(relogin.text()).toContain('重新登录')
    const logout = wrapper.find('[data-testid="oauth-logout-btn"]')
    expect(logout.exists()).toBe(true)
    expect(logout.text()).toContain('退出登录')
    // oauth 形态不渲染 apiKey 输入
    expect(wrapper.find('[data-testid="provider-edit-apikey"]').exists()).toBe(false)
  })

  it('退出登录按钮 disabled（logout RPC 不存在，占位待接入——禁止发明 RPC）', async () => {
    wrapper = mountBody(OAUTH_P, { oauthPresent: true })
    await flushPromises()

    const logout = wrapper.find<HTMLButtonElement>('[data-testid="oauth-logout-btn"]')
    expect(logout.element.disabled).toBe(true)
  })

  it('未登录态（authMethod=oauth 但 auth.json 无凭据）：显示「未登录（OAuth）」+ 登录按钮', async () => {
    wrapper = mountBody(OAUTH_P, { oauthPresent: false })
    await flushPromises()

    const status = wrapper.find('[data-testid="oauth-status-not-loggedin"]')
    expect(status.exists()).toBe(true)
    expect(status.text()).toContain('未登录（OAuth）')
    expect(wrapper.find('[data-testid="oauth-relogin-btn"]').text()).toContain('登录')
  })

  it('api_key 型 provider：渲染 apiKey 输入，不渲染 OAuth 状态区（反之）', async () => {
    wrapper = mountBody(APIKEY_P)
    await flushPromises()

    expect(wrapper.find('[data-testid="provider-credential-apikey"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="provider-edit-apikey"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="provider-credential-oauth"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="oauth-status-loggedin"]').exists()).toBe(false)
  })
})

describe('B-1 形态切换：I9 双凭据互斥确认弹窗', () => {
  it('oauth 型点「改用 API Key」→ 确认弹窗出现；取消 → 弹窗关闭且凭证区不变（取消不动凭证）', async () => {
    wrapper = mountBody(OAUTH_P, { oauthPresent: true })
    await flushPromises()

    wrapper.find('[data-testid="auth-switch-to-apikey"]').trigger('click')
    await flushPromises()
    const dialog = document.body.querySelector('[data-testid="auth-switch-confirm-dialog"]')
    expect(dialog).toBeTruthy()
    expect(dialog!.textContent).toContain('改用 API Key 将退出 OAuth 登录')

    clickBody('[data-testid="auth-switch-cancel-btn"]')
    await flushPromises()
    expect(document.body.querySelector('[data-testid="auth-switch-confirm-dialog"]')).toBeNull()
    // 取消不动凭证：仍 oauth 态（已登录 + 无 apiKey 输入），未触发保存
    expect(wrapper.find('[data-testid="oauth-status-loggedin"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="provider-edit-apikey"]').exists()).toBe(false)
    expect(setProviderSpy).not.toHaveBeenCalled()
  })

  it('确认切换 oauth→api_key → apiKey 输入出现 + save-bar 出现；填 key 保存 → payload authMethod=api_key + apiKey（覆写 OAuth 凭证）', async () => {
    wrapper = mountBody(OAUTH_P, { oauthPresent: true })
    await flushPromises()

    wrapper.find('[data-testid="auth-switch-to-apikey"]').trigger('click')
    await flushPromises()
    clickBody('[data-testid="auth-switch-confirm-btn"]')
    await flushPromises()

    // 切换后：apiKey 输入出现 + dirty（save-bar）
    expect(wrapper.find('[data-testid="provider-edit-apikey"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="provider-save-bar"]').exists()).toBe(true)

    // 空 key 保存 → 守卫拦截（确认弹窗承诺退出 OAuth，空 key 保存会残留 OAuth 凭证）
    await wrapper.find('[data-testid="provider-save-btn"]').trigger('click')
    await flushPromises()
    expect(setProviderSpy).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="provider-save-bar"]').text()).toContain('改用 API Key 需要输入新的 API Key')

    // 填 key 保存 → payload 正确
    await wrapper.find('[data-testid="provider-edit-apikey"]').setValue('sk-new-key')
    await wrapper.find('[data-testid="provider-save-btn"]').trigger('click')
    await flushPromises()
    expect(setProviderSpy).toHaveBeenCalledTimes(1)
    const payload = savePayload()
    expect(payload.authMethod).toBe('api_key')
    expect(payload.apiKey).toBe('sk-new-key')
  })

  it('api_key 型点「改用 OAuth 登录」（oauthSupported）→ 确认后上抛 oauth-login（父驱动 OAuth flow）', async () => {
    wrapper = mountBody(APIKEY_P)
    await flushPromises()

    await wrapper.find('[data-testid="auth-switch-to-oauth"]').trigger('click')
    await flushPromises()
    const dialog = document.body.querySelector('[data-testid="auth-switch-confirm-dialog"]')
    expect(dialog).toBeTruthy()
    clickBody('[data-testid="auth-switch-confirm-btn"]')
    await flushPromises()

    expect(wrapper.emitted('oauthLogin')).toBeTruthy()
    // 本地凭证形态未变（flow 由父完成后再持久化回推）
    expect(wrapper.find('[data-testid="provider-edit-apikey"]').exists()).toBe(true)
  })

  it('oauth 能力未知（oauthSupported=false）→ api_key 型不渲染「改用 OAuth」入口', async () => {
    wrapper = mountBody(APIKEY_P, { oauthSupported: false })
    await flushPromises()

    expect(wrapper.find('[data-testid="auth-switch-to-oauth"]').exists()).toBe(false)
  })
})

// ══ B-2 模型区混合列表 ═════════════════════════════════════════════════════

describe('B-2 混合列表：catalog provider 内置只读 + 自定义可编辑', () => {
  it('builtin 条目只读渲染（徽章「内置」）与 override 条目（徽章「自定义」、可删）同时显示（首屏冒烟）', async () => {
    wrapper = mountBody(APIKEY_P)
    await flushPromises()

    // builtin 只读区：2 条 + 徽章「内置」，无删除按钮
    const builtinSection = wrapper.find('[data-testid="provider-models-builtin"]')
    expect(builtinSection.exists()).toBe(true)
    const builtinRows = builtinSection.findAll('[data-testid="builtin-model-row"]')
    expect(builtinRows.length).toBe(1) // glm-5.3
    expect(builtinRows[0].text()).toContain('glm-5.3')
    expect(builtinSection.findAll('[data-testid="model-badge-builtin"]').length).toBe(1)
    expect(builtinSection.find('[data-testid="model-badge-builtin"]').text()).toBe('内置')

    // 编辑区（ModelListSection）：仅 override 条目 + 徽章「自定义」+ 可删
    expect(wrapper.find('[data-testid="provider-models-mixed"]').exists()).toBe(true)
    const customBadges = wrapper.findAll('[data-testid="model-badge-custom"]')
    expect(customBadges.length).toBe(1)
    expect(customBadges[0].text()).toBe('自定义')
    // 编辑区不含 builtin 条目（glm-5.3 不可编辑/删除）
    const removeButtons = wrapper.findAll('button[aria-label="移除模型"]')
    expect(removeButtons.length).toBe(1)
  })

  it('添加模型 → save payload 只含 override 条目 + 新条目（builtin 不回传，runtime 合并语义自动补齐）', async () => {
    wrapper = mountBody(APIKEY_P)
    await flushPromises()

    // 打开手动添加表单 + 填名 + 添加
    const addToggle = wrapper.findAll('button').find((b) => b.text().includes('手动添加'))
    expect(addToggle).toBeTruthy()
    await addToggle!.trigger('click')
    await flushPromises()
    const nameInput = wrapper.find('input[placeholder="gpt-4o"]')
    expect(nameInput.exists()).toBe(true)
    await nameInput.setValue('glm-5.4-preview')
    const addBtn = wrapper.findAll('button').find((b) => b.text() === '添加')
    expect(addBtn).toBeTruthy()
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
  })

  it('删除自定义模型 → save payload 不含该条目', async () => {
    wrapper = mountBody(APIKEY_P)
    await flushPromises()

    const removeButtons = wrapper.findAll('button[aria-label="移除模型"]')
    expect(removeButtons.length).toBe(1)
    await removeButtons[0].trigger('click')
    await flushPromises()

    await wrapper.find('[data-testid="provider-save-btn"]').trigger('click')
    await flushPromises()

    const models = savePayload().models as Array<{ id: string }>
    expect(models.map((m) => m.id)).toEqual([]) // 唯一 override 已删；builtin 不回传
  })

  it('C4 决策边界修订注释存在于组件源码（grep 断言：追加自定义模型非 C4 禁止场景）', () => {
    const src = readFileSync(
      resolve(__dirname, '../../../../ui/src/features/settings/provider/ProviderEditBody.vue'),
      'utf-8',
    )
    expect(src).toContain('wave4 C4 决策边界修订')
    expect(src).toContain('追加自定义模型')
    expect(src).toContain('非 C4')
  })
})
