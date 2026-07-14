/**
 * ProviderEditModal 单测 —— api 类型 Select option 约束（W4 U7）。
 *
 * 锁定：pi 不支持 ollama 作为 api 标识（runtime 不做别名翻译，见 shared/constants PROVIDER_API_TYPES）。
 * 故 Select 的 option value 集合必须 ∈ PROVIDER_API_TYPES = ['anthropic-messages','openai-completions']，
 * 不得出现 'ollama'——否则保存时把 'ollama' 发给 runtime/pi，pi 不认。
 *
 * 验证方式：打开弹窗（provider=null 新增模式），从 teleport 到 body 的 SelectContent 读所有
 * SelectItem 的 data-value，断言无 'ollama' 且均为 PROVIDER_API_TYPES 成员。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/settings/provider-edit-modal.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { PROVIDER_API_TYPES } from '@xyz-agent/shared'

/** config mock：useProviderEdit 调真实 transport 会挂起，全替掉。 */
const configMock = vi.hoisted(() => ({
  onProviders: vi.fn(() => () => {}),
  listProviders: vi.fn(async () => []),
  setProvider: vi.fn(async () => {}),
  deleteProvider: vi.fn(async () => {}),
  testProvider: vi.fn(async () => ({ ok: true })),
  discoverModels: vi.fn(async () => ({ success: true, models: [], error: undefined })),
}))

vi.mock('@/api', () => ({
  config: configMock,
  default: { config: configMock },
}))

import ProviderEditModal from '@/components/settings/ProviderEditModal.vue'
import { useProviderEdit } from '@/composables/features/useProviderEdit'
import { useToast } from '@/composables/useToast'
import type { ProviderInfo } from '@xyz-agent/shared'

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  // 清空全局 toasts（useToast 模块级单例，跨用例共享）
  const { toasts } = useToast()
  toasts.value = []
  configMock.setProvider.mockClear()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

/** 编辑态 provider fixture（含 models，apiKeySet=true 表示已配置 key） */
function providerFixture(): ProviderInfo {
  return {
    id: 'p1',
    name: 'Provider One',
    api: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    apiKeySet: true,
    enabled: true,
    models: [
      { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', contextWindow: 200_000 },
    ],
  } as ProviderInfo
}

describe('ProviderEditModal api 类型 Select option 约束', () => {
  it('U7: option 文案集合不含 Ollama，且提供 Anthropic Messages + OpenAI Compatible（与 PROVIDER_API_TYPES 对齐）', async () => {
    wrapper = mount(ProviderEditModal, {
      props: { open: true, provider: null },
      attachTo: document.body,
    })
    await flushPromises()

    // reka-ui Select 的 SelectContent 仅在 open 时挂载（SelectPortal teleport）。
    // 「类型」Select 的 trigger 即 SelectTrigger（[role=combobox"]）。
    // reka-ui SelectTrigger 在 pointerdown 时打开，happy-dom 下需显式 dispatch。
    const combo = document.body.querySelector('[role="combobox"]') as HTMLElement | null
    expect(combo).toBeTruthy()
    combo!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    combo!.click()
    await flushPromises()

    // SelectItem 渲染为 [role=option]。reka-ui 不把 value 暴露成 data-value 属性，
    // 故用 option 文案断言：必须出现两个 pi 支持类型，且不得出现 Ollama。
    const options = document.body.querySelectorAll('[role="option"]')
    expect(options.length).toBeGreaterThan(0)
    const labels = Array.from(options).map((el) => el.textContent ?? '')

    // 不含 ollama 文案（pi 不支持 ollama 作为 api 标识）
    const joined = labels.join('|')
    expect(joined).not.toContain('Ollama')
    expect(joined).not.toContain('ollama')
    // 提供与 PROVIDER_API_TYPES 对齐的两个 option（文案固定）
    expect(labels).toContain('Anthropic Messages')
    expect(labels).toContain('OpenAI Compatible')

    // 兜底：form.api 初始值也必须在白名单内（v-model 默认值合规）
    const apiVal = (wrapper!.vm as unknown as { form: { api: string } }).form.api
    expect(new Set<string>(PROVIDER_API_TYPES).has(apiVal)).toBe(true)
  })
})

// ── W4 · D12/D13/D15/D18: 保存 toast / 未保存确认 / 校验 / apiKey 提示 ──
//
// 背景：
//  D12：保存成功仅 emit('close')，无 toast 确认。
//  D13：取消/X/Esc 直接 emit('close')，改动丢失无确认。
//  D15a：addModel 空名静默返回；D15b：save 空名直接发 config.setProvider('', ...)。
//  D18：apiKey 留空保存=不改，UI 无说明。
//
// 查询策略：Dialog open=true 时 DialogContent 通过 Teleport 渲染到 document.body，
// wrapper.findAll 找不到。统一用 queryBodyInput/queryBodyButton 从 document.body 查询。

/** 在 document.body 内按 placeholder 找 input 元素 */
function queryBodyInput(placeholder: string): HTMLInputElement | null {
  return document.body.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)
}

