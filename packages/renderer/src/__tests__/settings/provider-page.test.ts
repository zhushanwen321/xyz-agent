/**
 * ProviderPage 渲染测试（W9 + W4 + R4 手风琴就地编辑）。
 *
 * 覆盖：
 *  - 首屏冒烟：providers=[] → 渲染「添加供应商」按钮 + 空状态。
 *  - R4：点击添加 → 不弹 Dialog，列表底部新建合成行并展开（provider-expand-body 渲染）。
 *  - R4：点击供应商名称 → 行内展开就地编辑体（无 Dialog teleport）。
 *  - U5（W4）：默认模型标记从 settingsStore.defaultModel 派生。
 *
 * mock 策略：
 *  - vi.mock('@/api') 替换 config 门面。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/settings/provider-page.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ProviderInfo } from '@xyz-agent/shared'
import { getSettingsStore, __resetSettingsStoreForTesting } from '@xyz-agent/core'

const configMock = vi.hoisted(() => ({
  onProviders: vi.fn(() => () => {}),
  listProviders: vi.fn(async () => []),
  setProvider: vi.fn(async () => {}),
  deleteProvider: vi.fn(async () => {}),
  testProvider: vi.fn(async () => ({ ok: true })),
  discoverModels: vi.fn(async () => ({ success: true, models: [] })),
  setDefaultModel: vi.fn(async () => {}),
}))

vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  config: configMock,
  default: { config: configMock },
}))

import ProviderPage from '@/components/settings/provider/ProviderPage.vue'

let wrapper: ReturnType<typeof mount> | null = null

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
  __resetSettingsStoreForTesting()
  configMock.setProvider.mockClear()
  configMock.deleteProvider.mockClear()
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

describe('ProviderPage R4 手风琴就地编辑（取代 ProviderEditModal）', () => {
  it('点击「添加供应商」→ 菜单选「自定义」→ 列表底部新建合成行并展开就地编辑体', async () => {
    wrapper = mount(ProviderPage, {
      props: { providers: [] },
      attachTo: document.body,
    })
    await flushPromises()

    // 初始无展开体
    expect(wrapper.find('[data-testid="provider-expand-body"]').exists()).toBe(false)

    // F2：入口聚合为「+ 添加供应商 ▾」菜单，先点 trigger 打开菜单，再点「自定义」条目
    const addBtn = wrapper.findAll('button').find((b) => b.text().includes('添加供应商'))!
    await addBtn.trigger('click')
    await flushPromises()
    const customItem = document.body.querySelector<HTMLElement>('[data-testid="add-menu-custom"]')
    expect(customItem).toBeTruthy()
    customItem!.click()
    await flushPromises()

    // 合成行渲染 + 展开体渲染（就地编辑，非 Dialog teleport）
    const expandBody = wrapper.find('[data-testid="provider-expand-body"]')
    expect(expandBody.exists()).toBe(true)
    // 名称 input 存在（ProviderEditBody 首字段）
    expect(wrapper.find('[data-testid="provider-edit-name"]').exists()).toBe(true)
    // body 里不应出现 Dialog（无 [role="dialog"]）
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('点击供应商名称 → 行内展开就地编辑体（凭据字段可见，不弹 Dialog）', async () => {
    wrapper = mount(ProviderPage, {
      props: { providers: PROVIDERS },
      attachTo: document.body,
    })
    await flushPromises()

    // 初始无展开
    expect(wrapper.find('[data-testid="provider-expand-body"]').exists()).toBe(false)

    const name = wrapper.findAll('span').find((s) => s.text() === 'Anthropic')!
    await name.trigger('click')
    await flushPromises()

    // 展开体渲染
    expect(wrapper.find('[data-testid="provider-expand-body"]').exists()).toBe(true)
    // 凭据字段（名称 input）可见
    expect(wrapper.find('[data-testid="provider-edit-name"]').exists()).toBe(true)
    // 无 Dialog teleport
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('再次点击已展开供应商名称 → 收起展开体', async () => {
    wrapper = mount(ProviderPage, {
      props: { providers: PROVIDERS },
      attachTo: document.body,
    })
    await flushPromises()

    const name = wrapper.findAll('span').find((s) => s.text() === 'Anthropic')!
    await name.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="provider-expand-body"]').exists()).toBe(true)

    // 再次点击收起
    await name.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="provider-expand-body"]').exists()).toBe(false)
  })
})

describe('ProviderPage 默认模型从 settingsStore.defaultModel 派生（U5）', () => {
  it('U5: store.defaultModel 归属 provider → 行头显示「默认供应商」pill', async () => {
    getSettingsStore().defaultModel.value = 'anthropic/claude-sonnet-4'
    wrapper = mount(ProviderPage, {
      props: { providers: PROVIDERS },
      attachTo: document.body,
    })
    await flushPromises()

    // anthropic 行头显示默认 pill（行头常驻，不需展开）
    expect(wrapper.text()).toContain('默认供应商')
  })

  it('U5b: 改 store.defaultModel 到 openai → 默认 pill 跟随切换到 openai 行', async () => {
    getSettingsStore().defaultModel.value = 'anthropic/claude-sonnet-4'
    wrapper = mount(ProviderPage, {
      props: { providers: PROVIDERS },
      attachTo: document.body,
    })
    await flushPromises()
    // 默认 pill 出现在 anthropic 行
    const cards = wrapper.findAll('[data-testid="provider-card"]')
    expect(cards[0]!.text()).toContain('默认供应商')

    // 切默认到 openai/gpt-4o
    getSettingsStore().defaultModel.value = 'openai/gpt-4o'
    await wrapper.vm.$nextTick()
    await flushPromises()

    const cardsAfter = wrapper.findAll('[data-testid="provider-card"]')
    expect(cardsAfter[0]!.text()).not.toContain('默认供应商')
    expect(cardsAfter[1]!.text()).toContain('默认供应商')
  })
})

/**
 * W1 robustness pass：
 *  - U1（D4）：toggle enabled 失败时 actionError 经常驻 inline error 区域可见。
 *  - D14：删除 defaultModel 归属 provider 时前端兜底清空 defaultModel。
 */
describe('ProviderPage W1 robustness', () => {
  it('U1: toggle enabled 失败 → 常驻 inline error 区域可见并含错误文案', async () => {
    configMock.setProvider.mockRejectedValueOnce(new Error('网络错误'))
    wrapper = mount(ProviderPage, {
      props: { providers: PROVIDERS },
      attachTo: document.body,
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="provider-action-error"]').exists()).toBe(false)

    const sw = wrapper.findAll('[role="switch"]')[0]
    await sw.trigger('click')
    await flushPromises()

    const err = wrapper.find('[data-testid="provider-action-error"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).toContain('网络错误')
  })

  it('D14: 删除 defaultModel 归属 provider → 前端清空 defaultModel', async () => {
    const store = getSettingsStore()
    store.defaultModel.value = 'anthropic/claude-sonnet-4'
    configMock.deleteProvider.mockResolvedValueOnce(undefined)
    wrapper = mount(ProviderPage, {
      props: { providers: PROVIDERS },
      attachTo: document.body,
    })
    await flushPromises()

    const trashBtns = wrapper.findAll('button[title="删除供应商"]')
    await trashBtns[0]!.trigger('click')
    await flushPromises()

    const confirmBtn = Array.from(document.body.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('确认删除')) as HTMLButtonElement | undefined
    expect(confirmBtn).toBeTruthy()
    confirmBtn!.click()
    await flushPromises()

    expect(configMock.deleteProvider).toHaveBeenCalledWith('anthropic')
    expect(store.defaultModel.value).toBe('')
  })
})
