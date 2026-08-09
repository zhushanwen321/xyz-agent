/**
 * Provider catalog 判据工具。
 *
 * 基于 builtin-providers.json 副本（编译期 import）判断 providerId
 * 是否属于 pi 内置 catalog。副本只作判据 + UI 展示，非运行时定义权威。
 */
import builtinData from '../generated/builtin-providers.json'

/**
 * 判断 providerId 是否为 pi 内置 catalog provider。
 * fail-safe：builtinData 格式异常时返回 false + console.warn，不抛错。
 */
export function isCatalogProvider(providerId: string): boolean {
  const providers = builtinData?.providers
  if (!Array.isArray(providers)) {
    console.warn('[provider-catalog] builtin-providers.json malformed (providers is not an array)')
    return false
  }
  return providers.some((p: { id: string }) => p.id === providerId)
}