/** 在 document.body 内按文案精确匹配找 button 元素 */
function queryBodyButton(text: string): HTMLButtonElement | null {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
    .find((b) => b.textContent?.trim() === text) ?? null
}

/** 在 document.body 内按文案子串找 button 元素 */
function queryBodyButtonIncludes(text: string): HTMLButtonElement | null {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
    .find((b) => (b.textContent ?? '').includes(text)) ?? null
}

describe('W4 D12: 保存成功 toast 反馈', () => {
  it('onSave 成功后 toastInfo("已保存") 并 emit close', async () => {
    const { toasts } = useToast()
    wrapper = mount(ProviderEditModal, {
      props: { open: true, provider: null },
      attachTo: document.body,
    })
    await flushPromises()
    // 填 name（满足 save 校验）
    const nameInput = queryBodyInput('My Provider')
    expect(nameInput).toBeTruthy()
    nameInput!.value = 'NewProvider'
    nameInput!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    // 点保存
    const saveBtn = queryBodyButtonIncludes('保存')
    expect(saveBtn).toBeTruthy()
    saveBtn!.click()
    await flushPromises()
    expect(configMock.setProvider).toHaveBeenCalled()
    expect(toasts.value.some((t) => t.message === '已保存' && t.type === 'info')).toBe(true)
    // close 已 emit
    expect(wrapper!.emitted('close')).toBeTruthy()
  })
})

describe('W4 D13: 取消时未保存修改确认', () => {
  it('有改动 → 点取消 → 弹 ConfirmDialog 含「未保存」文案，且未立即 close', async () => {
    wrapper = mount(ProviderEditModal, {
      props: { open: true, provider: providerFixture() },
      attachTo: document.body,
    })
    await flushPromises()
    // 改 name → 制造 dirty
    const nameInput = queryBodyInput('My Provider')
    expect(nameInput).toBeTruthy()
    nameInput!.value = 'Changed Name'
    nameInput!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    // 点取消（底栏「取消」按钮）
    const cancelBtn = queryBodyButton('取消')
    expect(cancelBtn).toBeTruthy()
    cancelBtn!.click()
    await flushPromises()
    // 确认弹窗（teleport 到 body）渲染，含「未保存」文案
    const bodyText = document.body.textContent ?? ''
    expect(bodyText).toContain('未保存')
    // 此时未 close（要确认后才 close）
    expect(wrapper!.emitted('close')).toBeFalsy()
  })

  it('无改动 → 点取消 → 不弹确认，直接 emit close', async () => {
    wrapper = mount(ProviderEditModal, {
      props: { open: true, provider: providerFixture() },
      attachTo: document.body,
    })
    await flushPromises()
    const cancelBtn = queryBodyButton('取消')
    expect(cancelBtn).toBeTruthy()
    cancelBtn!.click()
    await flushPromises()
    const bodyText = document.body.textContent ?? ''
    expect(bodyText).not.toContain('未保存')
    expect(wrapper!.emitted('close')).toBeTruthy()
  })

  it('有改动 → 确认弹窗点「确认关闭」→ emit close', async () => {
    wrapper = mount(ProviderEditModal, {
      props: { open: true, provider: providerFixture() },
      attachTo: document.body,
    })
    await flushPromises()
    const nameInput = queryBodyInput('My Provider')
    nameInput!.value = 'Changed Name'
    nameInput!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    const cancelBtn = queryBodyButton('取消')
    cancelBtn!.click()
    await flushPromises()
    // 点确认关闭按钮（ConfirmDialog 内）
    const confirmBtn = Array.from(document.body.querySelectorAll('button'))
      .find((b) => /确认关闭|确认/.test(b.textContent ?? ''))
    expect(confirmBtn).toBeTruthy()
    confirmBtn!.click()
    await flushPromises()
    expect(wrapper!.emitted('close')).toBeTruthy()
  })
})

