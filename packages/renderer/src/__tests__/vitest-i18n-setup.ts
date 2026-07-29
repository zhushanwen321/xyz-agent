/**
 * Vitest 全局 setup —— mock vue-i18n 的 useI18n，让组件测试中
 * `const { t } = useI18n()` 正常工作（测试环境无 app.use(i18n)）。
 *
 * t() 从 zh-CN locale 递归取值，这样现有测试断言中文文案无需改。
 * createI18n / i18n 实例保留原样，不影响 settings-i18n.test.ts。
 */
import { vi } from 'vitest'
import zhCN from '@/i18n/locales/zh-CN'

function resolveFromLocale(key: string): string {
  const parts = key.split('.')
  let obj: unknown = zhCN
  for (const p of parts) {
    if (obj == null || typeof obj !== 'object') return key
    obj = (obj as Record<string, unknown>)[p]
  }
  return typeof obj === 'string' ? obj : key
}

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return {
    ...actual,
    useI18n: () => ({
      // vue-i18n v10 t 复数/命名参数签名（vue-i18n.d.ts:1189/1334）：
      //   t(key, plural, options: TranslateOptions)  ← options.named 是命名参数
      //   t(key, named: NamedValue)
      //   t(key, named, plural)
      // mock 兼容：含 | 的 message 按 count 选段（1→首段，否则次段）；
      // 命名参数从 options.named 或直接 named 取，{key} 全局替换。
      t: (key: string, ...rest: unknown[]) => {
        let result: unknown = resolveFromLocale(key)
        let named: Record<string, unknown> | undefined
        let count: number | undefined
        // 形式1：t(key, plural, options) — options.named 存命名参数
        if (typeof rest[0] === 'number') {
          count = rest[0]
          const opts = rest[1] as { named?: Record<string, unknown> } | undefined
          named = opts?.named
        } else if (rest[0] && typeof rest[0] === 'object') {
          const first = rest[0] as Record<string, unknown>
          // 形式2：t(key, named) — first 直接是命名参数对象
          if ('named' in first && first.named && typeof first.named === 'object') {
            named = first.named as Record<string, unknown>
          } else {
            named = first
          }
        }
        // vue-i18n 复数：含 | 的 message 按 count 选段（count===1 首段，否则次段）
        if (typeof result === 'string' && result.includes('|') && count !== undefined) {
          const parts = result.split('|')
          result = (count === 1 ? parts[0] : (parts[1] ?? parts[0])).trim()
        }
        // 命名参数 {key} 全局替换
        if (named && typeof result === 'string') {
          for (const [k, v] of Object.entries(named)) {
            result = result.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
          }
        }
        return result
      },
      locale: { value: 'zh-CN' },
    }),
  }
})
