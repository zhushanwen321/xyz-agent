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
import { useToast } from '@/composables/useToast'

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
  {
    id: 'google-vertex',
    name: 'Google Vertex AI',
    api: 'google-vertex',
    baseUrl: 'https://us-central1-aiplatform.googleapis.com',
    authMode: 'ambient',
    envVars: [],
    oauthSupported: false,
    modelCount: 6,
    models: [],
  },
]

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  // 集成链路用例需从零计数断言 setProvider 调用次数
  configMock.setProvider.mockClear()
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

/**
 * reka Select 交互：打开/选中依赖 pointerdown/pointerup（click 不触发）。
 * happy-dom 缺 pointer capture API（SelectTrigger onPointerdown 直接调 target.hasPointerCapture），
 * 派发前 polyfill 到元素上。
 */
function pointerBody(selector: string, type: 'pointerdown' | 'pointerup'): void {
  const el = document.body.querySelector<HTMLElement>(selector)
  if (!el) throw new Error(`body 元素未找到: ${selector}`)
  const anyEl = el as HTMLElement & {
    hasPointerCapture?: (id: number) => boolean
    releasePointerCapture?: (id: number) => void
  }
  if (typeof anyEl.hasPointerCapture !== 'function') anyEl.hasPointerCapture = () => false
  if (typeof anyEl.releasePointerCapture !== 'function') anyEl.releasePointerCapture = () => {}
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0 }))
}

// ── t1-t3 ProviderTemplatePicker ──

