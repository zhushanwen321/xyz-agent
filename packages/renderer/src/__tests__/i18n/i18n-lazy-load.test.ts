/**
 * W03 Q1-2：i18n 惰性 locale 加载。
 *
 * - 默认（无偏好）启动只注册 zh-CN，en-US 不在初始 messages（动态 import 拆 chunk，不进首屏）
 * - setLocale('en-US') 动态 import + setLocaleMessage 后文案为英文，zh-CN 可切回
 * - en-US 偏好冷启动：模块解析（top-level await）完成即 en-US 可用，无回退闪烁
 * - 连续快速切换后写胜（过期的动态加载完成晚到不回写 locale）
 *
 * 每个用例经 vi.resetModules + 动态 import 取全新模块实例（i18n 是模块级单例，
 * loadedLocales / initialLocale 都在模块状态里，不复位会互相污染）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const SYSTEM_KEY = 'xyz-agent:system-settings'

async function importFreshI18n() {
  vi.resetModules()
  return import('@/i18n')
}

describe('i18n 惰性 locale 加载（Q1-2）', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('默认（无偏好）启动只注册 zh-CN，en-US 未载入', async () => {
    const mod = await importFreshI18n()
    expect(mod.getLocale()).toBe('zh-CN')
    expect(Object.keys(mod.default.global.getLocaleMessage('zh-CN')).length).toBeGreaterThan(0)
    // en-US 未注册（动态 import 拆 chunk，不进首屏）
    expect(mod.default.global.getLocaleMessage('en-US')).toEqual({})
    expect(mod.default.global.t('settings.title')).toBe('设置')
  })

  it("setLocale('en-US') 后文案为英文，且 zh-CN 可切回", async () => {
    const mod = await importFreshI18n()
    await mod.setLocale('en-US')
    expect(mod.getLocale()).toBe('en-US')
    // 动态 import + setLocaleMessage 已注册 en-US messages
    expect(Object.keys(mod.default.global.getLocaleMessage('en-US')).length).toBeGreaterThan(0)
    expect(mod.default.global.t('settings.title')).toBe('Settings')
    // 切回 zh-CN（初始已载入，命中缓存）
    await mod.setLocale('zh-CN')
    expect(mod.getLocale()).toBe('zh-CN')
    expect(mod.default.global.t('settings.title')).toBe('设置')
  })

  it('en-US 偏好冷启动：模块解析完成即 en-US 可用（top-level await，无回退闪烁）', async () => {
    localStorage.setItem(SYSTEM_KEY, JSON.stringify({ locale: 'en-US' }))
    const mod = await importFreshI18n()
    // import resolve 时 en-US 已在模块解析内补齐（否则首帧会是裸 key / 中文回退）
    expect(mod.getLocale()).toBe('en-US')
    expect(Object.keys(mod.default.global.getLocaleMessage('en-US')).length).toBeGreaterThan(0)
    expect(mod.default.global.t('settings.title')).toBe('Settings')
  })

  it('连续快速切换时后写胜：先发的 en-US 动态加载晚到不回写过期 locale', async () => {
    const mod = await importFreshI18n()
    const first = mod.setLocale('en-US') // 触发动态 import（较慢）
    await mod.setLocale('zh-CN') // zh-CN 已载入，立即生效（后写）
    await first // 先发的 en-US 加载完成，seq 已过期 → 不回写
    expect(mod.getLocale()).toBe('zh-CN')
    expect(mod.default.global.t('settings.title')).toBe('设置')
  })
})
