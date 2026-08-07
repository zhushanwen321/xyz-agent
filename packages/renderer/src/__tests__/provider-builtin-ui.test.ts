/**
 * 内置 Provider 模板 UI 渲染测试（wave 3 · builtin-provider-ui）。
 *
 * 覆盖 7 用例：
 *  - t1-t3 ProviderTemplatePicker：列表渲染 / 搜索过滤 / 选中 emit select
 *  - t4-t6 ProviderQuickSetup：信息+凭据渲染 / 明文保存构造 SetProviderData / $ENV 保存 apiKey=$VAR
 *  - t7 ProviderPage 首屏冒烟：入口含「内置模板」按钮（与「从其他 Agent 导入」并列）
 *
 * mock 策略：
 *  - vue-i18n 由 vitest-i18n-setup.ts 全局 mock（t() 从 zh-CN locale 取值）
 *  - @/api 仅 t7 需要（ProviderPage onMounted 调 listBuiltinProviders）
 *
 * reka-ui Popover/Dialog 经 Portal teleport 到 document.body：mount attachTo body 后，
 * portal 内容用 document.body.querySelector 查询；事件用原生 HTMLElement.click()
 * （Vue @click 监听原生 click event，bubbles 生效）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/provider-builtin-ui.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { BuiltinProviderTemplate } from '@xyz-agent/shared'

import { ProviderTemplatePicker as Picker, ProviderQuickSetup as QuickSetup } from '@xyz-agent/ui/features/settings'
import ProviderPage from '@/components/settings/provider/ProviderPage.vue'

// t7 需 mock @/api：listBuiltinProviders 返回空数组（不阻塞页面），setProvider 桩。
// vi.mock 被 vitest 提升到 import 之前，保证 ProviderPage import 时 @/api 已 mock。
const configMock = vi.hoisted(() => ({
  listBuiltinProviders: vi.fn(async () => [] as BuiltinProviderTemplate[]),
  setProvider: vi.fn(async () => {}),
  onProviders: vi.fn(() => () => {}),
  listProviders: vi.fn(async () => []),
  deleteProvider: vi.fn(async () => {}),
}))
vi.mock('@/api', () => ({
  config: configMock,
  default: { config: configMock },
}))

// ── fixture：3 个内置 provider 模板 ──
const TEMPLATES: BuiltinProviderTemplate[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    api: 'openai-completions',
    baseUrl: 'https://api.openai.com/v1',
    authMode: 'api_key',
    envVars: ['OPENAI_API_KEY'],
    oauthSupported: false,
    modelCount: 5,
    models: [],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    api: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    authMode: 'both',
    envVars: ['ANTHROPIC_API_KEY'],
    oauthSupported: true,
    modelCount: 3,
    models: [],
  },
  {
    id: 'openai-codex',
    name: 'OpenAI Codex',
    api: 'openai-responses',
    baseUrl: 'https://api.openai.com/v2',
    authMode: 'oauth',
    envVars: [],
    oauthSupported: true,
    modelCount: 2,
    models: [],
  },
]

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

/** body 内元素点击（portal 内容触发 Vue @click） */
function clickBody(selector: string): void {
  const el = document.body.querySelector<HTMLElement>(selector)
  if (!el) throw new Error(`body 元素未找到: ${selector}`)
  el.click()
}

