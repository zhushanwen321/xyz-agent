/**
 * settings 组件注入 key（W3 · C-W3-2 决议）。
 *
 * ui 包零 renderer import 铁律：ProviderEditModal/SourceImportSection 消费的 renderer 侧
 * useQuotaConfigure / useToast / config(@/api) 经 provide/inject 注入，ui 只持有类型别名 +
 * inject helper（缺失 noop fallback + dev console.warn，保证组件不因注入缺失崩溃）。
 *
 * 注入方向：renderer 壳（ProviderPage/SettingsResourcePage 等）→ provide 真实实现；
 * ui 组件 → inject 取用。与 core 的 TC4 t 注入模式一致（依赖经边界注入，不越界 import）。
 *
 * 类型来源：QuotaPreset / NormalizedQuotaRow / ProviderInfo 来自 @xyz-agent/shared（ui 已依赖）。
 * QuotaConfigureState 结构对齐 renderer UseQuotaConfigureReturn（逐字段），保证壳侧 provide 的
 * 真实 useQuotaConfigure 返回值与本类型兼容，ProviderEditModal 解构不丢字段。
 */
import { inject, ref } from 'vue'
import type { ComputedRef, InjectionKey, Ref } from 'vue'
import type { ProviderInfo, NormalizedQuotaRow, QuotaPreset } from '@xyz-agent/shared'

// ── ① Toast ──

export interface SettingsToast {
  error: (message: string) => void
  info: (message: string) => void
  warning: (message: string) => void
}

const NOOP_TOAST: SettingsToast = {
  error: () => {},
  info: () => {},
  warning: () => {},
}

export const SETTINGS_TOAST_KEY: InjectionKey<SettingsToast> = Symbol('settingsToast')

export function useSettingsToast(): SettingsToast {
  const v = inject(SETTINGS_TOAST_KEY, null)
  if (!v && import.meta.env?.dev) {
    console.warn('[ui/settings] SETTINGS_TOAST_KEY not provided; using noop fallback')
  }
  return v ?? NOOP_TOAST
}

// ── ② Quota Configure 工厂 ──

export type QuotaTestStatus = 'idle' | 'loading' | 'success' | 'error'

/**
 * QuotaConfigure 返回态。结构对齐 renderer useQuotaConfigure 的 UseQuotaConfigureReturn
 * （isCookieAuth/helpUrl/helpText 在源实现为 Ref<boolean>/Ref<string|undefined>，这里保持 Ref）。
 */
export interface QuotaConfigureState {
  fetcherId: Ref<string | undefined>
  fetcherOptions: Array<{ value: string; label: string }>
  enabled: Ref<boolean>
  cookieInput: Ref<string>
  apiKeyInput: Ref<string>
  apiKeyConfigured: Ref<boolean>
  testStatus: Ref<QuotaTestStatus>
  testError: Ref<string>
  quotaData: Ref<NormalizedQuotaRow | null>
  lastFetchAt: Ref<number | null>
  isCookieAuth: Ref<boolean>
  helpUrl: Ref<string | undefined>
  helpText: Ref<string | undefined>
  configuring: Ref<boolean>
  configureError: Ref<string>
  toggleEnabled: () => Promise<void>
  selectFetcher: (id: string) => Promise<void>
  saveCookie: () => Promise<void>
  saveApiKey: () => Promise<void>
  testQuery: () => Promise<void>
  reset: () => void
}

/** 工厂签名：(preset, providerRef) => QuotaConfigureState。与 renderer useQuotaConfigure 同构。 */
export type UseQuotaConfigureFactory = (
  preset: Ref<QuotaPreset | undefined>,
  providerRef: Ref<ProviderInfo | null>,
) => QuotaConfigureState

function noopAsync(): Promise<void> {
  return Promise.resolve()
}

const NOOP_FACTORY: UseQuotaConfigureFactory = () => ({
  fetcherId: ref<string | undefined>(undefined),
  fetcherOptions: [],
  enabled: ref(false),
  cookieInput: ref(''),
  apiKeyInput: ref(''),
  apiKeyConfigured: ref(false),
  testStatus: ref<QuotaTestStatus>('idle'),
  testError: ref(''),
  quotaData: ref<NormalizedQuotaRow | null>(null),
  lastFetchAt: ref<number | null>(null),
  isCookieAuth: ref(false),
  helpUrl: ref<string | undefined>(undefined),
  helpText: ref<string | undefined>(undefined),
  configuring: ref(false),
  configureError: ref(''),
  toggleEnabled: noopAsync,
  selectFetcher: noopAsync,
  saveCookie: noopAsync,
  saveApiKey: noopAsync,
  testQuery: noopAsync,
  reset: () => {},
})

export const USE_QUOTA_CONFIGURE_KEY: InjectionKey<UseQuotaConfigureFactory> = Symbol('useQuotaConfigure')

export function useQuotaConfigureFactory(): UseQuotaConfigureFactory {
  const v = inject(USE_QUOTA_CONFIGURE_KEY, null)
  if (!v && import.meta.env?.dev) {
    console.warn('[ui/settings] USE_QUOTA_CONFIGURE_KEY not provided; using noop fallback')
  }
  return v ?? NOOP_FACTORY
}

// ── ③ Config API（@/api 的 detectSources 等）──

export interface SettingsConfigApi {
  /** 检测 source（provider/agent）目录下可导入的源。对齐 @/api config.detectSources。 */
  detectSources: () => Promise<unknown[]>
}

const NOOP_CONFIG_API: SettingsConfigApi = {
  detectSources: async () => [],
}

export const SETTINGS_CONFIG_API_KEY: InjectionKey<SettingsConfigApi> = Symbol('settingsConfigApi')

export function useSettingsConfigApi(): SettingsConfigApi {
  const v = inject(SETTINGS_CONFIG_API_KEY, null)
  if (!v && import.meta.env?.dev) {
    console.warn('[ui/settings] SETTINGS_CONFIG_API_KEY not provided; using noop fallback')
  }
  return v ?? NOOP_CONFIG_API
}

// ComputedRef 未在本文件直接使用（类型来自 vue 顶层 import），保留 import 供未来扩展。
export type { ComputedRef }