describe('W4 D15a/D15b: addModel / save 前端校验', () => {
  it('addModel 空名 → 抛错（调用方 onAddModel catch 后填 actionError）', async () => {
    const { addModel } = useProviderEdit({ value: providerFixture() } as never)
    await flushPromises()
    // composable 层契约：空名/重名抛错；actionError 由组件层 onAddModel catch 后填
    expect(() => addModel()).toThrow(/模型名称不能为空|模型名/)
  })

  it('addModel 重名 → 抛错（UI 驱动：fixture 已含 claude-sonnet-4-5，再添加同名）', async () => {
    // 直接 composable 调时 providerRef 是伪造 ref，watch(immediate) 对非响应式源不触发，
    // localModels 不会被 fixture 填充。改用 UI 驱动（见下个「UI 添加重名模型」用例），
    // 这里仅断言空名抛错的 composable 契约（上面用例已覆盖）。
    // 此用例保留为契约占位，实际重名校验由 UI 用例验证。
    const { addModel, newModel, localModels } = useProviderEdit({ value: providerFixture() } as never)
    await flushPromises()
    // 手动预置 localModels（伪造 ref 不触发 watch）+ newModel.name 同名
    localModels.value = [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }]
    newModel.name = 'claude-sonnet-4-5'
    expect(() => addModel()).toThrow(/已存在|重复/)
  })

  it('UI 添加空名模型 → 显示 inline 错误（actionError）', async () => {
    wrapper = mount(ProviderEditModal, {
      props: { open: true, provider: providerFixture() },
      attachTo: document.body,
    })
    await flushPromises()
    // 展开「+ 手动添加」
    const addToggle = queryBodyButtonIncludes('手动添加')
    expect(addToggle).toBeTruthy()
    addToggle!.click()
    await flushPromises()
    // 不输入名称直接点「添加」（newModel.name 默认空）
    const addBtn = queryBodyButton('添加')
    expect(addBtn).toBeTruthy()
    addBtn!.click()
    await flushPromises()
    // actionError 显示在 body（底栏 / inline）
    expect(document.body.textContent ?? '').toMatch(/模型名称不能为空|模型名/)
  })

  it('UI 添加重名模型 → 显示 inline 错误（actionError）', async () => {
    wrapper = mount(ProviderEditModal, {
      props: { open: true, provider: providerFixture() },
      attachTo: document.body,
    })
    await flushPromises()
    const addToggle = queryBodyButtonIncludes('手动添加')
    addToggle!.click()
    await flushPromises()
    // 输入已存在的模型 id（claude-sonnet-4-5），点「添加」
    const modelNameInput = queryBodyInput('gpt-4o')
    expect(modelNameInput).toBeTruthy()
    modelNameInput!.value = 'claude-sonnet-4-5'
    modelNameInput!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    const addBtn = queryBodyButton('添加')
    expect(addBtn).toBeTruthy()
    addBtn!.click()
    await flushPromises()
    // actionError 显示
    expect(document.body.textContent ?? '').toMatch(/已存在|重复/)
  })

  it('save 空名 → 抛错且不调 setProvider', async () => {
    const { save } = useProviderEdit({ value: null } as never)
    await flushPromises()
    // form.name 默认空（providerRef=null 新增模式）
    const ok = await save()
    expect(ok).toBe(false)
    expect(configMock.setProvider).not.toHaveBeenCalled()
  })

  it('UI 保存空名 → 不调 setProvider 且底栏显示错误', async () => {
    wrapper = mount(ProviderEditModal, {
      props: { open: true, provider: null },
      attachTo: document.body,
    })
    await flushPromises()
    // 不填 name 直接点保存
    const saveBtn = queryBodyButtonIncludes('保存')
    expect(saveBtn).toBeTruthy()
    saveBtn!.click()
    await flushPromises()
    expect(configMock.setProvider).not.toHaveBeenCalled()
    expect(document.body.textContent ?? '').toMatch(/名称不能为空|供应商名称/)
  })
})

