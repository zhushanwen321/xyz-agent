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

/**
 * 按 enabledModels 白名单派生 provider 启用状态（DM3 / wave2）。
 *
 * pi 语义：enabledModels 为空/undefined → 全可用（不限制）；非空 → 白名单匹配。
 * 匹配规则：pattern 等于 `<id>/*`（provider 通配）或以 `<id>/` 开头（model 级 pattern
 * 视为该 provider 已启用）。`startsWith('<id>/')` 带斜杠，避免 `openai` vs
 * `openai-compatible` 的前缀碰撞（openai/ 匹配 openai 但不匹配 openai-compatible/）。
 *
 * wave2 listProviders（config-service）+ findValidDefaultModel（pi-provider-store）、
 * wave3 toggleProviderEnabled、wave5 迁移共用此判据，故放本共享模块（CL2）。
 */
export function deriveEnabled(providerId: string, enabledModels: string[] | undefined): boolean {
  if (enabledModels == null || enabledModels.length === 0) return true
  return enabledModels.some(p => p === `${providerId}/*` || p.startsWith(`${providerId}/`))
}
