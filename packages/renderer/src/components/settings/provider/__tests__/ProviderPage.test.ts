/**
 * ProviderPage wave4 测试（provider-dual-system-r2::provider-ui-by-kind）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/beforeEach/afterEach/vi，禁 node:test）。
 * 运行命令：cd packages/renderer && npx vitest run src/components/settings/provider/__tests__/ProviderPage.test.ts
 *
 * 覆盖 design TC1/TC4/TC5：
 *   - TC1（unit）：onToggleEnabled 走 config.toggleProviderEnabled（wave3 RPC），不再 setProvider({enabled})。
 *   - TC4 渲染 gate（manual 的自动化补充）：catalog provider 卡片渲染 + 展开编辑体存在 + kind 透传给 ProviderEditBody。
 *   - TC5（manual 的自动化补充）：删除按钮 testid/title 按差异收窄（catalog=移除/custom=删除）+ 确认弹窗文案。
 *
 * mock 策略（对齐 ProviderPage-import.spec.ts）：
 *   - vi.mock('@/api') 把 config 门面替成可控 mock（toggleProviderEnabled/removeProviderByKind/listBuiltinProviders + auth 事件订阅）
 *   - createPinia + setActivePinia 让 useQuotaStore / settingsStore 正常初始化
 *   - global.stubs 把 ProviderEditBody / ProviderQuickSetup 等 ui 包重组件 stub 掉，避免触发 useProviderEdit /
 *     useProviderOAuth 等重组件依赖（聚焦 ProviderPage 本身行为，子组件端到端验证留手工 TC4/TC5）
 *   - ConfirmDialog/OAuthDialog stub 掉避免 Teleport 污染 body
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ProviderInfo } from '@xyz-agent/shared'

/** catalog provider fixture（wave2 聚合层已标 kind='catalog'） */
const CATALOG_P: ProviderInfo = {
  id: 'openai',
  name: 'OpenAI',
  apiKeySet: true,
  status: 'connected',
  enabled: true,
  models: [{ id: 'gpt-4o', name: 'GPT-4o' }],
  kind: 'catalog',
  hasOverride: false,
}

/** custom provider fixture */
const CUSTOM_P: ProviderInfo = {
  id: 'my-custom',
  name: 'My Custom',
  apiKeySet: true,
  status: 'connected',
  enabled: true,
  models: [{ id: 'custom-model', name: 'Custom Model' }],
  kind: 'custom',
}

/** mock config 门面：toggleProviderEnabled / removeProviderByKind / listBuiltinProviders + auth 事件订阅 */
const configMock = vi.hoisted(() => ({
  listBuiltinProviders: vi.fn(() => Promise.resolve([])),
  toggleProviderEnabled: vi.fn(() => Promise.resolve()),
  removeProviderByKind: vi.fn(() => Promise.resolve()),
  // 防止 useProviderOAuth onMounted 订阅 4 个 auth.* 事件缺方法报错
  onAuthDeviceCode: vi.fn(() => () => {}),
  onAuthAuthUrl: vi.fn(() => () => {}),
  onAuthSuccess: vi.fn(() => () => {}),
  onAuthError: vi.fn(() => () => {}),
}))

vi.mock('@/api', () => ({
  config: configMock,
}))

import ProviderPage from '@/components/settings/provider/ProviderPage.vue'
import { Switch } from '@/components/ui/switch'

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  configMock.toggleProviderEnabled.mockClear()
  configMock.removeProviderByKind.mockClear()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

