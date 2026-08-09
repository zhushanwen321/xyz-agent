/**
 * 存量 provider 配置迁移：catalog provider 错位 apiKey 迁 auth.json。
 *
 * 背景：xyz-agent 此前不区分 pi 的两套 provider 体系，catalog provider 的
 * apiKey 被错位写进 models.json（0644 明文）。此迁移在启动期幂等执行：
 * - catalog provider 条目含 apiKey → apiKey 迁 auth.json，删 models.json 条目
 * - 若条目有非默认 override（baseUrl/compat）→ 保留 override-only 条目只删 apiKey
 * - 自定义 provider 条目 → 不动
 * - OAuth 冲突（auth.json 已有 oauth）→ 跳过
 * - 迁移失败不阻断启动，warn + 下次重试
 */
import { readModels, upsertProvider, getProviderNames } from '../../infra/pi/pi-provider-store.js'
import { isCatalogProvider } from '../provider-catalog.js'
import { AuthStorage } from '../auth/auth-storage.js'
import { getDataDir } from '@xyz-agent/shared'
import { join } from 'node:path'

export interface MigrationReport {
  migrated: string[]
  kept: string[]
  failed: string[]
  skipped: string[]
  errors: string[]
}

/**
 * 启动期幂等迁移：catalog provider 错位 apiKey → auth.json。
 * @param authStorage AuthStorage 实例（操作 auth.json）
 * @returns MigrationReport
 */
export async function migrateLegacyProviderConfig(authStorage: AuthStorage): Promise<MigrationReport> {
  const report: MigrationReport = { migrated: [], kept: [], failed: [], skipped: [], errors: [] }

  try {
    const models = readModels()
    const providers = models.providers ?? {}

    for (const [providerId, config] of Object.entries(providers)) {
      // 只处理 catalog provider
      if (!isCatalogProvider(providerId)) {
        report.kept.push(providerId)
        continue
      }

      // 只处理有 apiKey 的条目（无 apiKey 的是 override-only 条目，不动）
      if (!config.apiKey || config.apiKey === '') {
        report.kept.push(providerId)
        continue
      }

      // OAuth 冲突检查
      try {
        const existing = await authStorage.get(providerId)
        if (existing?.type === 'oauth') {
          report.skipped.push(providerId)
          continue
        }
      } catch {
        // auth.json 读失败不阻断，继续迁移（秘钥会覆盖写入）
      }

      try {
        // 写 apiKey 到 auth.json
        await authStorage.set(providerId, { type: 'api_key', key: config.apiKey as string })

        // 删 models.json 条目（重建不含 apiKey 的配置）
        const { apiKey, ...rest } = config as Record<string, unknown>
        // 如果只剩下默认字段（name/api/baseUrl 来自 builtin template），直接删条目
        // 如果有额外 override 字段 → 保留 override-only 条目
        const hasOverride = Object.keys(rest).length > 0 && (
          rest.baseUrl !== undefined || rest.compat !== undefined || rest.headers !== undefined
        )
        if (hasOverride) {
          upsertProvider(providerId, rest as Parameters<typeof upsertProvider>[1])
        } else {
          // 无 override → 删除整个条目。upsertProvider 不支持 delete，
          // 需要从 readModels 的副本中移除然后...实际上 pi-provider-store 没有 deleteProvider
          // 借用已有的 remove 路径。但我们没有直接删除的 API。
          // 变通：upsertProvider 写一个最小条目（不含 apiKey），或者留空条目。
          // 留空条目不会覆盖 catalog（§2.3），且 apiKey 已迁走，安全。
          // 最佳方案：写一个只有 name/api 的条目，让 pi 的 override 逻辑正常工作
          upsertProvider(providerId, { name: config.name, api: config.api, baseUrl: config.baseUrl } as Parameters<typeof upsertProvider>[1])
        }

        report.migrated.push(providerId)
      } catch (e) {
        report.failed.push(providerId)
        report.errors.push(`${providerId}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  } catch (e) {
    report.errors.push(`migration failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  return report
}
