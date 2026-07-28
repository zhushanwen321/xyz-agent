import { createI18n } from 'vue-i18n'
import zhCN from './locales/zh-CN'
import enUS from './locales/en-US'

export type Locale = 'zh-CN' | 'en-US'

/**
 * 初始 locale：统一从 system 偏好 key 读（单一真相源，与 settings store 一致）。
 * 兼容旧 key xyz-agent-locale（历史数据），但新写入只走 system。
 * i18n 模块先于 AppShell 初始化，故此处同步读；store.init 后会再次 setLocale 对齐。
 */
const SYSTEM_KEY = 'xyz-agent:system-settings'
const LEGACY_LOCALE_KEY = 'xyz-agent-locale'

function readInitialLocale(): Locale {
  try {
    const raw = localStorage.getItem(SYSTEM_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as { locale?: unknown }
      if (parsed.locale === 'zh-CN' || parsed.locale === 'en-US') return parsed.locale
    }
  // eslint-disable-next-line taste/no-silent-catch -- 启动期 localStorage 损坏属非致命：i18n 有 fallbackLocale，回退默认值即可
  } catch (e) {
    console.warn('[i18n] system settings 解析失败，回退默认 locale', e)
  }
  const legacy = localStorage.getItem(LEGACY_LOCALE_KEY)
  return legacy === 'en-US' ? 'en-US' : 'zh-CN'
}

const i18n = createI18n({
  legacy: false,
  locale: readInitialLocale(),
  fallbackLocale: 'en-US',
  messages: {
    'zh-CN': zhCN,
    'en-US': enUS,
  },
})

/**
 * 切换运行时语言。仅切换 i18n 实例；持久化由 settings store 统一负责
 * （system 偏好 key），此处不再单独写 locale，避免双真相源。
 */
export function setLocale(locale: Locale): void {
  i18n.global.locale.value = locale
}

export function getLocale(): Locale {
  return i18n.global.locale.value as Locale
}

export default i18n
