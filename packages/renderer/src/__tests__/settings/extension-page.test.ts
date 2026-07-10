/**
 * ExtensionPage 渲染测试（W8）。
 *
 * 覆盖：
 *  - 首屏冒烟：user-installed 项渲染升级按钮 + 自动升级开关；built-in 项不渲染。
 *  - 升级交互：点击升级按钮 → extension.upgrade 被调。
 *
 * mock 策略：
 *  - vi.mock('@/api') 把 extension 门面替成可断言的 mock（fetchRecommended 空数组避免 onMounted 拉取报错；
 *    upgrade/setAutoUpgrade 捕获断言）。
 *  - ConfirmDialog 走 reka-ui Dialog，teleport 到 body；ExtensionPage 默认 open=false 不会渲染内容，
 *    故无需 stub。Switch/Checkbox/Label 等 ui 原语直接渲染。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/settings/extension-page.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ExtensionItem } from '@/stores/settings'

/** mock 捕获 extension.upgrade / setAutoUpgrade 调用。vi.hoisted 保证在 vi.mock 工厂执行前就绪。 */
const extensionMock = vi.hoisted(() => ({
  upgrade: vi.fn(() => Promise.resolve()),
  setAutoUpgrade: vi.fn(() => Promise.resolve()),
  fetchRecommended: vi.fn(() => Promise.resolve([])),
  onExtensions: vi.fn(() => () => {}),
  toggle: vi.fn(() => Promise.resolve()),
  install: vi.fn(() => Promise.resolve()),
  uninstall: vi.fn(() => Promise.resolve()),
}))

vi.mock('@/api', () => ({
  extension: extensionMock,
  default: { extension: extensionMock },
}))

import ExtensionPage from '@/components/settings/ExtensionPage.vue'

/** user-installed 扩展 fixture（source='user-installed'，应渲染升级按钮 + 自动升级开关） */
function userExt(): ExtensionItem {
  return {
    name: 'my-tools',
    dirName: 'my-tools',
    version: '1.0.0',
    description: 'user installed extension',
    path: '/exts/my-tools',
    enabled: true,
    source: 'user-installed',
    autoUpgrade: false,
    tools: ['tool-a'],
  }
}

/** built-in 扩展 fixture（source='built-in'，不应渲染升级按钮 / 自动升级开关） */
function builtinExt(): ExtensionItem {
  return {
    name: 'core',
    dirName: 'core',
    version: '0.1.0',
    description: 'built-in extension',
    path: '/exts/core',
    enabled: true,
    source: 'built-in',
    tools: [],
  }
}

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  extensionMock.upgrade.mockClear()
  extensionMock.setAutoUpgrade.mockClear()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('ExtensionPage 首屏冒烟', () => {
  it('user-installed 项渲染升级按钮，built-in 项不渲染', async () => {
    wrapper = mount(ExtensionPage, {
      props: { extensions: [userExt(), builtinExt()] },
    })
    await flushPromises()
    // 升级按钮带 title="升级"（仅 user-installed）
    const upgradeBtns = wrapper.findAll('button[title="升级"]')
    expect(upgradeBtns.length).toBe(1)
    // 卸载按钮两者都有（确认 user 与 built-in 都渲染了行）
    const uninstallBtns = wrapper.findAll('button[title="卸载"]')
    expect(uninstallBtns.length).toBe(2)
  })

  it('自动升级开关：user-installed 项含「自动升级」label，built-in 不含', async () => {
    wrapper = mount(ExtensionPage, {
      props: { extensions: [userExt(), builtinExt()] },
    })
    await flushPromises()
    // 「自动升级」文本仅在 user-installed 行出现一次
    const autoLabels = wrapper.findAll('span').filter((s) => s.text() === '自动升级')
    expect(autoLabels.length).toBe(1)
  })
})

describe('ExtensionPage 升级交互', () => {
  it('点击升级按钮 → extension.upgrade 被调用', async () => {
    wrapper = mount(ExtensionPage, {
      props: { extensions: [userExt()] },
    })
    await flushPromises()
    const upgradeBtn = wrapper.find('button[title="升级"]')
    expect(upgradeBtn.exists()).toBe(true)
    await upgradeBtn.trigger('click')
    await flushPromises()
    expect(extensionMock.upgrade).toHaveBeenCalledTimes(1)
    expect(extensionMock.upgrade).toHaveBeenCalledWith('my-tools')
  })
})
