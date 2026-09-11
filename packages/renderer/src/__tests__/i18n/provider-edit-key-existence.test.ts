/**
 * U-3 一致性审查补丁：providerEdit 命名空间的 i18n key 存在性机器闸门。
 *
 * 防的回归：UI 组件把 t('settings.providerEdit.x') 重命名/新增之后，若 locale 只改一侧、
 * 忘了翻译、或直接在删除批次里删掉仍被引用的 key，en-US（或 zh-CN）用户会看到裸 key
 * （渲染出 settings.providerEdit.x 字符串），而现有测试仍可能全绿：
 * - locale-sync-check 只比对双侧 key 集合一致，双侧同时缺同一个 key 抓不到；
 * - quota-reason-i18n 只覆盖其显式数组里的 key，数组外的新 key 不在保护范围。
 * 本守卫补齐「UI 引用了 → locale 必须有」这条通路。
 *
 * 机制：扫 packages/ui/src 与 packages/renderer/src（排除 locale 文件与测试自身）
 * 中所有 `providerEdit.<key>` 字面引用——要求 key 后紧跟引号/反引号收尾，因此动态拼接
 * `providerEdit.${x}` 这类模板片段不会被误收（也不会因为收到 `foo.${x}` 里的 `foo` 而假红）。
 * 对每个 key 断言其在 zh-CN / en-US 的 settings locale 中都存在且为非空字符串。
 *
 * NEW_UI_KEYS_REQUIRED 是本改动（coding-plan-quota-config-ux §7.4 / §7.5）新增的 24 个
 * providerEdit key 的显式清单：即使源码扫描通路整体失效（根路径写错、文件被移走），
 * 也会因这些 key 缺席而先红，杜绝「空集合恒绿」的假守卫。
 *
 * 测试框架：vitest。运行：cd packages/renderer && npx vitest run src/__tests__/i18n/provider-edit-key-existence.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve, relative, sep } from 'node:path'
import zhSettings from '../../i18n/locales/zh-CN/settings'
import enSettings from '../../i18n/locales/en-US/settings'

const REPO_ROOT = resolve(__dirname, '../../../../..')
/** providerEdit key 的源码消费根；locale 与测试自身不算消费方 */
const SCAN_ROOTS = [join(REPO_ROOT, 'packages/ui/src'), join(REPO_ROOT, 'packages/renderer/src')]
const SKIP_DIRS = new Set(['node_modules', '__tests__', 'dist'])
const SOURCE_EXT = /\.(vue|ts|js|mjs)$/
/** `providerEdit.<key>` 且 key 后紧跟引号/反引号收尾（动态拼接不匹配） */
const KEY_REF = /providerEdit\.([A-Za-z0-9_]+)(?=["'`])/g

/** 本改动新增的 providerEdit key（locale 基线 62a9651e5 → HEAD 的 providerEdit 新增键全量） */
const NEW_UI_KEYS_REQUIRED = [
  'quotaTypeFirstHint',
  'quotaEnableHintIdle',
  'quotaProviderCredentialMissing',
  'quotaProviderCredentialPendingSave',
  'quotaExclusiveKeyPlaceholder',
  'quotaCredentialSourceLabel',
  'quotaSourceProvider',
  'quotaSourceExclusive',
  'quotaSourceProviderOauthHint',
  'quotaSourceProviderApiKeyHint',
  'quotaSourceExclusiveHint',
  'quotaConfigureFail',
  'quotaSaveAndTest',
  'quotaSaveAndTestRunning',
  'quotaReadyHint',
  'quotaMissingCookie',
  'quotaMissingApiKey',
  'quotaMissingWorkspace',
  'quotaSaveAndTestFail',
  'quotaFetchFailUnauthorizedCookie',
  'quotaFetchFailNoCredential',
  'quotaFetchFailNoCredentialCookie',
  'quotaRequiredBadge',
  'quotaConfiguredBadge',
] as const

type FlatLocale = Record<string, string | undefined>

const ZH_PROVIDER_EDIT = (zhSettings as unknown as { providerEdit: FlatLocale }).providerEdit
const EN_PROVIDER_EDIT = (enSettings as unknown as { providerEdit: FlatLocale }).providerEdit

/** 扫源码收集 `providerEdit.<key>` 引用；同 key 只记首个出现文件（用于报错定位） */
function collectSourceRefs(): Map<string, string> {
  const refs = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full)
        continue
      }
      if (!SOURCE_EXT.test(entry.name)) continue
      if (full.includes(`${sep}i18n${sep}locales${sep}`)) continue
      for (const m of readFileSync(full, 'utf-8').matchAll(KEY_REF)) {
        if (!refs.has(m[1])) refs.set(m[1], full)
      }
    }
  }
  for (const root of SCAN_ROOTS) walk(root)
  return refs
}

describe('providerEdit i18n key 存在性机器闸门（U-3）', () => {
  const refs = collectSourceRefs()

  it('源码扫描通路有效（扫到的 key 数量足以证明根路径与正则生效）', () => {
    expect(
      refs.size,
      '未从 packages/ui/src + packages/renderer/src 扫到足量 providerEdit key，扫描根/正则可能失效',
    ).toBeGreaterThan(100)
  })

  for (const locale of ['zh-CN', 'en-US'] as const) {
    it(`${locale}: 本改动新增的 ${NEW_UI_KEYS_REQUIRED.length} 个 providerEdit key 都存在且非空`, () => {
      const providerEdit = locale === 'zh-CN' ? ZH_PROVIDER_EDIT : EN_PROVIDER_EDIT
      const missing = NEW_UI_KEYS_REQUIRED.filter((key) => {
        const value = providerEdit[key]
        return typeof value !== 'string' || value.trim().length === 0
      })
      expect(missing, `${locale} 缺失/空值的新增 key: ${missing.join(', ')}`).toEqual([])
    })
  }

  for (const locale of ['zh-CN', 'en-US'] as const) {
    it(`${locale}: 每个被 UI/renderer 源码引用的 providerEdit key 都存在且非空`, () => {
      const providerEdit = locale === 'zh-CN' ? ZH_PROVIDER_EDIT : EN_PROVIDER_EDIT
      const problems: string[] = []
      for (const [key, file] of refs) {
        const value = providerEdit[key]
        if (typeof value !== 'string' || value.trim().length === 0) {
          problems.push(`${key}（引用自 ${relative(REPO_ROOT, file)}）`)
        }
      }
      expect(problems, `${locale} 缺失/空值 key:\n${problems.join('\n')}`).toEqual([])
    })
  }
})
