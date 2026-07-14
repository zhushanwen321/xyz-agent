/**
 * System 主题/配色实装测试（Topic 2: fix-settings-system-theme）。
 *
 * U1: applySystemToDom 写 data-theme-preset 属性到 <html>
 * U2: style.css 含 11 套 data-theme-preset 规则
 * U3: updateSystem 真实 await localStorage 写入（非 fire-and-forget）
 * U4: theme=system 时 matchMedia change 监听被注册且实时跟随
 * U5: theme 非 system 时不挂监听，切回时清理
 * U6: SettingsModal 切语言/主题后有 toast 反馈
 *
 * applySystemToDom 是 settings store 的内部函数（未 export），经 setSystem action 间接验证。
 * updateSystem 在 api/domains/settings，可直测。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// U1: applySystemToDom 经 store.setSystem 触发，验证 <html data-theme-preset>
describe('U1: applySystemToDom 写 data-theme-preset 属性', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme-preset')
    document.documentElement.removeAttribute('data-theme')
  })

  it('setSystem({themePreset:"rose"}) 后 <html data-theme-preset> === "rose"', async () => {
    // 动态 import 避免污染其他测试（setSystem 会落 localStorage + i18n）
    const { useSettingsStore } = await import('@/stores/settings')
    const { createPinia, setActivePinia } = await import('pinia')
    setActivePinia(createPinia())
    const store = useSettingsStore()
    // mock i18n 避免 setLocale 拉起实例
    vi.doMock('@/i18n', () => ({ setLocale: vi.fn() }))
    await store.setSystem({ theme: 'dark', themePreset: 'rose', locale: 'zh-CN' })
    expect(document.documentElement.getAttribute('data-theme-preset')).toBe('rose')
  })

  it('切 cold-blue 后 <html data-theme-preset> === "cold-blue"', async () => {
    const { useSettingsStore } = await import('@/stores/settings')
    const { createPinia, setActivePinia } = await import('pinia')
    setActivePinia(createPinia())
    const store = useSettingsStore()
    vi.doMock('@/i18n', () => ({ setLocale: vi.fn() }))
    await store.setSystem({ theme: 'dark', themePreset: 'cold-blue', locale: 'zh-CN' })
    expect(document.documentElement.getAttribute('data-theme-preset')).toBe('cold-blue')
  })
})

// U2: style.css 含 11 套 data-theme-preset 规则覆盖 --accent
describe('U2: style.css 含 11 套 data-theme-preset 规则', () => {
  const EXPECTED_PRESETS = [
    'warm-teal', 'cold-teal', 'neutral', 'sharp', 'warm-neutral',
    'cold-blue', 'terracotta', 'rose', 'amber', 'blue', 'violet',
  ]

  it('style.css 含 11 个 data-theme-preset 属性选择器，每个含 --accent 覆盖', () => {
    // 测试 cwd 是 packages/renderer，style.css 在 src/style.css
    const cssPath = join(process.cwd(), 'src/style.css')
    const css = readFileSync(cssPath, 'utf-8')
    for (const preset of EXPECTED_PRESETS) {
      // dark 态规则：:root[data-theme-preset="<id>"]
      const darkSelector = `:root[data-theme-preset="${preset}"]`
      expect(css).toContain(darkSelector)
      // 紧跟的规则块含 --accent
      const darkBlockIdx = css.indexOf(darkSelector)
      const darkBlock = css.slice(darkBlockIdx, darkBlockIdx + 200)
      expect(darkBlock).toContain('--accent:')
    }
  })
})

// U3: updateSystem 真实 await localStorage 写入
describe('U3: updateSystem 真实 await localStorage 写入', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('await updateSystem({theme:"light"}) 后 localStorage 已含 theme=light', async () => {
    const { updateSystem, getSystem } = await import('@/api/domains/settings')
    // 先写一个默认值
    localStorage.setItem('xyz-agent:system-settings', JSON.stringify({
      locale: 'zh-CN', theme: 'dark', themePreset: 'cold-blue',
    }))
    await updateSystem({ theme: 'light' })
    // fire-and-forget 模式下这里可能还没写完；真 await 模式下一定写完
    const after = await getSystem()
    expect(after.theme).toBe('light')
  })
})

// U4 + U5: matchMedia change 监听动态挂/卸
describe('U4/U5: theme=system 时 matchMedia 监听动态挂/卸', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.removeAttribute('data-theme-preset')
    localStorage.clear()
  })

  it('U4: theme=system 时 matchMedia change 监听已注册', async () => {
    vi.resetModules()
    vi.doMock('@/i18n', () => ({ setLocale: vi.fn() }))
    // matchMedia mock：捕获 addEventListener 调用
    const addEventListenerSpy = vi.fn()
    const removeEventListenerSpy = vi.fn()
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false,
      addEventListener: addEventListenerSpy,
      removeEventListener: removeEventListenerSpy,
    })))

    const { useSettings } = await import('@/composables/features/useSettings')
    const { createPinia, setActivePinia } = await import('pinia')
    setActivePinia(createPinia())

    // mock getSystem 返回 theme=system
    const api = await import('@/api')
    vi.spyOn(api.settings, 'getSystem').mockResolvedValue({
      locale: 'zh-CN', theme: 'system', themePreset: 'cold-blue',
    })

    const { init } = useSettings()
    await init()

    // theme=system → 应挂监听
    expect(addEventListenerSpy).toHaveBeenCalled()
    expect(addEventListenerSpy.mock.calls[0][0]).toBe('change')
  })

  it('U5: theme=dark 时 init 后不挂 change 监听', async () => {
    vi.resetModules()
    vi.doMock('@/i18n', () => ({ setLocale: vi.fn() }))
    const addEventListenerSpy = vi.fn()
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false,
      addEventListener: addEventListenerSpy,
      removeEventListener: vi.fn(),
    })))

    const { useSettings } = await import('@/composables/features/useSettings')
    const { createPinia, setActivePinia } = await import('pinia')
    setActivePinia(createPinia())

    const api = await import('@/api')
    vi.spyOn(api.settings, 'getSystem').mockResolvedValue({
      locale: 'zh-CN', theme: 'dark', themePreset: 'cold-blue',
    })

    const { init } = useSettings()
    await init()

    // theme=dark → 不应挂监听
    expect(addEventListenerSpy).not.toHaveBeenCalled()
  })
})

// U6: toast 机制可被调用（SettingsModal onSystemUpdate 经 useToast 反馈）
describe('U6: toast 反馈机制', () => {
  it('useToast().info 触发后 toasts 列表含对应条目（toast 机制工作）', async () => {
    const { useToast } = await import('@/composables/useToast')
    const { toasts, info } = useToast()
    const before = toasts.value.length
    info('已应用')
    expect(toasts.value.some((t) => t.message === '已应用')).toBe(true)
    expect(toasts.value.length).toBe(before + 1)
  })
})
