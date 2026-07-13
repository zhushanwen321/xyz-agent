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