/** mount 辅助：providers + 全局 stub 掉 ui 重组件 + ConfirmDialog（避免 Teleport 污染） */
function mountPage(providers: ProviderInfo[]): ReturnType<typeof mount> {
  return mount(ProviderPage, {
    props: { providers },
    global: {
      stubs: {
        // ProviderEditBody stub：捕获 provider prop（验证 kind 透传），渲染标记 testid
        ProviderEditBody: {
          name: 'ProviderEditBody',
          props: ['provider'],
          template: '<div data-testid="provider-edit-body-stub">{{ provider?.kind ?? "new" }}</div>',
        },
        ProviderImportMenu: { template: '<div />' },
        ProviderTemplatePicker: { template: '<div />' },
        ProviderImportPreviewDialog: { template: '<div />' },
        ProviderQuickSetup: { template: '<div />' },
        OAuthDialog: { template: '<div />' },
        ConfirmDialog: {
          name: 'ConfirmDialog',
          props: ['open', 'title', 'description', 'confirmText', 'cancelText', 'variant', 'loading'],
          emits: ['update:open', 'confirm'],
          template: '<div v-if="open" data-testid="confirm-dialog-stub"><span data-testid="dialog-title">{{ title }}</span><button data-testid="dialog-confirm" @click="$emit(\'confirm\')">ok</button></div>',
        },
      },
    },
  })
}

/** 找到指定 provider id 的 Switch 组件并触发 update:modelValue */
function emitToggle(providerId: string, enabled: boolean): void {
  const propsProviders = wrapper!.props('providers') as ProviderInfo[]
  const realIdx = propsProviders.findIndex(p => p.id === providerId)
  expect(realIdx).toBeGreaterThan(-1)
  const switches = wrapper!.findAllComponents(Switch)
  // Switch 按 renderList 顺序与 props.providers 对齐（NEW_ID 合成行无 Switch——v-if p.id !== NEW_ID）。
  // 非 NEW_ID 态下 renderList === props.providers，索引一致。
  expect(switches[realIdx]).toBeTruthy()
  void switches[realIdx].vm.$emit('update:modelValue', enabled)
}

// ══ TC1: onToggleEnabled 走 config.toggleProviderEnabled（wave3 RPC） ══════════════════

describe('TC1: onToggleEnabled 走 config.toggleProviderEnabled（不再 setProvider({enabled})）', () => {
  it('Switch toggle off → 调 config.toggleProviderEnabled(id, false)', async () => {
    wrapper = mountPage([CATALOG_P])
    await flushPromises()

    emitToggle('openai', false)
    await flushPromises()

    expect(configMock.toggleProviderEnabled).toHaveBeenCalledWith('openai', false)
    expect(configMock.toggleProviderEnabled).toHaveBeenCalledTimes(1)
  })

  it('Switch toggle on → 调 config.toggleProviderEnabled(id, true)', async () => {
    wrapper = mountPage([CATALOG_P])
    await flushPromises()

    emitToggle('openai', true)
    await flushPromises()

    expect(configMock.toggleProviderEnabled).toHaveBeenCalledWith('openai', true)
  })

  it('渲染 gate：provider-card + Switch 存在于 DOM（非纯内部断言）', async () => {
    wrapper = mountPage([CATALOG_P])
    await flushPromises()

    expect(wrapper.find('[data-testid="provider-card"]').exists()).toBe(true)
    expect(wrapper.findComponent(Switch).exists()).toBe(true)
  })

  it('防双击：toggling 中的 provider 再次 toggle 不重复调 RPC', async () => {
    wrapper = mountPage([CATALOG_P])
    await flushPromises()

    // 第一次 toggle（同步进入 toggling 集合）
    emitToggle('openai', false)
    emitToggle('openai', true) // toggling.has('openai') === true，直接 return
    await flushPromises()

    expect(configMock.toggleProviderEnabled).toHaveBeenCalledTimes(1)
  })
})

// ══ TC4 渲染 gate: catalog provider 卡片 + 展开编辑体 + kind 透传 ══════════════════════

