/**
 * ProviderPage 导入入口测试（W2 · cw-2026-07-26-migration-other-agents）。
 *
 * 覆盖：
 * - T10：mount ProviderPage（空 providers），断言 import-providers-menu 渲染
 * - T10b：点击菜单项 → previewImportProviders 被调 + 对话框打开
 *
 * mock 策略：
 *  - vi.mock('@/api') 把 config 门面替成可控 mock（listProviders 空数组 + previewImportProviders fixture）
 *  - createPinia + setActivePinia 让 useSettingsStore/useQuotaStore 正常初始化
 *
 * 运行：cd packages/renderer && npx vitest run src/components/settings/__tests__/ProviderPage-import.spec.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ProviderImportPreview } from '@xyz-agent/shared'

/** preview fixture（1 个正常 provider） */
const PREVIEW: ProviderImportPreview = {
  source: 'claude',
  providers: [
    {
      id: 'openai', name: 'OpenAI', protocol: 'openai-completions', modelCount: 3,
      apiKeyExtracted: true, conflict: 'none', warnings: [],
    },
  ],
}

/** mock config 门面：previewImportProviders 返 fixture，applyImportProviders 返空结果 */
const configMock = vi.hoisted(() => ({
  listProviders: vi.fn(() => Promise.resolve([])),
  previewImportProviders: vi.fn(() => Promise.resolve({ importId: 'imp-1', preview: PREVIEW })),
  applyImportProviders: vi.fn(() => Promise.resolve({
    result: { source: 'claude', imported: [{ id: 'openai', name: 'OpenAI', status: 'imported' }], failedCount: 0 },
  })),
}))

vi.mock('@/api', () => ({
  config: configMock,
}))

import ProviderPage from '@/components/settings/ProviderPage.vue'

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  configMock.previewImportProviders.mockClear()
  configMock.applyImportProviders.mockClear()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('ProviderPage 导入入口', () => {
  it('T10: 空 providers 时 import-providers-menu 渲染', async () => {
    wrapper = mount(ProviderPage, {
      props: { providers: [] },
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="import-providers-menu"]').exists()).toBe(true)
  })

  it('T10b: 点击菜单项 claude → previewImportProviders 被调 + 对话框打开', async () => {
    wrapper = mount(ProviderPage, {
      props: { providers: [] },
    })
    await flushPromises()

    // 点菜单 trigger 展开 popover
    const trigger = wrapper.find('[data-testid="import-providers-menu"]')
    await trigger.trigger('click')
    await flushPromises()

    // 点 claude 源项
    const claudeItem = document.querySelector('[data-testid="import-source-claude"]') as HTMLElement | null
    expect(claudeItem).toBeTruthy()
    claudeItem!.click()
    await flushPromises()

    // previewImportProviders 以 'claude' 被调
    expect(configMock.previewImportProviders).toHaveBeenCalledWith('claude')
    // 对话框渲染：preview-provider-item（fixture 1 项）
    const items = document.querySelectorAll('[data-testid="preview-provider-item"]')
    expect(items.length).toBe(1)
  })
})