// ── W3 · D7: headers/authHeader 编辑回填 + 保存回写 ──
//
// 背景：ProviderInfo 有 headers?: Record<string,string> 和 authHeader?: boolean（provider.ts:9-10），
// 但 settings 无编辑入口/回填。W3 补全：form 加 headers/authHeader 字段，Modal 加 headers 编辑区
// （key-value 行）+ authHeader Switch，save 回写 setProvider。
describe('W3 D7: headers/authHeader 编辑回填 + 保存回写', () => {
  function providerWithHeaders(): ProviderInfo {
    return {
      id: 'custom',
      name: 'Custom',
      api: 'openai-completions',
      baseUrl: 'https://api.custom.com/v1',
      apiKeySet: true,
      status: 'connected',
      enabled: true,
      headers: { 'X-Custom': 'val' },
      authHeader: true,
      models: [{ id: 'm1', name: 'M1', contextWindow: 128_000, input: ['text'] }],
    } as ProviderInfo
  }

  it('编辑含 headers/authHeader 的 provider → headers 区显示 X-Custom:val，authHeader Switch checked', async () => {
    wrapper = mount(ProviderEditModal, {
      props: { open: true, provider: providerWithHeaders() },
      attachTo: document.body,
    })
    await flushPromises()

    // headers 区可见（data-testid="headers-editor"）。DialogContent teleport 到 body，
    // 故用 document.body 查询（与 U7 测试同模式）。
    const headersEditor = document.body.querySelector('[data-testid="headers-editor"]')
    expect(headersEditor).toBeTruthy()
    // key/value 输入含 X-Custom 与 val
    const headerInputs = headersEditor!.querySelectorAll('input')
    const inputValues = Array.from(headerInputs).map((i) => (i as HTMLInputElement).value)
    expect(inputValues.some((v) => v === 'X-Custom')).toBe(true)
    expect(inputValues.some((v) => v === 'val')).toBe(true)

    // authHeader Switch（data-testid="auth-header-switch"）checked
    const authSwitch = document.body.querySelector('[data-testid="auth-header-switch"]')
    expect(authSwitch).toBeTruthy()
    expect(authSwitch!.getAttribute('data-state')).toBe('checked')
  })

  it('改 headers 值后 save → config.setProvider payload 含 headers（非空）+ authHeader', async () => {
    wrapper = mount(ProviderEditModal, {
      props: { open: true, provider: providerWithHeaders() },
      attachTo: document.body,
    })
    await flushPromises()

    // 改 headers value 输入（val → newval）。通过 native input 派发 input 事件触发 v-model
    // （teleport 后的元素经 setValue 不可靠，直接 dispatch 更稳）。
    const headersEditor = document.body.querySelector('[data-testid="headers-editor"]')!
    const valueInput = Array.from(headersEditor.querySelectorAll('input')).find(
      (i) => (i as HTMLInputElement).value === 'val',
    ) as HTMLInputElement
    expect(valueInput).toBeTruthy()
    // 用原生 setter 触发 v-model（reka-ui Input 包了一层，直接 setValue 可能丢事件）
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(valueInput, 'newval')
    valueInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    // 点保存
    const saveBtn = Array.from(document.body.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('保存') && !b.textContent?.includes('保存中')) as HTMLButtonElement
    expect(saveBtn).toBeTruthy()
    saveBtn!.click()
    await flushPromises()

    expect(configMock.setProvider).toHaveBeenCalledTimes(1)
    const [, data] = configMock.setProvider.mock.calls[0]
    expect(data.headers).toBeDefined()
    expect((data.headers as Record<string, string>)['X-Custom']).toBe('newval')
    expect(data.authHeader).toBe(true)
  })
})