describe('ProviderTemplatePicker', () => {
  it('t1 渲染 provider 列表（打开 Popover 后每项含 name + authMode 徽章）', async () => {
    wrapper = mount(Picker, {
      props: { providers: TEMPLATES },
      attachTo: document.body,
    })
    await flushPromises()
    // F2：点 trigger 先进入菜单视图，再点「从内置模板」进入选择器
    clickBody('[data-testid="provider-template-picker"]')
    await flushPromises()
    clickBody('[data-testid="add-menu-builtin"]')
    await flushPromises()
    const items = document.body.querySelectorAll<HTMLElement>(
      '[data-testid^="provider-template-"]:not([data-testid="provider-template-picker"]):not([data-testid="provider-template-search"]):not([data-testid="add-menu-builtin"]):not([data-testid="add-menu-custom"])',
    )
    expect(items.length).toBe(4)
    // 含 name + authMode 徽章文案（API Key / OAuth）
    expect(document.body.textContent).toContain('OpenAI')
    expect(document.body.textContent).toContain('Anthropic')
  })

  it('t1b F2 入口菜单：打开后默认显示「从内置模板（推荐）+ 自定义」两条目，内置模板默认高亮', async () => {
    wrapper = mount(Picker, {
      props: { providers: TEMPLATES },
      attachTo: document.body,
    })
    await flushPromises()
    clickBody('[data-testid="provider-template-picker"]')
    await flushPromises()
    expect(document.body.querySelector('[data-testid="add-menu-builtin"]')).toBeTruthy()
    expect(document.body.querySelector('[data-testid="add-menu-custom"]')).toBeTruthy()
    // 内置模板条目带「推荐」标识 + 高亮底色（bg-surface-2）
    const builtin = document.body.querySelector<HTMLElement>('[data-testid="add-menu-builtin"]')
    expect(builtin!.textContent).toContain('推荐')
    expect(builtin!.className).toContain('bg-surface-2')
    // 此时不显示选择器搜索框（二级视图未进入）
    expect(document.body.querySelector('[data-testid="provider-template-search"]')).toBeNull()
  })

  it('t1c F2 菜单「自定义」条目 → emit custom 并关闭 Popover', async () => {
    wrapper = mount(Picker, {
      props: { providers: TEMPLATES },
      attachTo: document.body,
    })
    await flushPromises()
    clickBody('[data-testid="provider-template-picker"]')
    await flushPromises()
    clickBody('[data-testid="add-menu-custom"]')
    await flushPromises()
    expect(wrapper.emitted('custom')).toBeTruthy()
    // 关闭后选择器隐藏
    expect(document.body.querySelector('[data-testid="add-menu-custom"]')).toBeNull()
  })

  it('t1d F5 列表项渲染首字母色块（语义色类，非硬编码颜色）', async () => {
    wrapper = mount(Picker, {
      props: { providers: TEMPLATES },
      attachTo: document.body,
    })
    await flushPromises()
    clickBody('[data-testid="provider-template-picker"]')
    await flushPromises()
    clickBody('[data-testid="add-menu-builtin"]')
    await flushPromises()
    // 首个 provider 的色块：首字母 + 语义色背景类（bg-*-soft）
    const item = document.body.querySelector<HTMLElement>('[data-testid="provider-template-openai"]')
    const avatar = item!.querySelector('.size-6')
    expect(avatar).toBeTruthy()
    expect(avatar!.textContent).toBe('O')
    const cls = avatar!.className
    expect(cls).toMatch(/bg-(accent|success|warn|danger|info)-soft/)
    expect(cls).not.toContain('bg-[')
  })

  it('t2 搜索过滤：输入 openai 后只显示 id 含 openai 的项', async () => {
    wrapper = mount(Picker, {
      props: { providers: TEMPLATES },
      attachTo: document.body,
    })
    await flushPromises()
    clickBody('[data-testid="provider-template-picker"]')
    await flushPromises()
    clickBody('[data-testid="add-menu-builtin"]')
    await flushPromises()
    setBodyInput('[data-testid="provider-template-search"]', 'openai')
    await flushPromises()
    const items = document.body.querySelectorAll<HTMLElement>(
      '[data-testid^="provider-template-"]:not([data-testid="provider-template-picker"]):not([data-testid="provider-template-search"]):not([data-testid="add-menu-builtin"]):not([data-testid="add-menu-custom"])',
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
    clickBody('[data-testid="add-menu-builtin"]')
    await flushPromises()
    clickBody('[data-testid="provider-template-openai"]')
    await flushPromises()
    const emitted = wrapper.emitted('select')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toStrictEqual(TEMPLATES[0])
    // sa4 Major #2 剩余：选中后 Popover 立即关闭，选择器内容从 body 消失
    expect(document.body.querySelector('[data-testid="provider-template-search"]')).toBeNull()
    expect(document.body.querySelector('[data-testid="provider-template-openai"]')).toBeNull()
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

  it('t4b F3 默认凭据模式：envVars 非空默认环境变量（env select 可见，无需手动切）', async () => {
    wrapper = mount(QuickSetup, {
      props: { template: TEMPLATES[0], open: true }, // openai, envVars=[OPENAI_API_KEY]
      attachTo: document.body,
    })
    await flushPromises()
    // 默认 env：环境变量 select 渲染，明文输入框不渲染
    expect(document.body.querySelector('[data-testid="credential-envvar-select"]')).toBeTruthy()
    expect(document.body.querySelector('[data-testid="credential-apikey-input"]')).toBeNull()
  })

  it('t4c F3 默认凭据模式：envVars 为空回退明文', async () => {
    wrapper = mount(QuickSetup, {
      props: { template: TEMPLATES[3], open: true }, // google-vertex（ambient，envVars=[]）
      attachTo: document.body,
    })
    await flushPromises()
    // ambient：无凭据输入区，显示云凭证说明
    expect(document.body.querySelector('[data-testid="credential-ambient"]')).toBeTruthy()
    expect(document.body.querySelector('[data-testid="credential-apikey-input"]')).toBeNull()
    expect(document.body.querySelector('[data-testid="credential-envvar-select"]')).toBeNull()
  })

  it('t5 明文模式保存：emit save payload.data.apiKey=明文 + name=template.name（方案 B 占位无 models）', async () => {
    wrapper = mount(QuickSetup, {
      props: { template: TEMPLATES[1], open: true }, // anthropic
      attachTo: document.body,
    })
    await flushPromises()
    // 默认 env 模式（F3），先切明文
    clickBody('[data-testid="credential-mode-plaintext"]')
    await flushPromises()
    setBodyInput('[data-testid="credential-apikey-input"]', 'sk-xxx')
    await flushPromises()
    // 渲染 gate：明文输入框存在且输入生效（DOM 断言）
    const keyInput = document.body.querySelector<HTMLInputElement>('[data-testid="credential-apikey-input"]')
    expect(keyInput).toBeTruthy()
    expect(keyInput!.value).toBe('sk-xxx')
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

  it('t6 $ENV 模式保存：apiKey=$OPENAI_API_KEY（envVar 默认预填 envVars[0]，且默认即 env 模式）', async () => {
    wrapper = mount(QuickSetup, {
      props: { template: TEMPLATES[0], open: true }, // openai, envVars=[OPENAI_API_KEY]
      attachTo: document.body,
    })
    await flushPromises()
    // 渲染 gate：默认 env 模式 select 渲染（DOM 断言）
    expect(document.body.querySelector('[data-testid="credential-envvar-select"]')).toBeTruthy()
    // F3：默认 env 模式，直接保存
    clickBody('[data-testid="provider-quick-setup-save"]')
    await flushPromises()
    const emitted = wrapper.emitted('save')
    expect(emitted).toBeTruthy()
    const payload = emitted![0][0] as { providerId: string; data: Record<string, unknown> }
    expect(payload.providerId).toBe('openai')
    expect(payload.data.apiKey).toBe('$OPENAI_API_KEY')
  })

  it('t6b F4 自定义环境变量：下拉选「自定义变量名」→ 输入框出现 → 保存 apiKey=$自定义名', async () => {
    wrapper = mount(QuickSetup, {
      props: { template: TEMPLATES[0], open: true }, // openai
      attachTo: document.body,
    })
    await flushPromises()
    // 打开 Select 选「自定义变量名」（reka Select 由 pointerdown 打开）
    pointerBody('[data-testid="credential-envvar-select"]', 'pointerdown')
    await flushPromises()
    const customItem = Array.from(document.body.querySelectorAll('[role="option"]')).find(
      (el) => el.textContent === '自定义变量名…',
    ) as HTMLElement | undefined
    expect(customItem).toBeTruthy()
    await flushPromises()
    // 选中项由 pointerup 触发（SelectItem handleSelectCustomEvent）
    const opt = customItem as HTMLElement & {
      hasPointerCapture?: (id: number) => boolean
      releasePointerCapture?: (id: number) => void
    }
    if (typeof opt.hasPointerCapture !== 'function') opt.hasPointerCapture = () => false
    if (typeof opt.releasePointerCapture !== 'function') opt.releasePointerCapture = () => {}
    customItem!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }))
    await flushPromises()
    // 自定义输入框出现
    const customInput = document.body.querySelector<HTMLInputElement>('[data-testid="credential-envvar-custom"]')
    expect(customInput).toBeTruthy()
    setBodyInput('[data-testid="credential-envvar-custom"]', 'MY_OPENAI_KEY')
    await flushPromises()
    clickBody('[data-testid="provider-quick-setup-save"]')
    await flushPromises()
    const emitted = wrapper.emitted('save')
    expect(emitted).toBeTruthy()
    const payload = emitted![0][0] as { providerId: string; data: Record<string, unknown> }
    expect(payload.data.apiKey).toBe('$MY_OPENAI_KEY')
  })

  it('t8 F1 oauth-only 模板：无 key 输入、显示 OAuth 提示、保存禁用', async () => {
    wrapper = mount(QuickSetup, {
      props: { template: TEMPLATES[2], open: true }, // openai-codex
      attachTo: document.body,
    })
    await flushPromises()
    expect(document.body.querySelector('[data-testid="credential-oauth-only"]')).toBeTruthy()
    expect(document.body.querySelector('[data-testid="credential-apikey-input"]')).toBeNull()
    expect(document.body.querySelector('[data-testid="credential-mode-plaintext"]')).toBeNull()
    const save = document.body.querySelector<HTMLButtonElement>('[data-testid="provider-quick-setup-save"]')
    expect(save!.disabled).toBe(true)
  })

  it('t8b F1 oauth-only 模板：保存不可触发（无 save emit）', async () => {
    wrapper = mount(QuickSetup, {
      props: { template: TEMPLATES[2], open: true }, // openai-codex
      attachTo: document.body,
    })
    await flushPromises()
    // 渲染 gate：oauth-only 提示可见 + 保存按钮 disabled（DOM 断言）
    expect(document.body.querySelector('[data-testid="credential-oauth-only"]')).toBeTruthy()
    const saveBtn = document.body.querySelector<HTMLButtonElement>('[data-testid="provider-quick-setup-save"]')
    expect(saveBtn).toBeTruthy()
    expect(saveBtn!.disabled).toBe(true)
    clickBody('[data-testid="provider-quick-setup-save"]')
    await flushPromises()
    expect(wrapper.emitted('save')).toBeFalsy()
  })

  it('t8c F1 both 模板：显示 OAuth 提示行（支持 OAuth 登录 Phase 2）', async () => {
    wrapper = mount(QuickSetup, {
      props: { template: TEMPLATES[1], open: true }, // anthropic
      attachTo: document.body,
    })
    await flushPromises()
    const hint = document.body.querySelector('[data-testid="credential-oauth-hint"]')
    expect(hint).toBeTruthy()
    expect(hint!.textContent).toContain('OAuth')
  })

  it('t9 F1 ambient 模板：无 key 输入、保存可用、payload 不塞 apiKey', async () => {
    wrapper = mount(QuickSetup, {
      props: { template: TEMPLATES[3], open: true }, // google-vertex
      attachTo: document.body,
    })
    await flushPromises()
    expect(document.body.querySelector('[data-testid="credential-ambient"]')).toBeTruthy()
    const save = document.body.querySelector<HTMLButtonElement>('[data-testid="provider-quick-setup-save"]')
    expect(save!.disabled).toBe(false)
    clickBody('[data-testid="provider-quick-setup-save"]')
    await flushPromises()
    const emitted = wrapper.emitted('save')
    expect(emitted).toBeTruthy()
    const payload = emitted![0][0] as { providerId: string; data: Record<string, unknown> }
    expect(payload.providerId).toBe('google-vertex')
    // ambient 不塞 apiKey
    expect(payload.data.apiKey).toBeUndefined()
    // 仍遵守方案 B 占位（name/api/baseUrl，无 models）
    expect(payload.data.name).toBe('Google Vertex AI')
    expect(payload.data.models).toBeUndefined()
  })

  it('t9b F7b 信息区显示内置模型数（含「保存后自动可用」说明）', async () => {
    wrapper = mount(QuickSetup, {
      props: { template: TEMPLATES[1], open: true }, // anthropic, modelCount=3
      attachTo: document.body,
    })
    await flushPromises()
    expect(document.body.textContent).toContain('3 个内置模型（保存后自动可用）')
  })
})

// ── t7 ProviderPage 首屏冒烟 ──

describe('ProviderPage 入口', () => {
  it('t7 首屏渲染含「添加供应商」入口按钮（data-testid=provider-template-picker）', async () => {
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

  it('t11 F2 入口聚合：点「添加供应商」→ 菜单含内置模板/自定义 → 点自定义走 createAndExpand 原流程', async () => {
    wrapper = mount(ProviderPage, {
      props: { providers: [] },
      attachTo: document.body,
    })
    await flushPromises()
    // 点 trigger 打开菜单
    clickBody('[data-testid="provider-template-picker"]')
    await flushPromises()
    expect(document.body.querySelector('[data-testid="add-menu-builtin"]')).toBeTruthy()
    expect(document.body.querySelector('[data-testid="add-menu-custom"]')).toBeTruthy()
    // 点「自定义」→ 原流程：新建合成行并展开就地编辑体
    clickBody('[data-testid="add-menu-custom"]')
    await flushPromises()
    expect(wrapper.find('[data-testid="provider-expand-body"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="provider-edit-name"]').exists()).toBe(true)
  })
})

// ── ProviderPage 保存集成链路（sa4 Major #3）──

/**
 * 完整旅程：选模板 → 填 key → 保存 → config.setProvider 被调 + payload 正确 + toast + UI 收尾。
 * ProviderPage 接线：onTemplateSelect 开 QuickSetup → QuickSetup emit('save') →
 * onQuickSetupSave 调 config.setProvider → 成功关 Dialog + toast.info。
 * toast 是模块级单例（useToast 的 toasts ref），直接读取断言（App 级 ToastContainer 不在测试树内）。
 */
describe('ProviderPage 内置模板保存链路', () => {
  afterEach(() => {
    // 清理模块级 toast 单例，避免泄漏到其它用例
    useToast().toasts.value = []
  })

  it('t10 选模板 → 切明文填 key → 保存 → setProvider payload 正确（无 models）+ toast + Dialog 关闭', async () => {
    configMock.listBuiltinProviders.mockResolvedValueOnce(TEMPLATES)
    wrapper = mount(ProviderPage, {
      props: { providers: [] },
      attachTo: document.body,
    })
    await flushPromises()

    // 1. 入口：点「添加供应商」→ 菜单「从内置模板」→ 选 openai（onMounted 拉取 mock 模板）
    clickBody('[data-testid="provider-template-picker"]')
    await flushPromises()
    clickBody('[data-testid="add-menu-builtin"]')
    await flushPromises()
    clickBody('[data-testid="provider-template-openai"]')
    await flushPromises()

    // 2. QuickSetup Dialog 渲染（含 openai 元信息）
    const dialog = document.body.querySelector('[data-testid="provider-quick-setup"]')
    expect(dialog).toBeTruthy()
    expect(dialog!.textContent).toContain('OpenAI')
    expect(dialog!.textContent).toContain('https://api.openai.com/v1')

    // 3. 切明文模式填 key（openai envVars 非空默认 env，需手动切）
    clickBody('[data-testid="credential-mode-plaintext"]')
    await flushPromises()
    setBodyInput('[data-testid="credential-apikey-input"]', 'sk-xyz-123')
    await flushPromises()
    clickBody('[data-testid="provider-quick-setup-save"]')
    await flushPromises()

    // 4. config.setProvider 被调用且 payload 正确（方案 B：name/api/baseUrl/apiKey，无 models）
    expect(configMock.setProvider).toHaveBeenCalledTimes(1)
    expect(configMock.setProvider).toHaveBeenCalledWith('openai', {
      name: 'OpenAI',
      api: 'openai-completions',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-xyz-123',
    })
    const payload = configMock.setProvider.mock.calls[0]![1] as Record<string, unknown>
    expect(payload.models).toBeUndefined()

    // 5. 成功 toast（i18n toastSuccess = 已添加 {name}）
    expect(useToast().toasts.value.some((t) => t.type === 'info' && t.message.includes('已添加 OpenAI'))).toBe(true)

    // 6. UI 收尾：QuickSetup Dialog 从 body 消失（selectedTemplate 清空 → v-if 卸载）
    expect(document.body.querySelector('[data-testid="provider-quick-setup"]')).toBeNull()
  })

  it('t10b 保存失败 → toast error + Dialog 保持打开（可重试）', async () => {
    configMock.listBuiltinProviders.mockResolvedValueOnce(TEMPLATES)
    configMock.setProvider.mockRejectedValueOnce(new Error('boom'))
    wrapper = mount(ProviderPage, {
      props: { providers: [] },
      attachTo: document.body,
    })
    await flushPromises()

    clickBody('[data-testid="provider-template-picker"]')
    await flushPromises()
    clickBody('[data-testid="add-menu-builtin"]')
    await flushPromises()
    clickBody('[data-testid="provider-template-anthropic"]')
    await flushPromises()

    // anthropic envVars 非空默认 env 模式，直接保存（不填 key 也能过 env 模式）
    clickBody('[data-testid="provider-quick-setup-save"]')
    await flushPromises()

    // setProvider 失败 → error toast + Dialog 不关闭
    expect(configMock.setProvider).toHaveBeenCalledTimes(1)
    expect(useToast().toasts.value.some((t) => t.type === 'error' && t.message.includes('boom'))).toBe(true)
    expect(document.body.querySelector('[data-testid="provider-quick-setup"]')).toBeTruthy()
  })
})
