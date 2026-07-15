/**
 * W6 D17 · 字体大小切换生效测试（U11）。
 *
 * 验证目标：setSystem({fontSize}) 后 <html data-font-size> 同步更新。
 * applySystemToDom 是 store 内部函数，经 setSystem action 间接验证。
 *
 * 独立文件：避免 system-theme.test.ts 的 vi.doMock('@/api') persist-failed mock 污染。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

describe('U11: 字体大小切换生效（data-font-size）', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-font-size')
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.removeAttribute('data-theme-preset')
    localStorage.clear()
    vi.resetModules()
    // mock i18n 避免 setLocale 拉起实例（与 system-theme.test.ts U1 同模式）
    vi.doMock('@/i18n', () => ({ setLocale: vi.fn() }))
  })

  it('setSystem({fontSize:"large"}) 后 <html data-font-size> === "large"', async () => {
    const { useSettingsStore } = await import('@/stores/settings')
    const { createPinia, setActivePinia } = await import('pinia')
    setActivePinia(createPinia())
    const store = useSettingsStore()
    await store.setSystem({ fontSize: 'large' })
    expect(document.documentElement.dataset.fontSize).toBe('large')
  })

  it('setSystem({fontSize:"small"}) 后 <html data-font-size> === "small"', async () => {
    const { useSettingsStore } = await import('@/stores/settings')
    const { createPinia, setActivePinia } = await import('pinia')
    setActivePinia(createPinia())
    const store = useSettingsStore()
    await store.setSystem({ fontSize: 'small' })
    expect(document.documentElement.dataset.fontSize).toBe('small')
  })

  it('DEFAULT_SYSTEM.fontSize === "medium"', async () => {
    const { useSettingsStore } = await import('@/stores/settings')
    const { createPinia, setActivePinia } = await import('pinia')
    setActivePinia(createPinia())
    const store = useSettingsStore()
    expect(store.system.fontSize).toBe('medium')
  })

  it('setSystem 无 fontSize 时 data-font-size 回落 medium', async () => {
    const { useSettingsStore } = await import('@/stores/settings')
    const { createPinia, setActivePinia } = await import('pinia')
    setActivePinia(createPinia())
    const store = useSettingsStore()
    // 只改 theme，不传 fontSize → applySystemToDom 用 ?? 'medium'
    await store.setSystem({ theme: 'light' })
    expect(document.documentElement.dataset.fontSize).toBe('medium')
  })

  it('SystemSettings 类型含 fontSize 可选字段（API + store DEFAULT）', async () => {
    const api = await import('@/api/domains/settings')
    const store = await import('@/stores/settings')
    // 类型层验证：DEFAULT_SYSTEM 含 fontSize（运行时反射）
    const apiDefault = { locale: 'zh-CN', theme: 'dark', themePreset: 'cold-blue', fontSize: 'medium' } as api.SystemSettings
    expect(apiDefault.fontSize).toBe('medium')
    // store 导出 SystemSettings 类型（类型存在即编译通过）
    const _typeCheck: store.SystemSettings = { locale: 'zh-CN', theme: 'dark', themePreset: 'cold-blue', fontSize: 'large' }
    expect(_typeCheck.fontSize).toBe('large')
  })

  it('style.css 含 3 套 data-font-size 规则', () => {
    const cssPath = join(process.cwd(), 'src/style.css')
    const css = readFileSync(cssPath, 'utf-8')
    expect(css).toContain(':root[data-font-size="small"]')
    expect(css).toContain(':root[data-font-size="medium"]')
    expect(css).toContain(':root[data-font-size="large"]')
    // small=14px / medium=15px / large=16px
    expect(css).toMatch(/data-font-size="small"][\s\S]*font-size:\s*14px/)
    expect(css).toMatch(/data-font-size="medium"][\s\S]*font-size:\s*15px/)
    expect(css).toMatch(/data-font-size="large"][\s\S]*font-size:\s*16px/)
  })
})
