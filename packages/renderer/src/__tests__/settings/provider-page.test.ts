/**
 * ProviderPage 渲染测试（W9 + W4）。
 *
 * 覆盖：
 *  - 首屏冒烟：providers=[] → 渲染「添加供应商」按钮 + 空状态。
 *  - 打开 dialog：点击添加按钮 → ProviderEditModal 内容 teleport 到 document.body。
 *  - U5（W4）：默认模型标记从 settingsStore.defaultModel 派生（"provider/modelId" 复合串解析），
 *    不再是本地硬编码 ref。改 store.defaultModel 后默认标记跟随切换。
 *  - U5b（W4）：点击 model 行「设为默认」按钮 → 调 config.setDefaultModel(provider, modelId)。
 *
 * mock 策略：
 *  - vi.mock('@/api') 替换 config 门面（setProvider/deleteProvider/listProviders/setDefaultModel
 *    等动作 + onProviders 订阅），避免调真实 transport 挂起。
 *  - reka-ui DialogContent teleport 到 body，dialog 文本在 document.body 上查询。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/settings/provider-page.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ProviderInfo } from '@xyz-agent/shared'
import { useSettingsStore } from '@/stores/settings'

/** vi.hoisted 保证 configMock 在 vi.mock 工厂执行前就绪。 */
const configMock = vi.hoisted(() => ({
  onProviders: vi.fn(() => () => {}),
  listProviders: vi.fn(async () => []),
  setProvider: vi.fn(async () => {}),
  deleteProvider: vi.fn(async () => {}),
  testProvider: vi.fn(async () => ({ ok: true })),
  discoverModels: vi.fn(async () => []),
  setDefaultModel: vi.fn(async () => {}),
}))

vi.mock('@/api', () => ({
  config: configMock,
  default: { config: configMock },
}))

import ProviderPage from '@/components/settings/ProviderPage.vue'

let wrapper: ReturnType<typeof mount> | null = null

/** 测试用 provider：anthropic 含 2 model，openai 含 1 model，均展开态可点「设为默认」 */
const PROVIDERS: ProviderInfo[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    api: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    apiKeySet: true,
    status: 'connected',
    enabled: true,
    models: [
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', contextWindow: 200_000, input: ['text', 'image'] },
      { id: 'claude-opus-4', name: 'Claude Opus 4', contextWindow: 200_000, input: ['text', 'image'] },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    api: 'openai-completions',
    baseUrl: 'https://api.openai.com/v1',
    apiKeySet: true,
    status: 'connected',
    enabled: true,
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128_000, input: ['text', 'image'] },
    ],
  },
]