describe('TC4 渲染 gate: catalog provider 展开 → ProviderEditBody 收到 kind（透传供其收窄 models 编辑区）', () => {
  it('catalog provider 卡片渲染（含 Switch / 删除按钮 / models 计数）', async () => {
    wrapper = mountPage([CATALOG_P])
    await flushPromises()

    const card = wrapper.find('[data-testid="provider-card"]')
    expect(card.exists()).toBe(true)
    expect(card.findComponent(Switch).exists()).toBe(true)
    // models 计数渲染（1 模型）
    expect(card.text()).toContain('1')
  })

  it('点击 provider 名称展开 → provider-expand-body 渲染 + ProviderEditBody 收到 kind="catalog"', async () => {
    wrapper = mountPage([CATALOG_P])
    await flushPromises()

    // 点击名称触发 toggleExpand（role=button 的 span）
    const nameBtn = wrapper.find('[role="button"][aria-expanded="false"]')
    expect(nameBtn.exists()).toBe(true)
    await nameBtn.trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="provider-expand-body"]').exists()).toBe(true)
    // stub 渲染了 provider.kind（catalog）
    expect(wrapper.find('[data-testid="provider-edit-body-stub"]').text()).toBe('catalog')
  })
})

// ══ TC5: 删除/移除按钮 testid/title + 确认弹窗文案按差异收窄 ════════════════════════════

describe('TC5: 删除/移除按钮 + 确认弹窗文案按 ProviderInfo.kind 收窄', () => {
  it('catalog provider → 删除按钮 testid=provider-remove-btn + title=移除', async () => {
    wrapper = mountPage([CATALOG_P])
    await flushPromises()

    const removeBtn = wrapper.find('[data-testid="provider-remove-btn"]')
    expect(removeBtn.exists()).toBe(true)
    expect(removeBtn.attributes('title')).toBe('移除供应商')
    // custom 的 delete-btn 不应存在
    expect(wrapper.find('[data-testid="provider-delete-btn"]').exists()).toBe(false)
  })

  it('custom provider → 删除按钮 testid=provider-delete-btn + title=删除', async () => {
    wrapper = mountPage([CUSTOM_P])
    await flushPromises()

    const deleteBtn = wrapper.find('[data-testid="provider-delete-btn"]')
    expect(deleteBtn.exists()).toBe(true)
    expect(deleteBtn.attributes('title')).toBe('删除供应商')
    expect(wrapper.find('[data-testid="provider-remove-btn"]').exists()).toBe(false)
  })

  it('catalog 点击删除按钮 → 弹窗渲染移除文案', async () => {
    wrapper = mountPage([CATALOG_P])
    await flushPromises()

    await wrapper.find('[data-testid="provider-remove-btn"]').trigger('click')
    await flushPromises()

    const dialog = wrapper.find('[data-testid="confirm-dialog-stub"]')
    expect(dialog.exists()).toBe(true)
    expect(dialog.find('[data-testid="dialog-title"]').text()).toContain('移除')
  })

  it('custom 点击删除按钮 → 弹窗渲染删除文案', async () => {
    wrapper = mountPage([CUSTOM_P])
    await flushPromises()

    await wrapper.find('[data-testid="provider-delete-btn"]').trigger('click')
    await flushPromises()

    const dialog = wrapper.find('[data-testid="confirm-dialog-stub"]')
    expect(dialog.exists()).toBe(true)
    expect(dialog.find('[data-testid="dialog-title"]').text()).toContain('删除')
  })

  it('catalog 弹窗确认 → 调 removeProviderByKind(id, "catalog")', async () => {
    wrapper = mountPage([CATALOG_P])
    await flushPromises()

    await wrapper.find('[data-testid="provider-remove-btn"]').trigger('click')
    await flushPromises()

    await wrapper.find('[data-testid="dialog-confirm"]').trigger('click')
    await flushPromises()

    expect(configMock.removeProviderByKind).toHaveBeenCalledWith('openai', 'catalog')
  })

  it('custom 弹窗确认 → 调 removeProviderByKind(id, "custom")', async () => {
    wrapper = mountPage([CUSTOM_P])
    await flushPromises()

    await wrapper.find('[data-testid="provider-delete-btn"]').trigger('click')
    await flushPromises()

    await wrapper.find('[data-testid="dialog-confirm"]').trigger('click')
    await flushPromises()

    expect(configMock.removeProviderByKind).toHaveBeenCalledWith('my-custom', 'custom')
  })
})
