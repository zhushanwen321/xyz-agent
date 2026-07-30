/**
 * ExtensionPage mandatory 扩展 UI 测试。
 *
 * 覆盖：
 *  - mandatory 扩展显示「内置」badge
 *  - mandatory 扩展隐藏卸载/disable/升级/autoUpgrade 按钮
 *  - 非 mandatory 扩展不受影响
 *
 * mock 策略：
 *  - vi.mock('@/api') 把 extension 门面替成可断言的 mock（fetchRecommended 空数组避免 onMounted 拉取报错）。
 *  - i18n 由 vitest-i18n-setup.ts 全局 mock（从 zh-CN locale 取值），故 mandatoryBadge 渲染为「内置」。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/settings/extension-page-mandatory.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ExtensionItem } from '@/stores/settings'

const extensionMock = vi.hoisted(() => ({
  fetchRecommended: vi.fn(() => Promise.resolve([])),
  onExtensions: vi.fn(() => () => {}),
  toggle: vi.fn(() => Promise.resolve()),
  install: vi.fn(() => Promise.resolve()),
  installDir: vi.fn(() => Promise.resolve()),
  installGitRepository: vi.fn(() => Promise.resolve()),
  cancelInstall: vi.fn(() => Promise.resolve()),
  finishInstall: vi.fn(() => Promise.resolve()),
  uninstall: vi.fn(() => Promise.resolve()),
  upgrade: vi.fn(() => Promise.resolve()),
  setAutoUpgrade: vi.fn(() => Promise.resolve()),
}))

vi.mock('@/api', () => ({
  extension: extensionMock,
  default: { extension: extensionMock },
}))

import ExtensionPage from '@/components/settings/ExtensionPage.vue'
import { useToast } from '@/composables/useToast'

/** mandatory 扩展 fixture（强制安装，不可卸载/禁用，应显示内置 badge 且隐藏操作按钮） */
function mandatoryExt(): ExtensionItem {
  return {
    name: '@zhushanwen/pi-goal',
    dirName: 'pi-goal',
    version: '0.5.0',
    description: 'goal extension',
    path: '/exts/pi-goal',
    enabled: true,
    source: 'user-installed',
    autoUpgrade: true,
    mandatory: true,
    tools: [],
  }
}

/** 非 mandatory 扩展 fixture（应保留全部操作按钮） */
function normalExt(): ExtensionItem {
  return {
    name: 'my-tools',
    dirName: 'my-tools',
    version: '1.0.0',
    description: 'normal extension',
    path: '/exts/my-tools',
    enabled: true,
    source: 'user-installed',
    autoUpgrade: false,
    tools: ['tool-a'],
  }
}

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  // 清空全局 toasts（useToast 是模块级单例，跨用例共享）
  const { toasts } = useToast()
  toasts.value = []
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

/**
 * 定位某扩展名对应的「已安装项」根 div。
 * 已安装项根 div 的 class 含 flex items-center gap-3 rounded-md border，文本含 ext.name。
 */
function findExtRow(root: ReturnType<typeof mount>, name: string) {
  const rows = root.findAll('div.flex.items-center.gap-3.rounded-md.border')
  return rows.find((r) => r.text().includes(name))
}

describe('ExtensionPage mandatory UI', () => {
  it('mandatory 扩展显示「内置」badge', async () => {
    wrapper = mount(ExtensionPage, { props: { extensions: [mandatoryExt()] } })
    await flushPromises()
    const row = findExtRow(wrapper!, '@zhushanwen/pi-goal')
    expect(row).toBeTruthy()
    expect(row!.text()).toContain('内置')
  })

  it('mandatory 扩展隐藏卸载按钮', async () => {
    wrapper = mount(ExtensionPage, { props: { extensions: [mandatoryExt()] } })
    await flushPromises()
    const row = findExtRow(wrapper!, '@zhushanwen/pi-goal')
    expect(row).toBeTruthy()
    expect(row!.findAll('button[title="卸载"]')).toHaveLength(0)
  })

  it('mandatory 扩展隐藏 disable 开关', async () => {
    wrapper = mount(ExtensionPage, { props: { extensions: [mandatoryExt()] } })
    await flushPromises()
    const row = findExtRow(wrapper!, '@zhushanwen/pi-goal')
    expect(row).toBeTruthy()
    // enable/disable Switch 渲染为 button[role="switch"]；autoUpgrade Switch 已被 v-if 隐藏
    expect(row!.findAll('button[role="switch"]')).toHaveLength(0)
  })

  it('mandatory 扩展隐藏升级按钮和自动升级开关', async () => {
    wrapper = mount(ExtensionPage, { props: { extensions: [mandatoryExt()] } })
    await flushPromises()
    const row = findExtRow(wrapper!, '@zhushanwen/pi-goal')
    expect(row).toBeTruthy()
    expect(row!.findAll('button[title="升级"]')).toHaveLength(0)
    // 「自动升级」文本仅在 autoUpgrade Switch 行出现，mandatory 应隐藏
    expect(row!.text()).not.toContain('自动升级')
  })

  it('非 mandatory 扩展仍显示全部操作按钮', async () => {
    wrapper = mount(ExtensionPage, { props: { extensions: [normalExt()] } })
    await flushPromises()
    const row = findExtRow(wrapper!, 'my-tools')
    expect(row).toBeTruthy()
    expect(row!.findAll('button[title="卸载"]')).toHaveLength(1)
    expect(row!.findAll('button[title="升级"]')).toHaveLength(1)
    // enable Switch + autoUpgrade Switch = 2 个
    expect(row!.findAll('button[role="switch"]')).toHaveLength(2)
    expect(row!.text()).toContain('自动升级')
    // 非 mandatory 不显示内置 badge
    expect(row!.text()).not.toContain('内置')
  })

  it('推荐区为空时不渲染（recommended v-if=false）', async () => {
    // fetchRecommended 默认 resolve([]) → recommended.length === 0 → section 不渲染
    wrapper = mount(ExtensionPage, { props: { extensions: [] } })
    await flushPromises()
    expect(extensionMock.fetchRecommended).toHaveBeenCalled()
    // 推荐区标题「推荐扩展」不应出现在 DOM
    expect(wrapper!.text()).not.toContain('推荐扩展')
  })
})