beforeEach(() => {
  setActivePinia(createPinia())
  configMock.setDefaultModel.mockClear()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('ProviderPage 首屏冒烟', () => {
  it('providers=[] → 渲染「添加供应商」按钮 + 空状态文案', async () => {
    wrapper = mount(ProviderPage, { props: { providers: [] } })
    await flushPromises()
    const addBtn = wrapper.findAll('button').find((b) => b.text().includes('添加供应商'))
    expect(addBtn).toBeTruthy()
    expect(wrapper.text()).toContain('还没有供应商')
  })
})

describe('ProviderPage 打开 dialog', () => {
  it('点击添加供应商按钮 → dialog teleport 到 body 含「添加供应商」标题', async () => {
    wrapper = mount(ProviderPage, {
      props: { providers: [] },
      attachTo: document.body,
    })
    await flushPromises()
    // 关闭态：body 无 dialog 标题
    expect(document.body.textContent ?? '').not.toContain('配置供应商凭据与模型清单')

    const addBtn = wrapper.findAll('button').find((b) => b.text().includes('添加供应商'))!
    await addBtn.trigger('click')
    await flushPromises()

    // ProviderEditModal open=true → DialogContent teleport 到 body，标题为「添加供应商」（provider=null）
    const bodyText = document.body.textContent ?? ''
    expect(bodyText).toContain('添加供应商')
    // 模型清单标题也在 dialog 内
    expect(bodyText).toContain('模型清单')
  })
})

describe('ProviderPage 默认模型从 settingsStore.defaultModel 派生（U5）', () => {
  it('U5: store.defaultModel="anthropic/claude-sonnet-4" → 该 model 行显示「默认模型」标记，其它显示「设为默认」按钮', async () => {
    useSettingsStore().defaultModel = 'anthropic/claude-sonnet-4'
    wrapper = mount(ProviderPage, {
      props: { providers: PROVIDERS },
      attachTo: document.body,
    })
    await flushPromises()
    // 展开 anthropic 详情（点 provider 名称）让模型表格可见
    const name = wrapper.findAll('span').find((s) => s.text() === 'Anthropic')!
    await name.trigger('click')
    await flushPromises()

    const bodyText = document.body.textContent ?? ''
    // claude-sonnet-4 是默认 → 标记文案「默认模型」出现
    expect(bodyText).toContain('默认模型')
    // claude-opus-4 非默认 → 「设为默认」按钮出现（至少 1 个）
    expect(bodyText).toContain('设为默认')
  })

  it('U5b: 改 store.defaultModel 为 "openai/gpt-4o" → 默认标记跟随切换到 gpt-4o 行', async () => {
    useSettingsStore().defaultModel = 'anthropic/claude-sonnet-4'
    wrapper = mount(ProviderPage, {
      props: { providers: PROVIDERS },
      attachTo: document.body,
    })
    await flushPromises()
    // 展开 anthropic + openai
    const anthropicName = wrapper.findAll('span').find((s) => s.text() === 'Anthropic')!
    await anthropicName.trigger('click')
    const openaiName = wrapper.findAll('span').find((s) => s.text() === 'OpenAI')!
    await openaiName.trigger('click')
    await flushPromises()

    // 初始默认在 claude-sonnet-4：该行无「设为默认」按钮（显示「默认模型」span）
    let sonnetRow = wrapper.findAll('tr').find((r) => r.text().includes('claude-sonnet-4'))!
    expect(sonnetRow.text()).toContain('默认模型')
    let sonnetBtn = sonnetRow.findAll('button').find((b) => b.text().includes('设为默认'))
    expect(sonnetBtn).toBeUndefined()

    // 切默认到 openai/gpt-4o
    useSettingsStore().defaultModel = 'openai/gpt-4o'
    await wrapper.vm.$nextTick()
    await flushPromises()

    // claude-sonnet-4 现在非默认 → 显示「设为默认」按钮
    sonnetRow = wrapper.findAll('tr').find((r) => r.text().includes('claude-sonnet-4'))!
    expect(sonnetRow.text()).toContain('设为默认')
    // gpt-4o 现为默认 → 显示「默认模型」span
    const gptRow = wrapper.findAll('tr').find((r) => r.text().includes('gpt-4o'))!
    expect(gptRow.text()).toContain('默认模型')
  })

  it('U5c: 点击 model 行「设为默认」按钮 → 调 config.setDefaultModel(provider, modelId)', async () => {
    useSettingsStore().defaultModel = ''
    wrapper = mount(ProviderPage, {
      props: { providers: PROVIDERS },
      attachTo: document.body,
    })
    await flushPromises()
    // 展开 anthropic
    const name = wrapper.findAll('span').find((s) => s.text() === 'Anthropic')!
    await name.trigger('click')
    await flushPromises()

    // 找到 claude-sonnet-4 行的「设为默认」按钮（与模型 id 同行）
    const rows = wrapper.findAll('tr')
    const sonnetRow = rows.find((r) => r.text().includes('claude-sonnet-4'))
    expect(sonnetRow).toBeTruthy()
    const btn = sonnetRow!.findAll('button').find((b) => b.text().includes('设为默认'))
    expect(btn).toBeTruthy()
    await btn!.trigger('click')
    await flushPromises()

    // setDefaultModel 接收 (providerId, modelId)
    expect(configMock.setDefaultModel).toHaveBeenCalledWith('anthropic', 'claude-sonnet-4')
  })
})

/**
 * W1 robustness pass：
 *  - U1（D4）：toggle enabled 失败时 actionError 经常驻 inline error 区域可见（不再被困在关闭的删除弹窗内）。
 *  - U2（D5）：cycleThinking 死按钮已删除，thinking pill 改为 disabled 展示态。
 *  - D14：删除 / 禁用 defaultModel 归属 provider 时前端兜底清空 defaultModel（幂等，runtime 广播到达时覆盖）。
 */
describe('ProviderPage W1 robustness', () => {
  beforeEach(() => {
    configMock.setProvider.mockClear()
    configMock.deleteProvider.mockClear()
  })

  it('U1: toggle enabled 失败 → 常驻 inline error 区域可见并含错误文案', async () => {
    configMock.setProvider.mockRejectedValueOnce(new Error('网络错误'))
    wrapper = mount(ProviderPage, {
      props: { providers: PROVIDERS },
      attachTo: document.body,
    })
    await flushPromises()

    // 初始无错误
    expect(wrapper.find('[data-testid="provider-action-error"]').exists()).toBe(false)

    // 点 anthropic 的 enabled Switch（role=switch）
    const sw = wrapper.findAll('[role="switch"]')[0]
    await sw.trigger('click')
    await flushPromises()

    // 错误可见
    const err = wrapper.find('[data-testid="provider-action-error"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).toContain('网络错误')
  })

  it('U2: thinking pill 为 disabled 展示态（cycleThinking 死按钮已删除）', async () => {
    wrapper = mount(ProviderPage, {
      props: { providers: PROVIDERS },
      attachTo: document.body,
    })
    await flushPromises()
    // 展开 anthropic 让模型表格可见
    const name = wrapper.findAll('span').find((s) => s.text() === 'Anthropic')!
    await name.trigger('click')
    await flushPromises()

    const pill = wrapper.find('[data-testid="thinking-pill"]')
    expect(pill.exists()).toBe(true)
    // disabled 属性存在（值 '' 或空串，关键是 attributes('disabled') 非 undefined）
    expect(pill.attributes('disabled')).toBeDefined()
  })

  it('D14: 删除 defaultModel 归属 provider → 前端清空 defaultModel', async () => {
    const store = useSettingsStore()
    store.defaultModel = 'anthropic/claude-sonnet-4'
    configMock.deleteProvider.mockResolvedValueOnce(undefined)
    wrapper = mount(ProviderPage, {
      props: { providers: PROVIDERS },
      attachTo: document.body,
    })
    await flushPromises()

    // 点 anthropic 的删除按钮（trash）打开确认弹窗
    const trashBtns = wrapper.findAll('button[title="删除供应商"]')
    await trashBtns[0]!.trigger('click')
    await flushPromises()

    // 点「确认删除」（teleport 到 body）
    const confirmBtn = Array.from(document.body.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('确认删除')) as HTMLButtonElement | undefined
    expect(confirmBtn).toBeTruthy()
    confirmBtn!.click()
    await flushPromises()

    expect(configMock.deleteProvider).toHaveBeenCalledWith('anthropic')
    expect(store.defaultModel).toBe('')
  })
})

/**
 * W3 U5（D6）：model 级 enabled Switch。
 * 模型表格每行有 enabled Switch（data-testid="model-enabled-switch"），点击后乐观改 store +
 * 调 config.setProvider 持久化。setProvider 传完整 models 数组（runtime setProvider 整体替换 models）。
 */
describe('ProviderPage W3 model 级 enabled Switch（D6）', () => {
  beforeEach(() => {
    configMock.setProvider.mockClear()
  })

  it('U5: 展开 provider → 每个 model 行有 enabled Switch（data-testid="model-enabled-switch"）', async () => {
    wrapper = mount(ProviderPage, {
      props: { providers: PROVIDERS },
      attachTo: document.body,
    })
    await flushPromises()
    // 展开 anthropic
    const name = wrapper.findAll('span').find((s) => s.text() === 'Anthropic')!
    await name.trigger('click')
    await flushPromises()

    // anthropic 含 2 model → 2 个 model 级 Switch（与 provider 级 Switch 区分用 data-testid）
    const modelSwitches = wrapper.findAll('[data-testid="model-enabled-switch"]')
    expect(modelSwitches.length).toBe(2)
  })

  it('U5b: 点击某 model 的 enabled Switch → config.setProvider 被调用，payload 含完整 models 数组且目标 model enabled=false', async () => {
    wrapper = mount(ProviderPage, {
      props: { providers: PROVIDERS },
      attachTo: document.body,
    })
    await flushPromises()
    // 展开 anthropic
    const name = wrapper.findAll('span').find((s) => s.text() === 'Anthropic')!
    await name.trigger('click')
    await flushPromises()

    // 点第一个 model 的 enabled Switch
    const modelSwitches = wrapper.findAll('[data-testid="model-enabled-switch"]')
    await modelSwitches[0]!.trigger('click')
    await flushPromises()

    expect(configMock.setProvider).toHaveBeenCalledTimes(1)
    const [providerId, data] = configMock.setProvider.mock.calls[0]
    expect(providerId).toBe('anthropic')
    // models 数组完整（runtime 整体替换，不是单 model merge）
    expect(data.models).toHaveLength(2)
    // 被点的 model（第一个，claude-sonnet-4）enabled=false，另一个保持原值
    const sonnet = data.models.find((m: { id: string }) => m.id === 'claude-sonnet-4')
    const opus = data.models.find((m: { id: string }) => m.id === 'claude-opus-4')
    expect(sonnet.enabled).toBe(false)
    expect(opus.enabled).not.toBe(false)
  })
})