// ── W3 · D8: 编辑弹窗过期快照刷新 ──
//
// 背景：弹窗打开期间若外部广播更新了同 provider（onProviders 整体替换 store.providers），
// 弹窗表单不刷新，保存会覆盖并发变更。W3 修复：watch store.providers，dirty=false 时刷新快照。
describe('W3 D8: 编辑弹窗过期快照刷新', () => {
  it('打开弹窗未手动改 → 外部更新 provider.baseUrl → form.baseUrl 刷新到新值', async () => {
    const { useSettingsStore } = await import('@/stores/settings')
    const store = useSettingsStore()
    const initialProvider: ProviderInfo = {
      id: 'anthropic',
      name: 'Anthropic',
      api: 'anthropic-messages',
      baseUrl: 'https://old.anthropic.com',
      apiKeySet: true,
      status: 'connected',
      enabled: true,
      models: [{ id: 'claude', name: 'Claude', contextWindow: 200_000, input: ['text'] }],
    } as ProviderInfo
    store.providers = [initialProvider]

    wrapper = mount(ProviderEditModal, {
      props: { open: true, provider: initialProvider },
      attachTo: document.body,
    })
    await flushPromises()

    // 初始 baseUrl 快照 = old
    const vm = wrapper.vm as unknown as { form: { baseUrl: string } }
    expect(vm.form.baseUrl).toBe('https://old.anthropic.com')

    // 模拟外部广播：store.providers 整体替换，同 provider 的 baseUrl 变了
    store.providers = [{ ...initialProvider, baseUrl: 'https://new.anthropic.com' }]
    await wrapper.vm.$nextTick()
    await flushPromises()

    // form.baseUrl 刷新到新值（用户未手动改，dirty=false）
    expect(vm.form.baseUrl).toBe('https://new.anthropic.com')
  })

  it('用户手动改了字段 → 外部更新同 provider → form 不刷新（用户改动优先）', async () => {
    const { useSettingsStore } = await import('@/stores/settings')
    const store = useSettingsStore()
    const initialProvider: ProviderInfo = {
      id: 'anthropic',
      name: 'Anthropic',
      api: 'anthropic-messages',
      baseUrl: 'https://old.anthropic.com',
      apiKeySet: true,
      status: 'connected',
      enabled: true,
      models: [{ id: 'claude', name: 'Claude', contextWindow: 200_000, input: ['text'] }],
    } as ProviderInfo
    store.providers = [initialProvider]

    wrapper = mount(ProviderEditModal, {
      props: { open: true, provider: initialProvider },
      attachTo: document.body,
    })
    await flushPromises()

    // 用户手动改 name（dirty=true）。name input 是第一个 input（placeholder=My Provider），
    // 在 teleport 的 DialogContent 内，用 document.body 查 + 原生 setter 触发 v-model。
    const nameInput = Array.from(document.body.querySelectorAll('input')).find(
      (i) => (i as HTMLInputElement).placeholder === 'My Provider',
    ) as HTMLInputElement
    expect(nameInput).toBeTruthy()
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(nameInput, 'My Edited Name')
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    // 外部广播更新 baseUrl
    store.providers = [{ ...initialProvider, baseUrl: 'https://new.anthropic.com' }]
    await wrapper.vm.$nextTick()
    await flushPromises()

    // form.baseUrl 不刷新（dirty，用户改动优先）
    const vm = wrapper.vm as unknown as { form: { baseUrl: string; name: string } }
    expect(vm.form.baseUrl).toBe('https://old.anthropic.com')
    expect(vm.form.name).toBe('My Edited Name')
  })
})
