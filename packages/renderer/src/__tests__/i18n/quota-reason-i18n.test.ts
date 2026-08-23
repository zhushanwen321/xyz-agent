/**
 * A2-4 i18n 断言：quota 失败态恢复指引文案在 zh-CN / en-US 双侧存在且非空。
 *
 * reason 透传（QuotaFetchResult.reason）已到 RPC 响应，失败态渲染归 Phase B——
 * 本测试守卫 Phase B 依赖的 i18n key 不被误删/漏译（机械闸门，与 locale-sync-check 互补：
 * sync-check 只比对双侧 key 集合一致，不校验本功能 key 的存在性与非空）。
 *
 * 测试框架：vitest。运行：cd packages/renderer && npx vitest run src/__tests__/i18n/quota-reason-i18n.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

interface LocaleObject {
  [key: string]: string | LocaleObject
}

/** 读 .ts locale 文件为对象（export default {...}，与 locale-sync-check 同模式） */
function loadLocaleObject(filePath: string): LocaleObject {
  const src = readFileSync(filePath, 'utf-8')
  const match = src.match(/export\s+default\s+(\{[\s\S]*\})\s*$/)
  if (!match) throw new Error(`无法解析 locale 文件: ${filePath}`)
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- new Function 仅解析仓库内可信 locale 对象字面量（非动态用户输入），与 locale-sync-check 同模式
  return new Function(`return (${match[1]});`)() as LocaleObject
}

const LOCALES_DIR = resolve(__dirname, '../../i18n/locales')

/** A2-4 新增 key（settings.ts 的 providerEdit 命名空间，quota 失败态恢复指引；全 4 reason 专属文案）。
 *  S5 收尾：quotaFetchFailNoSubscriptionCookie = cookie 类 provider 的 no-subscription 两可文案
 *  （业务码不可区分无订阅 vs Cookie 失效，CodingPlanSection 按 authKinds 分支）。 */
const REQUIRED_QUOTA_FAIL_KEYS = [
  'quotaFetchFailUnauthorized',
  'quotaFetchFailNetwork',
  'quotaFetchFailNoSubscription',
  'quotaFetchFailNoSubscriptionCookie',
  'quotaFetchFailParse',
] as const

/** Phase B 新增 key（settings.ts providerEdit 命名空间：B-1 凭证区 / B-3 额度区泛化） */
const REQUIRED_PHASE_B_KEYS = [
  'credentialOauthLoggedIn',
  'credentialOauthNotLoggedIn',
  'credentialOauthRelogin',
  'credentialOauthLogout',
  'switchToApiKey',
  'switchToOauth',
  'switchToApiKeyConfirmDesc',
  'switchToOauthConfirmDesc',
  'switchConfirmBtn',
  'quotaCredentialOauthReady',
  'quotaCredentialOauthMissing',
  'quotaCredentialOauthMissingHint',
  'quotaApiKeyFallbackOrder',
  'quotaUsedOf',
  'quotaUnitRequests',
  'quotaUnitTokens',
  'quotaUnitCredits',
  'quotaLastSuccessToggle',
  'quotaLastSuccessAt',
] as const

/** Phase B 新增 key（settings.ts providerEdit 命名空间：B-2 混合列表） */
const REQUIRED_PHASE_B_MODEL_KEYS = [
  'builtinModelsLabel',
  'customModelsLabel',
  'catalogModelsMixedHint',
  'modelSourceBuiltin',
  'modelSourceOverride',
] as const

/** settings locale 的 providerEdit 节（quota 文案所在命名空间） */
function loadProviderEdit(locale: string): LocaleObject {
  const settings = loadLocaleObject(join(LOCALES_DIR, locale, 'settings.ts'))
  const providerEdit = (settings as Record<string, LocaleObject>).providerEdit
  if (!providerEdit) throw new Error(`${locale}/settings.ts 缺 providerEdit 命名空间`)
  return providerEdit
}

/** panel.context 的 quota 失败 reason 简短文案（A2-4 BL round1 #3：quotaFailReasonText 映射） */
const REQUIRED_PANEL_QUOTA_FAIL_KEYS = [
  'quotaFailUnauthorized',
  'quotaFailNetwork',
  'quotaFailNoSubscription',
  'quotaFailParse',
] as const

/** panel locale 的 context 节 */
function loadPanelContext(locale: string): LocaleObject {
  const panel = loadLocaleObject(join(LOCALES_DIR, locale, 'panel.ts'))
  const context = (panel as Record<string, LocaleObject>).context
  if (!context) throw new Error(`${locale}/panel.ts 缺 context 命名空间`)
  return context
}

describe('A2-4 quota 失败态 i18n key 双侧存在且非空', () => {
  for (const locale of ['zh-CN', 'en-US'] as const) {
    it(`${locale}: providerEdit 含 ${REQUIRED_QUOTA_FAIL_KEYS.join('/')} 且值非空`, () => {
      const providerEdit = loadProviderEdit(locale)
      for (const key of REQUIRED_QUOTA_FAIL_KEYS) {
        const value = providerEdit[key]
        expect(typeof value, `${locale}.providerEdit.${key} 应为字符串`).toBe('string')
        expect((value as string).trim().length, `${locale}.providerEdit.${key} 值应为非空文案`).toBeGreaterThan(0)
      }
    })
  }

  it('zh-CN unauthorized 文案含恢复指引要点（凭证过期 + 发起对话 + 重试）', () => {
    const text = loadProviderEdit('zh-CN').quotaFetchFailUnauthorized as string
    expect(text).toContain('凭证可能过期')
    expect(text).toContain('对话')
    expect(text).toContain('重试')
  })

  it('en-US network 与 unauthorized 文案可区分（非同值）', () => {
    const providerEdit = loadProviderEdit('en-US')
    expect(providerEdit.quotaFetchFailUnauthorized).not.toBe(providerEdit.quotaFetchFailNetwork)
  })
})

describe('panel.context quota 失败 reason 简短文案双侧存在且非空（A2-4 BL round1 #3 消费侧）', () => {
  for (const locale of ['zh-CN', 'en-US'] as const) {
    it(`${locale}: panel.context 含 ${REQUIRED_PANEL_QUOTA_FAIL_KEYS.join('/')} 且值非空`, () => {
      const context = loadPanelContext(locale)
      for (const key of REQUIRED_PANEL_QUOTA_FAIL_KEYS) {
        const value = context[key]
        expect(typeof value, `${locale}.panel.context.${key} 应为字符串`).toBe('string')
        expect((value as string).trim().length, `${locale}.panel.context.${key} 值应为非空文案`).toBeGreaterThan(0)
      }
    })
  }
})

describe('Phase B 新增 i18n key 双侧存在且非空（B-1 凭证区 / B-2 混合列表 / B-3 额度区）', () => {
  const ALL_KEYS = [...REQUIRED_PHASE_B_KEYS, ...REQUIRED_PHASE_B_MODEL_KEYS] as const
  for (const locale of ['zh-CN', 'en-US'] as const) {
    it(`${locale}: providerEdit 含 Phase B 全部 ${ALL_KEYS.length} 个 key 且值非空`, () => {
      const providerEdit = loadProviderEdit(locale)
      for (const key of ALL_KEYS) {
        const value = providerEdit[key]
        expect(typeof value, `${locale}.providerEdit.${key} 应为字符串`).toBe('string')
        expect((value as string).trim().length, `${locale}.providerEdit.${key} 值应为非空文案`).toBeGreaterThan(0)
      }
    })
  }
})