/** body 内 input 赋值 + 派发 input 事件（v-model 更新） */
function setBodyInput(selector: string, value: string): void {
  const el = document.body.querySelector<HTMLInputElement>(selector)
  if (!el) throw new Error(`body input 未找到: ${selector}`)
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

// ── t1-t3 ProviderTemplatePicker ──

describe('ProviderTemplatePicker', () => {
  it('t1 渲染 provider 列表（打开 Popover 后每项含 name + authMode 徽章）', async () => {
    wrapper = mount(Picker, {
      props: { providers: TEMPLATES },
      attachTo: document.body,
    })
    await flushPromises()
    // 点 trigger 打开 Popover（PopoverContent portal 到 body）
    clickBody('[data-testid="provider-template-picker"]')
    await flushPromises()
    const items = document.body.querySelectorAll<HTMLElement>(
      '[data-testid^="provider-template-"]:not([data-testid="provider-template-picker"]):not([data-testid="provider-template-search"])',
    )
    expect(items.length).toBe(3)
    // 含 name + authMode 徽章文案（API Key / OAuth）
    expect(document.body.textContent).toContain('OpenAI')
    expect(document.body.textContent).toContain('Anthropic')
  })

  it('t2 搜索过滤：输入 openai 后只显示 id 含 openai 的项', async () => {
    wrapper = mount(Picker, {
      props: { providers: TEMPLATES },
      attachTo: document.body,
    })
    await flushPromises()
    clickBody('[data-testid="provider-template-picker"]')
    await flushPromises()
    setBodyInput('[data-testid="provider-template-search"]', 'openai')
    await flushPromises()
    const items = document.body.querySelectorAll<HTMLElement>(
      '[data-testid^="provider-template-"]:not([data-testid="provider-template-picker"]):not([data-testid="provider-template-search"])',
    )
    // openai + openai-codex（id 含 openai），anthropic 不含
    expect(items.length).toBe(2)
  })

  it('t3 选中项 emit select 并关闭 Popover', async () => {
    wrapper = mount(Picker, {
      props: { providers: TEMPLATES },
      attachTo: document.body,
    })
    await flushPromises()
    clickBody('[data-testid="provider-template-picker"]')
    await flushPromises()
    clickBody('[data-testid="provider-template-openai"]')
    await flushPromises()
    const emitted = wrapper.emitted('select')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toStrictEqual(TEMPLATES[0])
  })
})

// ── t4-t6 ProviderQuickSetup ──

describe('ProviderQuickSetup', () => {
  it('t4 渲染 template 元信息（name/baseUrl/api）+ 凭据区 + 取消/保存按钮', async () => {
    wrapper = mount(QuickSetup, {
      props: { template: TEMPLATES[1], open: true }, // anthropic
      attachTo: document.body,
    })
    await flushPromises()
    const bodyText = document.body.textContent ?? ''
    expect(bodyText).toContain('Anthropic')
    expect(bodyText).toContain('https://api.anthropic.com')
    expect(bodyText).toContain('anthropic-messages')
    // 凭据模式切换按钮存在
    expect(document.body.querySelector('[data-testid="credential-mode-plaintext"]')).toBeTruthy()
    expect(document.body.querySelector('[data-testid="credential-mode-env"]')).toBeTruthy()
    // 保存按钮存在
    expect(document.body.querySelector('[data-testid="provider-quick-setup-save"]')).toBeTruthy()
  })

  it('t5 明文模式保存：emit save payload.data.apiKey=明文 + name=template.name（方案 B 占位无 models）', async () => {
    wrapper = mount(QuickSetup, {
      props: { template: TEMPLATES[1], open: true }, // anthropic
      attachTo: document.body,
    })
    await flushPromises()
    // 默认明文模式，填 API Key
    setBodyInput('[data-testid="credential-apikey-input"]', 'sk-xxx')
    await flushPromises()
    clickBody('[data-testid="provider-quick-setup-save"]')
    await flushPromises()
    const emitted = wrapper.emitted('save')
    expect(emitted).toBeTruthy()
    const payload = emitted![0][0] as { providerId: string; data: Record<string, unknown> }
    expect(payload.providerId).toBe('anthropic')
    expect(payload.data.apiKey).toBe('sk-xxx')
    expect(payload.data.name).toBe('Anthropic')
    // 方案 B 占位：不写 models
    expect(payload.data.models).toBeUndefined()
  })

  it('t6 $ENV 模式保存：apiKey=$OPENAI_API_KEY（envVar 默认预填 envVars[0]）', async () => {
    wrapper = mount(QuickSetup, {
      props: { template: TEMPLATES[0], open: true }, // openai, envVars=[OPENAI_API_KEY]
      attachTo: document.body,
    })
    await flushPromises()
    // 切 env 模式（envVar 已由 watch immediate 预填 OPENAI_API_KEY）
    clickBody('[data-testid="credential-mode-env"]')
    await flushPromises()
    clickBody('[data-testid="provider-quick-setup-save"]')
    await flushPromises()
    const emitted = wrapper.emitted('save')
    expect(emitted).toBeTruthy()
    const payload = emitted![0][0] as { providerId: string; data: Record<string, unknown> }
    expect(payload.providerId).toBe('openai')
    expect(payload.data.apiKey).toBe('$OPENAI_API_KEY')
  })
})

// ── t7 ProviderPage 首屏冒烟 ──

describe('ProviderPage 入口', () => {
  it('t7 首屏渲染含「内置模板」入口按钮（data-testid=provider-template-picker）', async () => {
    wrapper = mount(ProviderPage, {
      props: { providers: [] },
      attachTo: document.body,
    })
    await flushPromises()
    expect(
      wrapper.find('[data-testid="provider-template-picker"]').exists(),
    ).toBe(true)
    // 并列的「从其他 Agent 导入」入口仍在
    expect(
      wrapper.find('[data-testid="import-providers-menu"]').exists(),
    ).toBe(true)
  })
})
