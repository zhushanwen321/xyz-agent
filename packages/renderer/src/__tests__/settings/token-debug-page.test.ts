/**
 * TokenDebugPage 冒烟测试（MF-2）。
 *
 * 覆盖（首屏渲染 gate + 三条主路径）：
 *  - 首屏渲染：h1/subtitle/GroupCard title 文案命中 locale 值（非 raw key），回归 MF-1 的 i18n
 *    key path bug（缺 `menu.` 中缀会渲染成 raw key 字符串 `settings.tokenDebug`）。
 *  - 渲染 6 个太极主题按钮 + 4 个字体档位按钮。
 *  - 主题切换：点击黛蓝主题 → data-theme / data-theme-preset 写入 :root。
 *  - 字体档位：点击「偏大」→ --font-scale-u=1.08 写入 :root。
 *  - resetAll 清理：unmount 触发 onUnmounted → resetAll → 清除本页 inline override。
 *
 * mock 策略：
 *  - i18n 经 vitest-i18n-setup 全局 mock useI18n，t() 从 zh-CN locale 解析（key 不命中返回原 key）。
 *  - GroupCard / applySystemToDom / useTaijiThemes 真实模块（纯展示 + DOM 副作用，happy-dom 支持）。
 *  - getSettingsStore 真实模块（纯数据单例，DEFAULT_SYSTEM.theme='dark' 不走 matchMedia）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/settings/token-debug-page.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import TokenDebugPage from '@/components/settings/system/TokenDebugPage.vue'
import { TAIJI_THEMES } from '@/composables/useTaijiThemes'

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  // 清理可能残留的 inline CSS 变量 / data-* 属性（跨用例隔离）
  const root = document.documentElement
  root.style.removeProperty('--font-scale-u')
  root.style.removeProperty('--accent')
  root.removeAttribute('data-theme')
  root.removeAttribute('data-theme-preset')
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  document.documentElement.style.removeProperty('--font-scale-u')
})

describe('TokenDebugPage 渲染 gate（回归 MF-1 i18n key path）', () => {
  it('首屏渲染：h1/subtitle/GroupCard title 文案命中 locale 值，无 raw key 泄漏', async () => {
    wrapper = mount(TokenDebugPage, { attachTo: document.body })
    await flushPromises()

    const html = document.body.innerHTML
    // MF-1 回归核心：文案必须命中 locale（补了 menu. 中缀），而非回退成 raw key 字符串
    expect(html).toContain('Token 调试') // settings.menu.tokenDebug
    expect(html).not.toContain('settings.menu.tokenDebug') // t() 命中后不应出现 key 字面量
    expect(html).not.toContain('settings.tokenDebug') // 旧错误路径也不应出现
    expect(html).toContain('实时调整') // settings.menu.tokenDebugPage.subtitle
    expect(html).toContain('预设主题') // settings.menu.tokenDebugPage.presetTitle
    expect(html).toContain('字体大小') // settings.menu.tokenDebugPage.fontTitle
    // h1 节点存在且文案正确
    const h1 = document.body.querySelector('h1')
    expect(h1).toBeTruthy()
    expect(h1!.textContent).toBe('Token 调试')
  })

  it('渲染 6 个太极主题按钮 + 4 个字体档位按钮', async () => {
    wrapper = mount(TokenDebugPage, { attachTo: document.body })
    await flushPromises()

    const html = document.body.innerHTML
    for (const th of TAIJI_THEMES) {
      expect(html).toContain(th.label)
    }
    // 字体档位（组件内 FONT_SCALES 的 name）
    expect(html).toContain('紧凑')
    expect(html).toContain('标准')
    expect(html).toContain('偏大')
    expect(html).toContain('大')
  })
})

describe('TokenDebugPage 主题切换路径', () => {
  it('点击黛蓝主题 → data-theme=dark / data-theme-preset=dailan 写入 :root', async () => {
    wrapper = mount(TokenDebugPage, { attachTo: document.body })
    await flushPromises()

    const dailan = TAIJI_THEMES.find((t) => t.label.includes('黛蓝'))!
    // 主题按钮是 UiButton 渲染出的 <button>，含该主题 label
    const buttons = Array.from(document.body.querySelectorAll('button'))
    const target = buttons.find((b) => (b.textContent ?? '').includes(dailan.label))!
    expect(target).toBeTruthy()
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(document.documentElement.getAttribute('data-theme')).toBe(dailan.theme)
    expect(document.documentElement.getAttribute('data-theme-preset')).toBe(dailan.preset)
  })
})

describe('TokenDebugPage 字体档位路径', () => {
  it('点击「偏大」档位 → --font-scale-u=1.08 写入 :root', async () => {
    wrapper = mount(TokenDebugPage, { attachTo: document.body })
    await flushPromises()

    const buttons = Array.from(document.body.querySelectorAll('button'))
    const target = buttons.find((b) => (b.textContent ?? '').includes('偏大'))!
    expect(target).toBeTruthy()
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(document.documentElement.style.getPropertyValue('--font-scale-u')).toBe('1.08')
  })
})

describe('TokenDebugPage resetAll 清理路径', () => {
  it('unmount 触发 onUnmounted → resetAll → 清除本页写入的 --font-scale-u', async () => {
    wrapper = mount(TokenDebugPage, { attachTo: document.body })
    await flushPromises()

    // 先写入字体档位 inline override
    const buttons = Array.from(document.body.querySelectorAll('button'))
    const target = buttons.find((b) => (b.textContent ?? '').includes('偏大'))!
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(document.documentElement.style.getPropertyValue('--font-scale-u')).toBe('1.08')

    // unmount 触发 onUnmounted → resetAll（清本页 inline override，不污染其他页面）
    wrapper!.unmount()
    wrapper = null
    expect(document.documentElement.style.getPropertyValue('--font-scale-u')).toBe('')
  })
})
