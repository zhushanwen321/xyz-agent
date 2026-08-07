/**
 * Vitest 全局 setup —— mock vue-i18n 的 useI18n，让组件测试中
 * `const { t } = useI18n()` 正常工作（测试环境无 app.use(i18n)）。
 * 复用 renderer 的 vitest-i18n-setup.ts 模式（s1 C8 决策）。
 * t() 从 zh-CN locale 递归取值，断言中文文案无需改。
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
      t: (key: string, args?: Record<string, unknown>) => {
        let result = resolveFromLocale(key)
        if (args) {
          for (const [k, v] of Object.entries(args)) {
            result = result.replace(`{${k}}`, String(v))
          }
        }
        return result
      },
      locale: { value: 'zh-CN' },
    }),
  }
})
