/**
 * Provider 有效性校验 helper（从 pi-provider-store.ts 抽出，控 max-lines 500）。
 *
 * 职责：判定 provider 是否无效（pi 0.80.3 严格校验会拒绝五字段全缺的空壳 provider，
 * 导致整个 models.json 加载失败）。isInvalidProvider 是纯函数，供 sanitizeInvalidProviders
 * 启动时剔除空壳 provider 用。
 *
 * 抽出原因：pi-provider-store.ts 超 ESLint max-lines(500)。本模块只含纯校验函数
 *（不碰 modelsStore 模块级缓存）；sanitizeInvalidProviders 依赖 modelsStore.invalidate +
 * writeModels + builtinModelsById，仍留 pi-provider-store（架构约定：modelsStore 读写类
 * 函数留 store）。pi-provider-store 经 barrel re-export 保 import 路径不变，行为零变化。
 */
import type { PiProviderConfig } from './pi-provider-store.js'

/**
 * 判定 provider 是否无效（pi 会拒绝加载）。
 *
 * pi 0.80.3 报错原文：provider must specify "baseUrl", "headers", "compat",
 * "modelOverrides", or "models"。五字段全缺则 pi 拒绝该 provider；0.80.3 更严格——
 * 一个无效 provider 会导致整个 models.json 加载失败。本函数对齐 pi 判定标准，
 * 供 sanitizeInvalidProviders 启动时剔除空壳 provider（如外部脚本写入的测试 fixture）。
 *
 * compat 是 pi 端 provider 级字段（xyz-agent PiProviderConfig 未声明，但运行时脏数据
 * 可能含），用宽松键检查（as Record<string,unknown>）不遗漏。
 *
 * 判定与 pi 0.80.3 实测语义对齐（model-registry.ts applyModelsJson + zod schema）：
 * - baseUrl/headers/compat 用 falsiness：zod `Type.String({ minLength: 1 })` 拒绝空字符串
 *   （实测 `--list-models` 报 must not have fewer than 1 characters），空串视同未 specify
 * - modelOverrides 要求 `Object.keys(...).length > 0`（applyModelsJson hasOverrides），
 *   空对象不视为 specify（实测报 must specify ... "modelOverrides" ...）
 * - models 空数组（[]）视为未 specify（无法提供任何模型，与 undefined 等效）
 * - 非对象值（null/string/number）：zod ProviderConfigSchema 直接拒绝 → 无效
 */
export function isInvalidProvider(provider: PiProviderConfig): boolean {
  if (typeof provider !== 'object' || provider === null) return true
  const raw = provider as Record<string, unknown>
  const hasModels = Array.isArray(raw.models) && raw.models.length > 0
  const hasOverrides =
    typeof raw.modelOverrides === 'object' &&
    raw.modelOverrides !== null &&
    Object.keys(raw.modelOverrides as object).length > 0
  return !raw.baseUrl && !raw.headers && !raw.compat && !hasOverrides && !hasModels
}
