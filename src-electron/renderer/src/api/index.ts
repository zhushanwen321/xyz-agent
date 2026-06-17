/**
 * API 门面层 —— 对外统一入口（`import { api } from '@/api'`）。
 *
 * 本文件只做 re-export：工厂在 ./factory，全局单例在 ./singleton。
 * 这样拆分是为了打断曾经的 index ↔ singleton 循环依赖（见 factory.ts 注释）。
 */
export type { ApiClient } from './factory'
export { createApiClient } from './factory'

// 全局单例 re-export：composable / store / 组件统一 `import { api } from '@/api'`。
export { api } from './singleton'
export { getState } from './singleton'
