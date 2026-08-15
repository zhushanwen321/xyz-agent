import { createI18n } from 'vue-i18n'
import type { WritableComputedRef } from 'vue'
import zhCN from './locales/zh-CN'

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

const initialLocale = readInitialLocale()

/**
 * Q1-2 惰性 locale 加载：初始只静态注册 zh-CN（默认 locale，语言包不进异步 chunk），
 * en-US 按需动态 import + setLocaleMessage（不进首屏 chunk——zh-CN 用户不再为用不到的
 * en-US 全量（settings 等 13 域）付出启动编译成本；反之亦然）。
 */
// 仅注册 zh-CN 时 vue-i18n 会把 composer 的 locale ref 窄化为 '"zh-CN"'，
// setLocale('en-US') 赋值处类型报错——在赋值点经 WritableComputedRef<Locale> 定向拓宽
// （运行时安全：composer 接受任何已 setLocaleMessage 注册过的 locale）。
const i18n = createI18n({
  legacy: false,
  locale: initialLocale,
  fallbackLocale: 'en-US',
  messages: {
    'zh-CN': zhCN,
  },
})

/** 已注册 messages 的 locale（幂等守卫：避免重复动态 import / setLocaleMessage） */
const loadedLocales = new Set<Locale>(['zh-CN'])

/** 动态加载 locale 语言包并注册。字面量 import 路径保证 bundler 静态可分析（拆独立 chunk）。 */
async function loadLocaleMessages(locale: Locale): Promise<void> {
  if (loadedLocales.has(locale)) return
  const mod =
    locale === 'en-US'
      ? await import('./locales/en-US')
      : await import('./locales/zh-CN')
  i18n.global.setLocaleMessage(locale, mod.default)
  loadedLocales.add(locale)
}

// en-US 偏好用户冷启动：top-level await 在模块解析内补齐 en-US 再放行 main.ts——
// 否则 connecting 屏第一帧（AppShell 渲染前）locale=en-US 但 messages 未注册，
// 会看到裸 key / 回退中文的闪烁。zh-CN 用户（默认）不执行此分支：模块同步解析、
// en-US 不进首屏 chunk（切换时再动态拉取）。
if (initialLocale === 'en-US') {
  await loadLocaleMessages('en-US')
}

/** setLocale 请求序号：连续快速切换时后写胜，防止先发的动态加载完成晚到后回写过期 locale */
let setLocaleSeq = 0

/**
 * 切换运行时语言。首次切换到未加载的 locale 时先动态 import 其语言包（拆 chunk，
 * 一次网络/磁盘往返）再切换；已加载的 locale（含初始 zh-CN）同步命中缓存，仅一个 microtask。
 * 持久化由 settings store 统一负责（system 偏好 key），此处不写 locale，避免双真相源。
 */
export async function setLocale(locale: Locale): Promise<void> {
  const seq = ++setLocaleSeq
  await loadLocaleMessages(locale)
  if (seq !== setLocaleSeq) return // 已有更新的切换请求，本请求过期
  ;(i18n.global.locale as WritableComputedRef<Locale>).value = locale
}

export function getLocale(): Locale {
  return i18n.global.locale.value as Locale
}

export default i18n
